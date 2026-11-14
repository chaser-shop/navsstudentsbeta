"""Користувачі бота / Mini App для dashboard: реєстрація, останній візит, активний кошик, замовлення."""
import re
import threading
from datetime import timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth.security import audit, current_admin
from ..database import get_db, load
from ..services import orders as svc, user_sync
from .bot import _view
from .stats import CANCELLED

router = APIRouter(prefix="/api/users", tags=["users"])


def _iso(d):
    return d.replace(tzinfo=timezone.utc).isoformat() if d else None


def _name(u: dict) -> str:
    return " ".join(x for x in (u.get("first_name"), u.get("last_name")) if x) or "Без імені"


def _cart(db, doc: dict | None) -> dict | None:
    """Кошик за поточними цінами каталогу; None, якщо в ньому немає товарів, що є в каталозі."""
    if not (doc or {}).get("items"):
        return None
    items = [{"name": i["name"], "qty": i["qty"], "price": float(i["unit_price"] or 0)} for i in _view(db, doc)["items"]]
    if not items:
        return None
    return {"items": items, "total": sum(i["price"] * i["qty"] for i in items), "updated_at": _iso(doc.get("updated_at"))}


def _search(q: str) -> dict:
    """Фільтр для Mongo (а не після limit, інакше старих користувачів не знайти): кожне слово має збігтися
    з ім'ям, прізвищем або username; запит із самих цифр — ще й точний Telegram ID."""
    needle = q.strip().lower().lstrip("@")
    words = [w for w in (x.lstrip("@") for x in needle.split()) if w]
    if not words:
        return {}
    conds = [{"$or": [{k: {"$regex": re.escape(w), "$options": "i"}} for k in ("first_name", "last_name", "username")]} for w in words]
    f = conds[0] if len(conds) == 1 else {"$and": conds}
    if needle.isascii() and needle.isdigit() and int(needle) < 2 ** 63:      # більші числа MongoDB не зберігає як int
        f = {"$or": [{"_id": int(needle)}, f]}
    return f


@router.get("")
def list_users(q: str = "", limit: int = Query(300, ge=1, le=1000), db=Depends(get_db), _=Depends(current_admin)):
    f = _search(q)
    users = list(db.users.find(f).sort("last_seen_at", -1).limit(limit))
    ids = [u["_id"] for u in users]
    carts = {c["_id"]: c for c in db.carts.find({"_id": {"$in": ids}}) if c.get("items")}
    stats: dict = {}
    for o in db.orders.find({"customer.tg_id": {"$in": ids}}, {"customer.tg_id": 1, "total": 1}):
        o = load(o)
        s = stats.setdefault(o["customer"]["tg_id"], {"n": 0, "sum": 0.0})
        s["n"] += 1; s["sum"] += float(o["total"])
    out = []
    for u in users:
        st = stats.get(u["_id"], {"n": 0, "sum": 0.0})
        out.append({"id": u["_id"], "name": _name(u), "username": u.get("username") or "",
                    "registered_at": _iso(u.get("registered_at")), "last_seen_at": _iso(u.get("last_seen_at")),
                    "orders": st["n"], "orders_sum": st["sum"], "cart": _cart(db, carts.get(u["_id"]))})
    total = db.users.count_documents({})
    return {"users": out, "total": total, "matched": db.users.count_documents(f) if f else total}


@router.get("/sync")
def sync_state(db=Depends(get_db), _=Depends(current_admin)):
    """Стан перевірки «хто заблокував бота»: running / done / error + скільки перевірено й видалено."""
    return user_sync.state(db)


@router.post("/sync", status_code=202)
def sync_start(db=Depends(get_db), admin=Depends(current_admin)):
    """Запускає перевірку всіх користувачів у фоні: заблокованих видаляє зі списку."""
    if user_sync.state(db).get("status") == "running":
        raise HTTPException(409, "Перевірка вже триває")
    audit(db, admin, "users.sync", {})
    threading.Thread(target=user_sync.run, args=(db,), daemon=True, name="user-sync-manual").start()
    return {"ok": True}


# Оголошено після /sync: інакше GET /api/users/sync потрапляв би сюди
@router.get("/{tg_id}")
def user_detail(tg_id: int, db=Depends(get_db), _=Depends(current_admin)):
    """Картка користувача: профіль, реферал, замовлення зі статистикою, кошик, персональні промокоди, чат."""
    u = db.users.find_one({"_id": tg_id})
    if not u:
        raise HTTPException(404, "Користувача не знайдено")
    referrer = None
    if u.get("referred_by") is not None:
        r = db.users.find_one({"_id": u["referred_by"]}, {"first_name": 1, "last_name": 1, "username": 1}) or {}
        referrer = {"id": u["referred_by"], "name": _name(r), "username": r.get("username") or ""}

    orders = [load(o) for o in db.orders.find({"customer.tg_id": tg_id},
                                              {"number": 1, "status": 1, "total": 1, "profit": 1, "created_at": 1, "order_type": 1,
                                               "items.qty": 1, "payment.label": 1}).sort("created_at", -1)]
    ok = [o for o in orders if o.get("status") not in CANCELLED]
    spent = sum((Decimal(str(o.get("total") or 0)) for o in ok), Decimal("0"))
    profits = [Decimal(str(o["profit"])) for o in ok if o.get("profit") is not None]
    dates = [o["created_at"] for o in orders if o.get("created_at")]       # уже від найновішого до найстарішого
    stats = {"orders": len(orders), "active": sum(1 for o in orders if o.get("status") in svc.ACTIVE_STATUSES),
             "done": sum(1 for o in orders if o.get("status") == "done"), "cancelled": len(orders) - len(ok),
             "spent": round(float(spent), 2), "avg": round(float(spent / len(ok)), 2) if ok else None,
             "profit": round(float(sum(profits)), 2) if profits else None,
             "first_order_at": _iso(dates[-1]) if dates else None, "last_order_at": _iso(dates[0]) if dates else None}

    promos = [load(p) for p in db.promo_codes.find({"owner_tg_id": tg_id}).sort("created_at", -1).limit(50)]
    chat = db.chats.find_one({"_id": tg_id}, {"unread": 1, "last_at": 1})
    return {
        "id": tg_id, "name": _name(u), "first_name": u.get("first_name") or "", "last_name": u.get("last_name") or "",
        "username": u.get("username") or "", "registered_at": _iso(u.get("registered_at")), "last_seen_at": _iso(u.get("last_seen_at")),
        "bot_blocked": bool(u.get("bot_blocked")), "referred_by": referrer, "referred_at": _iso(u.get("referred_at")),
        "invited": db.users.count_documents({"referred_by": tg_id}),
        "stats": stats,
        "orders": [{"number": o.get("number"), "status": o.get("status"), "total": round(float(o.get("total") or 0), 2),
                    "created_at": _iso(o.get("created_at")), "order_type": o.get("order_type") or "wholesale",
                    "items_count": sum(int(i.get("qty") or 0) for i in o.get("items") or []),
                    "payment_label": (o.get("payment") or {}).get("label") or ""} for o in orders[:50]],
        "cart": _cart(db, db.carts.find_one({"_id": tg_id})),
        "promo_codes": [{"code": p["_id"], "percent": float(p["percent"]) if p.get("percent") is not None else None,
                         "kind": p.get("kind") or "manual", "active": bool(p.get("active", True)), "uses_left": p.get("uses_left"),
                         "used": int(p.get("used") or 0), "expires_at": _iso(p.get("expires_at"))} for p in promos],
        "chat": {"unread": int(chat.get("unread") or 0), "last_at": _iso(chat.get("last_at"))} if chat else None,
        "statuses": svc.STATUS_LABELS,
    }
