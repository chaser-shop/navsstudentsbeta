"""Промокоди: відсоток знижки на суму товарів у замовленні.

Чиста логіка (normalize_*, check, amount) не залежить від БД. Кілька коротких операцій з колекцією
`promo_codes` (create_code / redeem / release) імпортують database ліниво, щоб логіку можна було тестувати без MongoDB.

Документ: {_id: КОД, percent, active, kind, owner_tg_id, uses_left (None = без ліміту), used, used_by[], expires_at, created_at}.
  kind = manual (створює адмін) | referral_friend (подарунок запрошеному) | referral_reward (нагорода тому, хто запросив).
  owner_tg_id заданий -> код персональний, його може застосувати лише цей клієнт.
Один клієнт може використати один і той самий код лише раз.
"""
import re
import secrets
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from .pricing import D, money

ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"        # без 0/O та 1/I/L, щоб код легко читався й диктувався
CODE_RE = re.compile(r"[A-Z0-9А-ЯІЇЄҐ_-]{3,32}")


class PromoError(ValueError):
    pass


def normalize_code(raw) -> str:
    code = re.sub(r"\s+", "", str(raw or "")).upper()
    if not CODE_RE.fullmatch(code):
        raise PromoError("Код: 3–32 символи (літери, цифри, - або _)")
    return code


def normalize_percent(raw) -> Decimal:
    try:
        p = D(str(raw).replace(",", ".").strip())
    except (InvalidOperation, ValueError):
        raise PromoError("Знижка має бути числом")
    if not p.is_finite() or not 0 < p <= 100:
        raise PromoError("Знижка має бути від 0 до 100 %")
    q = p.quantize(Decimal("0.01"))
    return q.to_integral_value() if q == q.to_integral_value() else q.normalize()


def generate_code(prefix: str = "REF") -> str:
    return f"{prefix}-" + "".join(secrets.choice(ALPHABET) for _ in range(6))


def _aware(d):
    return d.replace(tzinfo=timezone.utc) if d is not None and d.tzinfo is None else d


def check(doc: dict | None, tg_id: int, now: datetime | None = None) -> Decimal:
    """Чи може клієнт tg_id застосувати цей код зараз. -> відсоток знижки; інакше PromoError з текстом для покупця."""
    if not doc:
        raise PromoError("Промокод не знайдено")
    if not doc.get("active", True):
        raise PromoError("Цей промокод більше не діє")
    exp = _aware(doc.get("expires_at"))
    if exp is not None and exp < (now or datetime.now(timezone.utc)):
        raise PromoError("Термін дії промокоду минув")
    owner = doc.get("owner_tg_id")
    if owner is not None and owner != tg_id:
        raise PromoError("Цей промокод призначений іншому клієнту")
    if tg_id in (doc.get("used_by") or []):
        raise PromoError("Ви вже використовували цей промокод")
    left = doc.get("uses_left")
    if left is not None and left <= 0:
        raise PromoError("Цей промокод уже використано")
    return D(str(doc["percent"]))


def amount(subtotal, percent) -> Decimal:
    """Сума знижки в грн (округлення до копійок)."""
    return money(D(subtotal) * D(str(percent)) / 100)


# ---------- операції з БД ----------

def create_code(db, *, percent, code: str | None = None, max_uses: int | None = None, expires_at: datetime | None = None,
                owner_tg_id: int | None = None, kind: str = "manual", prefix: str = "REF") -> dict:
    from pymongo.errors import DuplicateKeyError
    from ..database import to_db
    pct = normalize_percent(percent)
    for _ in range(5 if code is None else 1):
        c = normalize_code(code) if code else generate_code(prefix)
        doc = {"_id": c, "percent": pct, "active": True, "kind": kind, "owner_tg_id": owner_tg_id,
               "uses_left": max_uses, "max_uses": max_uses, "used": 0, "used_by": [], "expires_at": expires_at,
               "created_at": datetime.now(timezone.utc)}
        try:
            db.promo_codes.insert_one(to_db(doc))
            return doc
        except DuplicateKeyError:
            if code:
                raise PromoError("Такий промокод уже існує")
    raise PromoError("Не вдалося згенерувати унікальний код, спробуйте ще раз")


def lookup(db, raw) -> dict | None:
    from ..database import load
    try:
        code = normalize_code(raw)
    except PromoError:
        return None
    d = db.promo_codes.find_one({"_id": code})
    return load(d) if d else None


def redeem(db, raw, tg_id: int) -> dict:
    """Перевіряє код і атомарно «бере» одне використання (двоє одночасно не використають одноразовий код).
    -> {code, percent, limited}. Якщо замовлення не створилось — викличте release()."""
    doc = lookup(db, raw)
    percent = check(doc, tg_id)
    limited = doc.get("uses_left") is not None
    flt = {"_id": doc["_id"], "active": True, "used_by": {"$ne": tg_id}, "uses_left": {"$gt": 0} if limited else None}
    upd = {"$inc": {"used": 1, **({"uses_left": -1} if limited else {})}, "$addToSet": {"used_by": tg_id}}
    if db.promo_codes.find_one_and_update(flt, upd) is None:
        raise PromoError("Цей промокод уже використано")
    return {"code": doc["_id"], "percent": percent, "limited": limited}


def release(db, redeemed: dict, tg_id: int) -> None:
    """Повертає використання, якщо замовлення не вдалося оформити."""
    try:
        db.promo_codes.update_one({"_id": redeemed["code"], "used_by": tg_id},
                                  {"$inc": {"used": -1, **({"uses_left": 1} if redeemed.get("limited") else {})},
                                   "$pull": {"used_by": tg_id}})
    except Exception:       # повернення не критичне: помилка оформлення важливіша
        pass
