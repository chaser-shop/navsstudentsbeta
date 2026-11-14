"""API Mini App. Доступ лише з Telegram: кожен запит підписаний (initData), див. services/telegram_auth.py.

Адмінські маршрути (/api/products, /api/orders ...) лишаються закритими JWT; тут окремі, обмежені за полями.
"""
import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request

from bot.novaposhta import NovaPoshta, NPError

from ..auth.security import audit
from ..config import settings
from ..database import get_db, load, public
from ..models.schemas import CartSyncIn, PromoCheckIn, ShopOrderIn
from ..services import orders as svc, promo as promo_svc, referral
from ..services.catalog import build_catalog
from ..services.order_messages import deliver_order
from ..services.shop_settings import get_discount_tiers, get_min_order, get_retail_markup
from ..services import subscription
from ..services.telegram_api import notify_operators
from ..services.telegram_auth import InitDataError, validate_init_data

router = APIRouter(prefix="/api/shop", tags=["shop"])
log = logging.getLogger("shop")

CATALOG_TTL = 60          # секунд; зміни в MongoDB з'являються в магазині щонайбільше через хвилину
_cache: dict = {"at": 0.0, "key": None, "data": None}
_lock = threading.Lock()
_np: NovaPoshta | None = None
_FIELDS = {"name": 1, "brand": 1, "category": 1, "product_line": 1, "model": 1, "variant": 1, "volume_ml": 1,
           "nicotine_mg": 1, "pack_size": 1, "status": 1, "images": 1, "hot": 1, "final_price": 1, "retail_markup": 1, "compliance.status": 1}


def invalidate_catalog() -> None:
    """Викликається після змін у dashboard: покупець бачить їх одразу, а не через хвилину."""
    with _lock:
        _cache["at"] = 0.0


def tg_user(request: Request) -> dict:
    raw = request.headers.get("X-Telegram-Init-Data", "")
    if not raw and settings.miniapp_dev_mode:
        return {"id": 0, "first_name": "Dev", "username": "dev"}
    try:
        user = validate_init_data(raw, settings.bot_token, settings.init_data_ttl)["user"]
    except InitDataError as e:
        raise HTTPException(401, str(e))
    allowed = settings.miniapp_allowed_ids
    if allowed and user["id"] not in allowed:
        raise HTTPException(403, "Доступу немає")
    ch = settings.required_channel
    if ch and user["id"] > 0 and user["id"] not in settings.operator_ids and subscription.check(user["id"], ch) is False:
        raise HTTPException(403, {"code": "subscribe_required", "channel": subscription.label(ch),
                                  "link": subscription.channel_link(ch, settings.required_channel_link),
                                  "message": "Підпишіться на наш Telegram-канал, щоб користуватись магазином"})
    return user


def _np_client() -> NovaPoshta:
    global _np
    if _np is None:
        try:
            _np = NovaPoshta(settings.np_api_key)
        except NPError:
            raise HTTPException(503, "Доставка тимчасово недоступна")
    return _np


def _catalog(db) -> dict:
    key = settings.show_blocked
    with _lock:
        if _cache["data"] is not None and _cache["key"] == key and time.time() - _cache["at"] < CATALOG_TTL:
            return _cache["data"]
    docs = [load(d) for d in db.products.find({"status": {"$in": ["in_stock", "expected"]}}, _FIELDS)]
    data = build_catalog(docs, show_blocked=key)
    s = db.settings.find_one({"_id": "general"}) or {}
    custom = s.get("popular_categories") or {}
    for c in data.get("categories", []):
        cfg = custom.get(c["id"], {}) if isinstance(custom, dict) else {}
        if cfg.get("title"): c["title"] = cfg["title"]
        if cfg.get("sub"): c["sub"] = cfg["sub"]
        if cfg.get("image"): c["image"] = f"/img/{str(cfg['image']).replace('\\', '/').rsplit('/', 1)[-1]}"
    data["shop"] = {"min_order": get_min_order(db), "min_order_retail": get_min_order(db, "retail"), "retail_markup": get_retail_markup(db), "discounts": get_discount_tiers(db), "prepay": settings.prepay_amount, "prepay_enabled": settings.prepay_enabled, "name": s.get("shop_name") or "Shop", "slogan": s.get("slogan") or "Девайси та рідини", "contact": s.get("contact") or "", "about": s.get("about") or "", "hours": s.get("hours") or "", "hero_title": s.get("hero_title") or "Девайси, картриджі та рідини", "hero_text": s.get("hero_text") or "Увесь асортимент в одному місці. Доставка Новою поштою."}
    with _lock:
        _cache.update(at=time.time(), key=key, data=data)
    return data


def _touch_user(db, user: dict) -> None:
    """Запам'ятовує вхід у Mini App: реєстрація (якщо не було /start) і час останнього візиту."""
    uid = user.get("id")
    if not isinstance(uid, int) or uid <= 0:
        return
    now = datetime.now(timezone.utc)
    try:
        db.users.update_one({"_id": uid}, {"$set": {"first_name": str(user.get("first_name") or "")[:120],
                            "last_name": str(user.get("last_name") or "")[:120],
                            "username": str(user.get("username") or "")[:120], "last_seen_at": now},
                            "$setOnInsert": {"registered_at": now}}, upsert=True)
    except Exception:
        log.exception("Не вдалося оновити користувача %s", uid)


@router.get("/catalog")
def catalog(db=Depends(get_db), user=Depends(tg_user)):
    _touch_user(db, user)
    return _catalog(db)


@router.put("/cart")
def sync_cart(body: CartSyncIn, db=Depends(get_db), user=Depends(tg_user)):
    """Копія кошика з Mini App для dashboard (покупка все одно перераховується сервером при замовленні)."""
    uid = user["id"]
    if uid <= 0:
        return {"ok": True}
    items = [{"product_id": i.product_id, "qty": i.qty, **({"nicotine_mg": i.nicotine_mg} if i.nicotine_mg else {})}
             for i in body.items]
    if items:
        db.carts.update_one({"_id": uid}, {"$set": {"items": items, "updated_at": datetime.now(timezone.utc)}}, upsert=True)
        db.users.update_one({"_id": uid}, {"$set": {"last_seen_at": datetime.now(timezone.utc)}})
    else:
        db.carts.delete_one({"_id": uid})
    return {"ok": True}


@router.post("/promo/check")
def promo_check(body: PromoCheckIn, db=Depends(get_db), user=Depends(tg_user)):
    """Перевірка промокоду в кошику (без використання): повертає відсоток, знижку остаточно рахує сервер при замовленні."""
    doc = promo_svc.lookup(db, body.code)
    try:
        percent = promo_svc.check(doc, user["id"])
    except promo_svc.PromoError as e:
        raise HTTPException(422, str(e))
    return {"code": doc["_id"], "percent": float(percent)}


@router.get("/referral")
def my_referral(db=Depends(get_db), user=Depends(tg_user)):
    """Екран «Запросити друга»: посилання, скільки друзів запрошено, нагороджено й невикористані персональні коди."""
    if user["id"] <= 0:
        raise HTTPException(403, "Доступно лише в Telegram")
    return referral.stats(db, user["id"])


@router.get("/np/cities")
def np_cities(q: str = "", user=Depends(tg_user)):
    if len(q.strip()) < 2:
        return []
    try:
        return _np_client().search_cities(q[:60])
    except NPError:
        raise HTTPException(502, "Нова пошта не відповідає, спробуйте ще раз")


@router.get("/np/warehouses")
def np_warehouses(city_ref: str, q: str = "", page: int = 1, user=Depends(tg_user)):
    if not city_ref or len(city_ref) > 64 or page < 1 or page > 200:
        raise HTTPException(422, "Некоректний запит")
    try:
        return _np_client().warehouses(city_ref, q[:60], page, 20)
    except NPError:
        raise HTTPException(502, "Нова пошта не відповідає, спробуйте ще раз")


def _order_text(o: dict, u: dict) -> str:
    c = o["customer"]
    d = c.get("delivery") or {}
    lines = "\n".join(f"• {i.get('display_name') or i['name']} × {i['qty']} = {float(i['line_total']):g} грн" for i in o["items"])
    who = f"@{u['username']}" if u.get("username") else f"id {u['id']}"
    profit = o.get("profit")
    otype = svc.ORDER_TYPES.get(o.get("order_type"), "Опт")
    profit_line = (f"\n💰 Ваш чистий прибуток з цього замовлення: {float(profit):g} грн" if profit is not None
                   else "\n💰 Прибуток не пораховано: у деяких товарів немає закупівельної ціни")
    pr = o.get("promo")
    tier = float(o.get("discount") or 0) - (float(pr["amount"]) if pr else 0)          # знижка за сумою окремо від промокоду
    disc = (f"\nЗнижка {float(o.get('discount_percent') or 0):g}%: −{tier:g} грн" if tier > 0 else "")
    if pr:
        disc += f"\nПромокод {pr['code']} (−{float(pr['percent']):g}%): −{float(pr['amount']):g} грн"
    return (f"🆕 Нове замовлення {o['number']} · {otype}\n{c['name']} · {c['phone']} · {who}\n"
            f"{d.get('city', '')} ({d.get('area', '')})\n{d.get('warehouse', '')}\n\n{lines}\n{disc}\nРазом: {float(o['total']):g} грн\n"
            f"💳 Оплата: {(o.get('payment') or {}).get('label', '—')}" + profit_line)


@router.post("/orders", status_code=201)
def create_order(body: ShopOrderIn, bg: BackgroundTasks, db=Depends(get_db), user=Depends(tg_user)):
    uid = user["id"]
    if not body.delivery.city_ref or not body.delivery.warehouse_ref:
        raise HTTPException(422, "Оберіть місто та відділення Нової пошти зі списку")
    since = datetime.now(timezone.utc) - timedelta(hours=1)
    if db.orders.count_documents({"customer.tg_id": uid, "created_at": {"$gte": since}}) >= settings.orders_per_hour:
        raise HTTPException(429, "Забагато замовлень за годину. Спробуйте пізніше.")
    customer = {"name": f"{body.first_name} {body.last_name}", "contact": f"@{user['username']}" if user.get("username") else "",
                "phone": body.phone, "delivery": body.delivery.model_dump(), "tg_id": uid,
                "tg_username": user.get("username") or ""}
    used = None                                     # промокод «береться» атомарно; якщо замовлення не вийде — повертаємо
    if body.promo_code and body.promo_code.strip():
        try:
            used = promo_svc.redeem(db, body.promo_code, uid)
        except promo_svc.PromoError as e:
            raise HTTPException(422, str(e))
    try:
        extra = {"payment": svc.payment_info(body.payment_method, settings.prepay_amount if settings.prepay_enabled else None)}
        if body.payment_method == "cod" and settings.prepay_enabled:          # вибір накладеного платежу = згода на передоплату
            extra["prepay_consent"] = {"accepted": True, "amount": settings.prepay_amount, "at": datetime.now(timezone.utc)}
        o = svc.create_order(db, customer, [i.model_dump() for i in body.items], f"tg:{uid}",
                             min_total=get_min_order(db, body.order_type), extra=extra,
                             order_type=body.order_type, retail_markup=get_retail_markup(db),
                             discount_tiers=get_discount_tiers(db), promo=used)
    except svc.OrderError as e:
        if used:
            promo_svc.release(db, used, uid)
        raise HTTPException(422, str(e))
    except Exception:
        if used:
            promo_svc.release(db, used, uid)
        raise
    db.carts.delete_one({"_id": uid})
    audit(db, f"tg:{uid}", "order.create", {"number": o["number"]})
    bg.add_task(notify_operators, _order_text(o, user))
    bg.add_task(deliver_order, db, o["number"])           # подяка + чек покупцю в чат бота
    return {"number": o["number"], "total": float(o["total"]), "status": o["status"],
            "payment_method": o["payment"]["method"], "prepay": settings.prepay_amount if settings.prepay_enabled else None}


@router.get("/orders")
def my_orders(db=Depends(get_db), user=Depends(tg_user)):
    rows = db.orders.find({"customer.tg_id": user["id"]}).sort("created_at", -1).limit(30)
    out = []
    for o in rows:
        o = load(o)
        out.append({"number": o["number"], "created_at": public(o["created_at"]), "status": o["status"],
                    "status_label": svc.STATUS_LABELS.get(o["status"], o["status"]), "status_reason": o.get("status_reason") or "", "total": float(o["total"]), "discount": float(o.get("discount") or 0),
                    "items": [{"name": i.get("display_name") or i["name"], "qty": i["qty"], "unit_price": float(i["unit_price"]),
                               "line_total": float(i["line_total"])} for i in o["items"]]})
    return out
