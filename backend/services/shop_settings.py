"""Налаштування магазину для повідомлень і чека: те, що адмін задає в dashboard (db.settings), з запасними значеннями."""
from ..config import settings
from .discounts import DEFAULT_TIERS, normalize_tiers


def _int_setting(key: str, default: int) -> int:
    def get(db) -> int:
        v = (db.settings.find_one({"_id": "general"}) or {}).get(key)
        try:
            v = int(float(str(v).replace(",", ".").strip()))
        except (TypeError, ValueError):
            return default
        return v if v >= 0 else default
    return get


def get_min_order(db, order_type: str = "wholesale") -> int:
    """Мінімальна сума замовлення (грн): значення з dashboard, а якщо не задано — значення з .env.
    Окремо для опту (min_order_total) та роздробу (min_order_retail)."""
    if order_type == "retail":
        return _int_setting("min_order_retail", settings.min_order_retail)(db)
    return _int_setting("min_order_total", settings.min_order_total)(db)


def get_retail_markup(db) -> int:
    """Націнка на одиницю товару для роздробу (картриджі не рахуються)."""
    return _int_setting("retail_markup", settings.retail_markup)(db)


def get_discount_tiers(db) -> list:
    """Рівні знижок за сумою (опт). Не задано в dashboard — стандартні; порожній список — знижки вимкнено."""
    raw = (db.settings.find_one({"_id": "general"}) or {}).get("discount_tiers")
    if raw is None:
        return list(DEFAULT_TIERS)
    try:
        return normalize_tiers(raw)
    except ValueError:
        return list(DEFAULT_TIERS)


DEFAULT_REFERRAL_PERCENT = 3


def get_referral(db) -> dict:
    """Реферальні знижки, %: reward — запрошувачу (коли друг отримав перше замовлення), friend — запрошеному. 0 = вимкнено."""
    s = db.settings.find_one({"_id": "general"}) or {}

    def pct(key: str) -> int:
        try:
            v = int(float(str(s.get(key)).replace(",", ".").strip()))
        except (TypeError, ValueError):
            return DEFAULT_REFERRAL_PERCENT
        return v if 0 <= v <= 100 else DEFAULT_REFERRAL_PERCENT
    return {"reward": pct("referral_reward_percent"), "friend": pct("referral_friend_percent")}


def get_shop(db) -> dict:
    s = db.settings.find_one({"_id": "general"}) or {}
    return {
        "shop_name": (s.get("shop_name") or "").strip() or "Bob Smoke",
        "receipt_title": (s.get("receipt_title") or "").strip() or "Bob Smoke | OPT",
        "payment_card": (s.get("payment_card") or "").strip() or settings.payment_card_env,
        "manager": (s.get("manager_username") or "").strip() or settings.manager_username_env,
        "prepay": settings.prepay_amount,
        "prepay_enabled": settings.prepay_enabled,
    }
