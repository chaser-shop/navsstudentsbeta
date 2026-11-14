"""Обов'язкова підписка на Telegram-канал перед входом у магазин.

Бот має бути АДМІНІСТРАТОРОМ каналу, інакше Telegram не дозволяє перевіряти підписників. Якщо перевірка технічно
неможлива (бот не адмін, канал не знайдено, Telegram недоступний), магазин не блокується для всіх: помилка лише
пишеться в лог (fail-open).
"""
import logging
import threading
import time

from .telegram_api import tg_call

log = logging.getLogger("subscription")
MEMBER = {"creator", "administrator", "member"}
TTL = 600                       # підписку, що вже підтверджена, перевіряємо повторно не частіше ніж раз на 10 хв
_ok: dict = {}
_lock = threading.Lock()


def chat_ref(channel: str):
    """Що передати в getChatMember: int для ID (-100…), '@name' для публічного каналу, None — якщо за значенням канал не визначити
    (наприклад, лише запрошення t.me/+… без ID)."""
    c = (channel or "").strip()
    if c.lstrip("-").isdigit():
        return int(c)
    name = c.rsplit("/", 1)[-1].lstrip("@")
    if not name or name.startswith("+") or name.lower() == "joinchat":
        return None
    return "@" + name


def channel_link(channel: str, link: str = "") -> str:
    """Посилання для кнопки «Підписатись»: явне REQUIRED_CHANNEL_LINK, інакше t.me/<назва> для публічного каналу."""
    if link and link.strip().startswith("https://t.me/"):
        return link.strip()
    c = (channel or "").strip()
    if c.startswith("https://t.me/"):
        return c
    ref = chat_ref(c)
    return "https://t.me/" + ref.lstrip("@") if isinstance(ref, str) else ""


def label(channel: str) -> str:
    """Що показати людині як назву каналу: @username або порожньо (ID показувати незрозуміло)."""
    ref = chat_ref(channel)
    return ref if isinstance(ref, str) else ""


def check(user_id: int, channel: str, call=tg_call, now=time.time) -> bool | None:
    """True — підписаний, False — ні, None — перевірити неможливо."""
    chat = chat_ref(channel)
    if chat is None:
        log.warning("REQUIRED_CHANNEL=%r не схожий на ID чи @username каналу: перевірку підписки пропущено", channel)
        return None
    with _lock:
        t = _ok.get((chat, user_id))
        if t and now() - t < TTL:
            return True
    res = call("getChatMember", {"chat_id": chat, "user_id": user_id})
    if not res.get("ok"):
        desc = str(res.get("description") or "")
        if "user not found" in desc.lower():
            return False
        log.warning("Не вдалося перевірити підписку на %s: %s (бот має бути адміном каналу, а REQUIRED_CHANNEL: його ID)", chat, desc)
        return None
    r = res.get("result") or {}
    member = r.get("status") in MEMBER or (r.get("status") == "restricted" and r.get("is_member"))
    if member:
        with _lock:
            if len(_ok) > 50000:
                _ok.clear()
            _ok[(chat, user_id)] = now()
    return bool(member)
