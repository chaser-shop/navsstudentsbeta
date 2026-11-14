"""Актуальний список користувачів: тих, хто заблокував бота (або видалив акаунт Telegram), прибираємо з users.

Три шляхи, щоб список був свіжим без ручної роботи:
1. Миттєво: Telegram надсилає оновлення my_chat_member, коли користувач блокує бота (bot/shop_bot.py).
2. Під час розсилки: відповідь 403 «bot was blocked by the user» (services/broadcast.py).
3. Регулярна перевірка всіх (sweep): тихий sendChatAction кожному; раз на USER_SYNC_HOURS у фоні, а також кнопкою в dashboard
   і командою `python -m backend.cli purge-blocked`. Ловить тих, хто заблокував бота, поки сервер спав чи вебхук не працював.

Видаляється лише запис користувача та його кошик. Замовлення, історія чату й промокоди лишаються: вони потрібні для обліку.
Якщо людина повернеться (/start або відкриє магазин), вона зареєструється заново.
Не видаляємо тих, кому бот просто не може написати (людина не натискала /start): вони бота не блокували.
"""
import logging
import time
from datetime import datetime, timedelta, timezone

from pymongo.errors import DuplicateKeyError

from .telegram_api import tg_call

log = logging.getLogger("user_sync")

RATE_PER_SEC = 20
STALE_AFTER = timedelta(seconds=180)
_GONE = ("bot was blocked by the user", "user is deactivated")


def _now():
    return datetime.now(timezone.utc)


def is_gone(res: dict) -> bool:
    """Відповідь Telegram означає: користувач заблокував бота або видалив акаунт."""
    d = (res.get("description") or "").lower()
    return res.get("error_code") == 403 and any(x in d for x in _GONE)


def remove_user(db, uid: int) -> bool:
    r = db.users.delete_one({"_id": uid})
    db.carts.delete_one({"_id": uid})
    return bool(getattr(r, "deleted_count", 0))


def _ids(db) -> list[int]:
    return [u["_id"] for u in db.users.find({}, {"_id": 1}) if isinstance(u["_id"], int) and u["_id"] > 0]


def sweep(db, call=tg_call, sleep=time.sleep, rate: int = RATE_PER_SEC, progress=None) -> dict:
    """Перевіряє всіх користувачів і видаляє тих, хто заблокував бота. -> {checked, removed, errors}."""
    checked = removed = errors = 0
    for uid in _ids(db):
        res = call("sendChatAction", {"chat_id": uid, "action": "typing"})
        if res.get("error_code") == 429:
            sleep(min(30, int((res.get("parameters") or {}).get("retry_after") or 1) + 1))
            res = call("sendChatAction", {"chat_id": uid, "action": "typing"})
        checked += 1
        if res.get("ok"):
            db.users.update_one({"_id": uid}, {"$unset": {"bot_blocked": "", "bot_blocked_at": ""}})
        elif is_gone(res):
            removed += remove_user(db, uid)
        else:
            errors += 1                                    # «не можна ініціювати чат», мережа тощо: користувача не чіпаємо
        if progress and checked % 20 == 0:
            progress(checked, removed)
        sleep(1 / rate)
    return {"checked": checked, "removed": removed, "errors": errors}


# ---------- стан і запуск ----------
def state(db) -> dict:
    d = db.user_sync.find_one({"_id": "state"}) or {}
    upd = d.get("updated_at")
    if d.get("status") == "running" and upd is not None:
        if upd.tzinfo is None:
            upd = upd.replace(tzinfo=timezone.utc)
        if _now() - upd > STALE_AFTER:                     # сервер перезапустився посеред перевірки
            d["status"] = "interrupted"
    return {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in d.items() if k != "_id"}


def _claim(db) -> bool:
    now = _now()
    try:
        r = db.user_sync.update_one(
            {"_id": "state", "$or": [{"status": {"$ne": "running"}}, {"updated_at": {"$lt": now - STALE_AFTER}}]},
            {"$set": {"status": "running", "started_at": now, "updated_at": now, "checked": 0, "removed": 0}}, upsert=True)
    except DuplicateKeyError:                              # документ є й перевірка вже триває
        return False
    return bool(r.modified_count or r.upserted_id is not None)


def run(db, call=tg_call, sleep=time.sleep) -> dict | None:
    """Одна повна перевірка з записом стану. None, якщо інша вже триває. Не піднімає винятків."""
    if not _claim(db):
        return None

    def prog(c, r):
        db.user_sync.update_one({"_id": "state"}, {"$set": {"checked": c, "removed": r, "updated_at": _now()}})
    try:
        out = sweep(db, call=call, sleep=sleep, progress=prog)
        db.user_sync.update_one({"_id": "state"}, {"$set": {"status": "done", "finished_at": _now(), "updated_at": _now(), **out}})
        if out["removed"]:
            log.info("Видалено заблокованих користувачів: %s із %s", out["removed"], out["checked"])
        return out
    except Exception as e:
        log.exception("Перевірка користувачів зупинилась")
        db.user_sync.update_one({"_id": "state"}, {"$set": {"status": "error", "error": str(e)[:200], "finished_at": _now()}})
        return None


def schedule_loop(get_db, hours: float) -> None:
    """Фоновий потік: перша перевірка через 10 хв після старту, далі раз на `hours` годин."""
    time.sleep(600)
    while True:
        try:
            run(get_db())
        except Exception:
            log.exception("Планова перевірка користувачів")
        time.sleep(max(1, hours) * 3600)
