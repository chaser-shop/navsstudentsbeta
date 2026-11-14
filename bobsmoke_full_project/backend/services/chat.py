"""Переписка покупців з менеджером (колекції messages і chats). Повідомлення від покупця потрапляють сюди з вебхука бота,
відповіді менеджера й службові повідомлення бота (подяка за замовлення, чек) теж, щоб у dashboard була вся історія."""
from datetime import datetime, timezone


def log_message(db, tg_id: int, direction: str, text: str = "", *, kind: str = "text", media: dict | None = None,
                tg_message_id: int | None = None, by: str = "", name: str = "", username: str = "") -> dict:
    """direction: "in" (покупець -> бот) або "out" (бот/менеджер -> покупець)."""
    now = datetime.now(timezone.utc)
    doc = {"tg_id": tg_id, "dir": direction, "text": text, "kind": kind, "at": now}
    if media:
        doc["media"] = media
    if tg_message_id:
        doc["tg_message_id"] = tg_message_id
    if by:
        doc["by"] = by
    db.messages.insert_one(doc)
    preview = text or {"photo": "📷 Фото", "document": "📎 Файл", "receipt": "🧾 Чек"}.get(kind, "[повідомлення]")
    upd = {"$set": {"last_text": preview[:120], "last_dir": direction, "last_at": now},
           "$setOnInsert": {"created_at": now}}
    if direction == "in":
        upd["$inc"] = {"unread": 1}
    elif by:
        upd["$set"]["unread"] = 0                       # відповідь менеджера = чат прочитано; службові повідомлення бота цього не змінюють
    if name:
        upd["$set"]["name"] = name
    if username:
        upd["$set"]["username"] = username
    db.chats.update_one({"_id": tg_id}, upd, upsert=True)
    return doc
