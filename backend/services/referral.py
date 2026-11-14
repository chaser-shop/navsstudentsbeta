"""Дуже проста реферальна програма.

1. У кожного клієнта є своє посилання: https://t.me/<бот>?start=ref_<його telegram id> (екран «Запросити друга» в Mini App).
2. Друг відкриває бота за посиланням -> запам'ятовуємо, хто його запросив (один раз, не себе, лише поки в нього немає замовлень).
   Друг одразу отримує одноразовий персональний промокод (знижка referral_friend_percent).
3. Коли перше замовлення друга отримує статус «Виконане» — запрошувач отримує свій одноразовий промокод
   (знижка referral_reward_percent) і повідомлення в Telegram. Нагорода видається один раз за кожного друга.
Нагорода — це звичайний промокод (services/promo.py): окремого балансу чи бонусних рахунків немає.
"""
from datetime import datetime, timedelta, timezone

from . import promo
from .shop_settings import get_referral
from .telegram_api import tg_call

_username: str | None = None


def parse_start(payload: str) -> int | None:
    """'ref_12345' -> 12345; все інше -> None."""
    p = (payload or "").strip()
    if p.startswith("ref_") and p[4:].isdigit() and 0 < int(p[4:]) < 2 ** 53:
        return int(p[4:])
    return None


def bot_username() -> str:
    """BOT_USERNAME з .env, інакше один раз питаємо Telegram (getMe) і запам'ятовуємо."""
    global _username
    from ..config import settings
    if settings.bot_username:
        return settings.bot_username
    if _username is None:
        res = tg_call("getMe")
        if res.get("ok"):
            _username = str((res.get("result") or {}).get("username") or "")
    return _username or ""


def link_for(uid: int) -> str:
    name = bot_username()
    return f"https://t.me/{name}?start=ref_{uid}" if name else ""


def attach(db, invitee_id: int, referrer_id: int, now: datetime | None = None) -> dict | None:
    """Фіксує запрошення. -> {code, percent} (подарунковий код другу) або None, якщо запрошення не зараховано."""
    if referrer_id == invitee_id or invitee_id <= 0 or referrer_id <= 0:
        return None
    if not db.users.find_one({"_id": referrer_id}, {"_id": 1}):
        return None
    if db.orders.count_documents({"customer.tg_id": invitee_id}) > 0:
        return None                                     # запрошення діє лише для тих, хто ще нічого не замовляв
    r = db.users.update_one({"_id": invitee_id, "referred_by": {"$exists": False}},
                            {"$set": {"referred_by": referrer_id, "referred_at": now or datetime.now(timezone.utc)}})
    if r.modified_count != 1:
        return None                                     # уже запрошений раніше (або користувача немає)
    pct = get_referral(db)["friend"]
    if pct <= 0:
        return None
    doc = promo.create_code(db, percent=pct, max_uses=1, owner_tg_id=invitee_id, kind="referral_friend")
    return {"code": doc["_id"], "percent": pct}


def reward_on_done(db, order: dict, call=tg_call) -> dict | None:
    """Викликається, коли замовлення стало «Виконане». Перше виконане замовлення запрошеного -> код запрошувачу."""
    uid = (order.get("customer") or {}).get("tg_id")
    if not isinstance(uid, int) or uid <= 0:
        return None
    u = db.users.find_one_and_update(
        {"_id": uid, "referred_by": {"$exists": True}, "referral_rewarded": {"$ne": True}},
        {"$set": {"referral_rewarded": True, "referral_rewarded_at": datetime.now(timezone.utc), "referral_order": order.get("number")}})
    if not u:
        return None
    pct = get_referral(db)["reward"]
    if pct <= 0:
        return None
    referrer = u["referred_by"]
    doc = promo.create_code(db, percent=pct, max_uses=1, owner_tg_id=referrer, kind="referral_reward")
    call("sendMessage", {"chat_id": referrer, "text": (
        f"🎉 Ваш друг зробив перше замовлення!\n\nДякуємо, що запросили. Ваш промокод: {doc['_id']}\n"
        f"Знижка {pct:g}% на наступне замовлення — введіть його при оформленні.")})
    return {"referrer_id": referrer, "code": doc["_id"], "percent": pct}


def stats(db, uid: int) -> dict:
    """Дані для екрана «Запросити друга»."""
    from ..database import load
    cfg = get_referral(db)
    codes = [{"code": c["_id"], "percent": float(load(c)["percent"])}
             for c in db.promo_codes.find({"owner_tg_id": uid, "active": True, "used": 0}).sort("created_at", -1).limit(20)]
    return {"link": link_for(uid), "invited": db.users.count_documents({"referred_by": uid}),
            "rewarded": db.users.count_documents({"referred_by": uid, "referral_rewarded": True}),
            "reward_percent": cfg["reward"], "friend_percent": cfg["friend"], "codes": codes}


def _name(u: dict | None, uid: int) -> str:
    n = " ".join(x for x in ((u or {}).get("first_name"), (u or {}).get("last_name")) if x)
    return n or "Без імені"


def leaderboard(db, days: int | None = None, limit: int = 100, now: datetime | None = None) -> dict:
    """Рейтинг запрошувачів для dashboard: хто скількох привів.
    days — лише запрошення за останні N днів (None = за весь час). Замовлення й виручка: виконані замовлення запрошених.
    Видалені з користувачів (заблокували бота) запрошувачі лишаються в рейтингу з позначкою deleted."""
    from ..database import load
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days) if days else None

    def aware(d):
        return d if d is None or d.tzinfo else d.replace(tzinfo=timezone.utc)

    invitees = []
    for u in db.users.find({"referred_by": {"$exists": True}}):
        at = aware(u.get("referred_at"))
        if cutoff and (at is None or at < cutoff):
            continue
        if isinstance(u.get("referred_by"), int):
            invitees.append({**u, "referred_at": at})

    by_ref: dict = {}
    owner = {}
    for u in invitees:
        r = by_ref.setdefault(u["referred_by"], {"invited": 0, "rewarded": 0, "last": None, "orders": 0, "sum": 0.0})
        r["invited"] += 1
        r["rewarded"] += 1 if u.get("referral_rewarded") else 0
        if u["referred_at"] and (r["last"] is None or u["referred_at"] > r["last"]):
            r["last"] = u["referred_at"]
        owner[u["_id"]] = u["referred_by"]

    if owner:
        for o in db.orders.find({"customer.tg_id": {"$in": list(owner)}, "status": "done"}, {"customer.tg_id": 1, "total": 1, "status": 1}):
            o = load(o)
            ref = owner.get((o.get("customer") or {}).get("tg_id"))
            if ref is not None and o.get("status") == "done":
                by_ref[ref]["orders"] += 1
                by_ref[ref]["sum"] += float(o.get("total") or 0)

    people = {u["_id"]: u for u in db.users.find({"_id": {"$in": list(by_ref)}}) if u["_id"] in by_ref}
    rows = []
    for rid, r in by_ref.items():
        u = people.get(rid)
        rows.append({"id": rid, "name": _name(u, rid), "username": (u or {}).get("username", ""), "deleted": u is None,
                     "invited": r["invited"], "rewarded": r["rewarded"], "orders": r["orders"], "orders_sum": round(r["sum"], 2),
                     "last_invited_at": r["last"]})
    rows.sort(key=lambda x: (-x["invited"], -x["rewarded"], -x["orders_sum"], x["last_invited_at"] is None, -(x["last_invited_at"].timestamp() if x["last_invited_at"] else 0)))
    for i, r in enumerate(rows, 1):
        r["rank"] = i

    recent = sorted((u for u in invitees if u["referred_at"]), key=lambda u: u["referred_at"], reverse=True)[:15]
    recent_rows = [{"id": u["_id"], "name": _name(u, u["_id"]), "username": u.get("username", ""),
                    "referrer_id": u["referred_by"], "referrer": _name(people.get(u["referred_by"]), u["referred_by"]),
                    "at": u["referred_at"], "rewarded": bool(u.get("referral_rewarded"))} for u in recent]
    return {"summary": {"invited": len(invitees), "referrers": len(rows), "rewarded": sum(r["rewarded"] for r in rows),
                        "orders": sum(r["orders"] for r in rows), "orders_sum": round(sum(r["orders_sum"] for r in rows), 2)},
            "rows": rows[:limit], "recent": recent_rows}
