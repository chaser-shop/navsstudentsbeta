from fastapi import APIRouter, Depends, HTTPException

from ..auth.security import audit, current_admin
from ..database import get_db
from ..services.discounts import normalize_tiers
from ..services.shop_settings import get_discount_tiers, get_min_order, get_referral, get_retail_markup

router = APIRouter(prefix="/api/settings", tags=["settings"])
ALLOWED = {"shop_name", "slogan", "contact", "about", "hours", "hero_title", "hero_text", "popular_categories",
           "payment_card", "manager_username", "receipt_title", "min_order_total", "min_order_retail", "retail_markup", "discount_tiers", "referral_reward_percent", "referral_friend_percent"}
NUMERIC = {"min_order_total": "Мінімальна сума (опт)", "min_order_retail": "Мінімальна сума (роздріб)",
           "retail_markup": "Націнка для роздробу"}
PERCENT = {"referral_reward_percent": "Знижка для того, хто запросив", "referral_friend_percent": "Знижка для запрошеного"}


@router.get("")
def read(db=Depends(get_db), _=Depends(current_admin)):
    s = db.settings.find_one({"_id": "general"}) or {}
    out = {k: s.get(k, {} if k == "popular_categories" else "") for k in ALLOWED}
    out["min_order_total"] = get_min_order(db)
    out["min_order_retail"] = get_min_order(db, "retail")
    out["retail_markup"] = get_retail_markup(db)
    out["discount_tiers"] = get_discount_tiers(db)
    ref = get_referral(db)
    out["referral_reward_percent"], out["referral_friend_percent"] = ref["reward"], ref["friend"]
    return out


@router.put("")
def write(body: dict, db=Depends(get_db), admin=Depends(current_admin)):
    data = {}
    for k, v in body.items():
        if k not in ALLOWED:
            continue
        if k == "popular_categories":
            if isinstance(v, dict):
                clean = {}
                for cid, item in list(v.items())[:30]:
                    if not isinstance(item, dict):
                        continue
                    clean[str(cid)[:80]] = {"title": str(item.get("title", ""))[:100],
                                             "sub": str(item.get("sub", ""))[:180],
                                             "image": str(item.get("image", ""))[:100]}
                data[k] = clean
        elif k == "discount_tiers":
            try:
                data[k] = normalize_tiers(v)
            except ValueError as e:
                raise HTTPException(422, str(e))
        elif k in PERCENT:
            if str(v).strip() == "":
                continue
            try:
                n = int(float(str(v).replace(",", ".").strip()))
            except ValueError:
                raise HTTPException(422, f"{PERCENT[k]} — ціле число від 0 до 100")
            if not 0 <= n <= 100:
                raise HTTPException(422, f"{PERCENT[k]} — від 0 до 100 %")
            data[k] = n
        elif k in NUMERIC:
            if str(v).strip() == "":
                continue                     # порожнє поле = лишається поточне значення
            try:
                n = int(float(str(v).replace(",", ".").strip()))
            except ValueError:
                raise HTTPException(422, f"{NUMERIC[k]} — ціле число")
            if not 0 <= n <= 1_000_000:
                raise HTTPException(422, f"{NUMERIC[k]} має бути від 0 до 1 000 000")
            data[k] = n
        else:
            data[k] = str(v)[:1500]
    db.settings.update_one({"_id": "general"}, {"$set": data}, upsert=True)
    audit(db, admin, "settings.update", data)
    from .shop import invalidate_catalog
    invalidate_catalog()
    return data
