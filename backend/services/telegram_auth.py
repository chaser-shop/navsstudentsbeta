"""Перевірка підпису Telegram Mini App (initData). Лише стандартна бібліотека.

Документація: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
"""
import hashlib
import hmac
import json
import time
from urllib.parse import parse_qsl


class InitDataError(ValueError):
    pass


def validate_init_data(init_data: str, bot_token: str, max_age: int = 86400, now: float | None = None) -> dict:
    """Повертає {'user': {...}, 'auth_date': int, ...}; піднімає InitDataError, якщо підпис хибний або дані застарілі."""
    if not init_data or not bot_token:
        raise InitDataError("Немає даних Telegram")
    if len(init_data) > 8192:
        raise InitDataError("Некоректні дані Telegram")
    pairs = dict(parse_qsl(init_data, keep_blank_values=True, strict_parsing=False))
    got = pairs.pop("hash", None)
    if not got:
        raise InitDataError("Немає підпису")
    check = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    want = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, got):
        raise InitDataError("Підпис Telegram недійсний")
    try:
        auth_date = int(pairs.get("auth_date", "0"))
    except ValueError:
        raise InitDataError("Некоректна дата")
    if (now if now is not None else time.time()) - auth_date > max_age or auth_date <= 0:
        raise InitDataError("Сесія застаріла: відкрийте магазин із бота ще раз")
    try:
        user = json.loads(pairs.get("user", "null"))
    except ValueError:
        raise InitDataError("Некоректні дані користувача")
    if not isinstance(user, dict) or not isinstance(user.get("id"), int):
        raise InitDataError("Немає користувача")
    return {"user": user, "auth_date": auth_date}


def sign_init_data(fields: dict, bot_token: str) -> str:
    """Допоміжна функція для тестів: будує валідний initData."""
    from urllib.parse import urlencode
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    h = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode({**fields, "hash": h})
