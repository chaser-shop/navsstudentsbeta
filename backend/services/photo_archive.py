"""Архів фото: товар, який видалили з каталогу, не втрачає фото.

Фото запамʼятовуються за dedupe_key (бренд|лінійка|назва) у колекції photo_archive перед кожним видаленням.
Коли такий самий товар зʼявляється знову (ручне додавання, оновлення з Excel, імпорт прайсу), він одразу отримує
збережені фото, і «потрібне фото» (needs_content) для нього не виставляється.

Товар, який лише закінчився («Немає в наявності»), нікуди не зникає з каталогу, тож фото в нього вже є.
Самі файли фото лежать у MongoDB (media) або в imports/images і від видалення товару не залежать.
"""
from datetime import datetime, timezone


def key_of(p: dict) -> str | None:
    if p.get("dedupe_key"):
        return p["dedupe_key"]
    if p.get("brand") and p.get("name"):
        return f"{p['brand']}|{p.get('product_line') or ''}|{p['name'].lower()}"
    return None


def remember(db, docs: list) -> int:
    """Зберігає фото товарів перед видаленням. Повертає, скільки товарів мали фото."""
    now, n = datetime.now(timezone.utc), 0
    for p in docs:
        key, imgs = key_of(p), p.get("images") or []
        if not key or not imgs:
            continue
        db.photo_archive.update_one({"_id": key}, {"$set": {
            "images": list(imgs), "image_scope": p.get("image_scope"), "name": p.get("name"),
            "brand": p.get("brand"), "product_line": p.get("product_line"), "archived_at": now}}, upsert=True)
        n += 1
    return n


def lookup(db, keys) -> dict:
    """{dedupe_key: запис архіву} для переданих ключів."""
    keys = sorted({k for k in keys if k})
    if not keys:
        return {}
    return {r["_id"]: r for r in db.photo_archive.find({"_id": {"$in": keys}})}


def apply(doc: dict, archive: dict) -> bool:
    """Підставляє архівні фото в новий документ товару (лише якщо власних фото в нього немає)."""
    if doc.get("images"):
        return False
    a = archive.get(key_of(doc))
    if not a or not a.get("images"):
        return False
    doc["images"], doc["image_scope"], doc["needs_content"] = list(a["images"]), a.get("image_scope"), False
    return True


def restore(db, docs: list) -> int:
    """Підставляє архівні фото в усі передані нові документи. Повертає кількість відновлених."""
    archive = lookup(db, [key_of(d) for d in docs if not d.get("images")])
    return sum(1 for d in docs if apply(d, archive))
