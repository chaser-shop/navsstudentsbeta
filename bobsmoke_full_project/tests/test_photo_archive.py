"""Архів фото: видалений товар повертається з фото. Чисті тести (проста імітація колекції, без MongoDB)."""
from backend.services import photo_archive as pa
from backend.services import devblog as dv


class Coll:
    def __init__(self):
        self.d = {}

    def update_one(self, flt, upd, upsert=False):
        self.d.setdefault(flt["_id"], {"_id": flt["_id"]}).update(upd["$set"])

    def find(self, flt):
        ids = flt["_id"]["$in"]
        return [v for k, v in self.d.items() if k in ids]


class DB:
    def __init__(self):
        self.photo_archive = Coll()


def _p(**kw):
    base = {"name": "Mango Ice", "brand": "Elf Bar", "product_line": "Elf Liq 10ml", "images": ["a.webp", "b.webp"],
            "image_scope": "line"}
    base.update(kw)
    return base


def test_deleted_product_comes_back_with_photos():
    db = DB()
    assert pa.remember(db, [_p()]) == 1
    new = {"name": "Mango Ice", "brand": "Elf Bar", "product_line": "Elf Liq 10ml", "images": [], "needs_content": True}
    assert pa.restore(db, [new]) == 1
    assert new["images"] == ["a.webp", "b.webp"] and new["image_scope"] == "line" and new["needs_content"] is False


def test_other_product_gets_nothing_and_own_photos_are_kept():
    db = DB()
    pa.remember(db, [_p()])
    other = {"name": "Blue Razz", "brand": "Elf Bar", "product_line": "Elf Liq 10ml", "images": []}
    own = {"name": "Mango Ice", "brand": "Elf Bar", "product_line": "Elf Liq 10ml", "images": ["mine.webp"]}
    assert pa.restore(db, [other, own]) == 0
    assert other["images"] == [] and own["images"] == ["mine.webp"]


def test_products_without_photos_are_not_archived():
    db = DB()
    assert pa.remember(db, [_p(images=[])]) == 0
    assert pa.lookup(db, ["Elf Bar|Elf Liq 10ml|mango ice"]) == {}


def test_latest_photos_win_on_repeated_delete():
    db = DB()
    pa.remember(db, [_p()])
    pa.remember(db, [_p(images=["new.webp"])])
    new = {"name": "Mango Ice", "brand": "Elf Bar", "product_line": "Elf Liq 10ml", "images": []}
    pa.restore(db, [new])
    assert new["images"] == ["new.webp"]


def test_devblog_marks_photos():
    assert "📷 фото збережено" in dv.snapshot(_p(), archived=True)["facts"]
    assert "📷 з фото" in dv.snapshot(_p())["facts"]
