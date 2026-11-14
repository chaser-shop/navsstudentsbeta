import re
from datetime import datetime, timezone
from decimal import Decimal

from bson import ObjectId
from pymongo import UpdateOne
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import FileResponse

from ..auth.security import audit, current_admin
from ..config import settings
from ..database import get_db, load, public, to_db
from ..models.schemas import ProductIn, ProductPatch
from ..services import devblog, lines as ln, photo_archive
from ..services.compliance import classify
from ..services.pricing import CATEGORY_LABELS, D, money, purchase_from_final, reprice, usdt_from_uah
from ..services.shop_settings import get_retail_markup
from .pricing import get_markups
from .shop import invalidate_catalog

router = APIRouter(prefix="/api", tags=["products"])


def _oid(pid: str) -> ObjectId:
    try:
        return ObjectId(pid)
    except Exception:
        raise HTTPException(404, "Товар не знайдено")


def _with_usdt(p: dict) -> dict:
    """Для сторінки товару: гривня + USDT (якщо в прайсі є курс)."""
    p = load(p)
    u = p.get("usdt")
    if u and p.get("final_price") is not None:
        p["final_price_usdt"] = usdt_from_uah(p["final_price"], u["rate"])
    return p


def _notify_line_price(bg, admin: str, line: str, label: str, old_prices: list, new_price, count: int) -> None:
    """Dev-blog про масову зміну ціни лінійки: «було» показуємо лише якщо ціна була однаковою в усіх смаків."""
    olds = {devblog._price(x) for x in old_prices if x is not None}
    old = next(iter(olds)) if len(olds) == 1 else "різні"
    devblog.publish(changed=[{"name": f"Лінійка «{line}»", "brand": "", "line": "",
                              "diffs": [(label, old, devblog._price(new_price))] if old != devblog._price(new_price) else [],
                              "note": f"{count} поз."}],
                    source="Масова зміна ціни", actor=admin, bg=bg)


@router.get("/products")
def list_products(q: str = "", category: str = "", brand: str = "", status: str = "",
                  compliance: str = "", line: str = "", hot: str = "", needs_content: str = "", sort: str = "name", page: int = Query(1, ge=1),
                  limit: int = Query(30, ge=1, le=100), db=Depends(get_db), _=Depends(current_admin)):
    f: dict = {}
    if q.strip():
        rx = {"$regex": re.escape(q.strip()), "$options": "i"}
        f["$or"] = [{"name": rx}, {"brand": rx}, {"model": rx}, {"variant": rx}, {"sku": rx}, {"product_line": rx}, {"custom_line": rx}]
    for k, v in (("category", category), ("brand", brand), ("status", status), ("compliance.status", compliance)):
        if v:
            f[k] = v
    if hot in ("1", "true"):
        f["hot"] = True
    if needs_content in ("1", "true"):          # нові позиції з автооновлення, яким ще потрібні фото
        f["needs_content"] = True
    if line:                                   # точний фільтр за лінійкою (ключ із /api/lines)
        f["_id"] = {"$in": [p["_id"] for p in db.products.find({}) if ln.line_of(load(p))[0] == line]}
    order = {"hot": [("hot", -1), ("name", 1)], "name": [("name", 1)], "price_asc": [("final_price", 1)], "price_desc": [("final_price", -1)]}.get(sort, [("name", 1)])
    total = db.products.count_documents(f)
    items = list(db.products.find(f).sort(order).skip((page - 1) * limit).limit(limit))
    general = get_retail_markup(db)
    out = []
    for i in items:
        d, p = public(i), load(i)
        d["line"], d["line_key"] = ln.line_of(p)[1], ln.line_of(p)[0]
        d["retail_price"] = ln.fmt(ln.retail_price(p, general))
        out.append(d)
    return {"items": out, "total": total, "page": page, "pages": max(1, -(-total // limit))}


@router.get("/brands")
def brands(category: str = "", db=Depends(get_db), _=Depends(current_admin)):
    return sorted(db.products.distinct("brand", {"category": category} if category else {}))


@router.get("/categories")
def categories(_=Depends(current_admin)):
    return [{"id": k, "label": v} for k, v in CATEGORY_LABELS.items()]


@router.post("/products/bulk-line-price")
def bulk_line_price(body: dict, bg: BackgroundTasks, db=Depends(get_db), admin=Depends(current_admin)):
    line = str(body.get("product_line") or "").strip()
    if not line:
        raise HTTPException(422, "Оберіть лінійку")
    try:
        final = money(D(body.get("final_price")))
    except Exception:
        raise HTTPException(422, "Некоректна ціна")
    if final < 0:
        raise HTTPException(422, "Ціна не може бути від’ємною")
    markups = get_markups(db)
    now = datetime.now(timezone.utc)
    docs = list(db.products.find({"category": "liquid", "product_line": line}))
    if not docs:
        raise HTTPException(404, "У цій лінійці немає товарів")
    ops = []
    for raw in docs:
        p = load(raw)
        try:
            purchase = purchase_from_final(final, p.get("category"), markups)
        except ValueError as e:
            raise HTTPException(422, str(e))
        merged = {**p, "final_price": final, "purchase_price": purchase, "usdt": None}
        patch = {"final_price": final, "purchase_price": purchase, "usdt": None,
                 **reprice(merged, markups), "updated_at": now}
        ops.append(UpdateOne({"_id": raw["_id"]}, {"$set": to_db(patch)}))
    if ops:
        db.products.bulk_write(ops)
    invalidate_catalog()
    audit(db, admin, "product.bulk_line_price", {"product_line": line, "price": str(final), "updated": len(ops)})
    _notify_line_price(bg, admin, line, "Ціна (опт)", [load(r).get("final_price") for r in docs], final, len(ops))
    return {"updated": len(ops), "product_line": line, "final_price": public(final)}


@router.get("/product-lines")
def product_lines(db=Depends(get_db), _=Depends(current_admin)):
    """Усі лінійки рідин із поточною оптовою та роздрібною ціною (None, якщо в лінійці ціни різні)."""
    general = D(get_retail_markup(db))
    acc: dict = {}
    for raw in db.products.find({"category": "liquid", "product_line": {"$ne": None}},
                                {"product_line": 1, "final_price": 1, "retail_markup": 1}):
        p = load(raw)
        e = acc.setdefault(p["product_line"], {"count": 0, "wholesale": set(), "retail": set()})
        e["count"] += 1
        if p.get("final_price") is not None:
            own = p.get("retail_markup")
            e["wholesale"].add(money(p["final_price"]))
            e["retail"].add(money(D(p["final_price"]) + (D(own) if own is not None else general)))
    one = lambda s: format(next(iter(s)), "f") if len(s) == 1 else None
    return [{"line": k, "count": v["count"], "wholesale": one(v["wholesale"]), "retail": one(v["retail"])}
            for k, v in sorted(acc.items(), key=lambda kv: kv[0].casefold())]


@router.post("/products/bulk-line-retail-price")
def bulk_line_retail_price(body: dict, bg: BackgroundTasks, db=Depends(get_db), admin=Depends(current_admin)):
    """Роздрібна ціна для всіх смаків лінійки. Зберігається як націнка понад оптову (retail_markup товару),
    оптова ціна не змінюється. reset=true повертає загальну роздрібну націнку з налаштувань."""
    line = str(body.get("product_line") or "").strip()
    if not line:
        raise HTTPException(422, "Оберіть лінійку")
    reset = bool(body.get("reset"))
    retail = None
    if not reset:
        try:
            retail = money(D(body.get("retail_price")))
        except Exception:
            raise HTTPException(422, "Некоректна ціна")
        if retail < 0:
            raise HTTPException(422, "Ціна не може бути від’ємною")
    docs = list(db.products.find({"category": "liquid", "product_line": line}))
    if not docs:
        raise HTTPException(404, "У цій лінійці немає товарів")
    now = datetime.now(timezone.utc)
    ops = []
    for raw in docs:
        p = load(raw)
        if reset:
            markup = None
        else:
            if p.get("final_price") is None:
                raise HTTPException(422, f"«{p['name']}» не має оптової ціни")
            markup = retail - money(p["final_price"])
            if markup < 0:
                raise HTTPException(422, f"Роздрібна ціна не може бути нижчою за оптову ({money(p['final_price'])} грн): «{p['name']}»")
        ops.append(UpdateOne({"_id": raw["_id"]}, {"$set": to_db({"retail_markup": markup, "updated_at": now})}))
    db.products.bulk_write(ops)
    invalidate_catalog()
    audit(db, admin, "product.bulk_line_retail_price", {"product_line": line, "price": None if reset else str(retail), "updated": len(ops)})
    if reset:
        devblog.publish(changed=[{"name": f"Лінійка «{line}»", "brand": "", "line": "", "diffs": [],
                                  "note": f"Роздрібна ціна повернута до загальної націнки · {len(ops)} поз."}],
                        source="Масова зміна роздрібної ціни", actor=admin, bg=bg)
    else:
        devblog.publish(changed=[{"name": f"Лінійка «{line}»", "brand": "", "line": "",
                                  "diffs": [("Роздрібна ціна", "різні", devblog._price(retail))],
                                  "note": f"{len(ops)} поз."}],
                        source="Масова зміна роздрібної ціни", actor=admin, bg=bg)
    return {"updated": len(ops), "product_line": line, "retail_price": None if reset else public(retail)}


@router.delete("/product-lines/{line}")
def delete_product_line(line: str, bg: BackgroundTasks, confirm: bool = False, db=Depends(get_db), admin=Depends(current_admin)):
    if not confirm:
        raise HTTPException(400, "Потрібне підтвердження (confirm=true)")
    line = line.strip()
    if not line:
        raise HTTPException(422, "Лінійка не вказана")
    gone = [load(r) for r in db.products.find({"category": "liquid", "product_line": line})]
    saved = photo_archive.remember(db, gone)         # фото всіх смаків лінійки зберігаються
    result = db.products.delete_many({"category": "liquid", "product_line": line})
    if not result.deleted_count:
        raise HTTPException(404, "Лінійку не знайдено")
    invalidate_catalog()
    audit(db, admin, "product_line.delete", {"product_line": line, "deleted": result.deleted_count})
    devblog.publish(removed=[{"name": f"Уся лінійка «{line}»", "brand": gone[0].get("brand") or "" if gone else "", "line": "",
                              "facts": [f"{result.deleted_count} поз."] + ([f"📷 фото збережено: {saved}"] if saved else [])}],
                    source="Видалення лінійки", actor=admin, bg=bg)
    return {"deleted": result.deleted_count}


@router.get("/products/{pid}")
def get_product(pid: str, db=Depends(get_db), _=Depends(current_admin)):
    p = db.products.find_one({"_id": _oid(pid)})
    if not p:
        raise HTTPException(404, "Товар не знайдено")
    return public(_with_usdt(p))


@router.post("/products", status_code=201)
def create_product(body: ProductIn, bg: BackgroundTasks, db=Depends(get_db), admin=Depends(current_admin)):
    d = body.model_dump()
    markups = get_markups(db)
    final = d.pop("final_price")
    sheet_source = d.pop("sheet_source", None)
    if final is not None:
        try:
            d["purchase_price"] = purchase_from_final(final, d["category"], markups)
        except ValueError as e:
            raise HTTPException(422, str(e))
    d["purchase_price"] = money(D(d["purchase_price"]))
    d["retail_markup"] = money(D(d["retail_markup"])) if d.get("retail_markup") is not None else None
    d["custom_line"] = " ".join((d.get("custom_line") or "").split()) or None
    d["category_label"] = CATEGORY_LABELS.get(d["category"], "Не визначено")
    d["status_label"] = {"in_stock": "В наявності", "expected": "Очікується на прибуття", "unavailable": "Немає в наявності"}[d["status"]]
    d["dedupe_key"] = f"{d['brand']}|{d.get('product_line') or ''}|{d['name'].lower()}"
    d["compliance"] = classify(d["category"], d.get("volume_ml"), d.get("nicotine_mg"), d["name"])
    # «Додати» з Excel: товар не позначається manual, тож наступні файли оновлюватимуть його наявність, як і решти каталогу
    d["usdt"], d["image_scope"] = None, None
    d["internal"] = {"source_sheet": sheet_source, "added_by": "excel-manual"} if sheet_source else {"manual": True}
    d.update(reprice(d, markups))
    now = datetime.now(timezone.utc)
    d["created_at"] = d["updated_at"] = now
    if db.products.find_one({"dedupe_key": d["dedupe_key"]}):
        raise HTTPException(409, "Такий товар уже існує")
    photo_archive.restore(db, [d])                  # товар, який колись видаляли, повертається з фото
    res = db.products.insert_one(to_db(d))
    invalidate_catalog()
    audit(db, admin, "product.create", {"id": str(res.inserted_id), "name": d["name"]})
    devblog.publish(added=[devblog.snapshot(load(d))], source="Новий товар", actor=admin, bg=bg)
    return public(db.products.find_one({"_id": res.inserted_id}))


@router.patch("/products/{pid}")
def update_product(pid: str, body: ProductPatch, bg: BackgroundTasks, apply_image_to_group: bool = False, db=Depends(get_db),
                   admin=Depends(current_admin)):
    p = db.products.find_one({"_id": _oid(pid)})
    if not p:
        raise HTTPException(404, "Товар не знайдено")
    p = load(p)
    patch = body.model_dump(exclude_unset=True)
    markups = get_markups(db)
    final = patch.pop("final_price", None)
    if "hot" in patch:
        patch["hot"] = bool(patch["hot"])
    if final is not None and "purchase_price" in patch:
        raise HTTPException(422, "Вкажіть лише одну ціну: закупівельну або продажу")
    if "category" in patch and patch["category"] is None:
        raise HTTPException(422, "Категорія обов'язкова")
    if final is not None:
        try:
            patch["purchase_price"] = purchase_from_final(final, patch.get("category", p.get("category")), markups)
        except ValueError as e:
            raise HTTPException(422, str(e))
    if "purchase_price" in patch:
        patch["purchase_price"] = money(D(patch["purchase_price"]))
        patch["usdt"] = None          # ручна ціна: USDT-джерело більше неактуальне
    if "custom_line" in patch:
        patch["custom_line"] = " ".join((patch["custom_line"] or "").split()) or None
    if "retail_markup" in patch:
        patch["retail_markup"] = money(D(patch["retail_markup"])) if patch["retail_markup"] is not None else None
    if "category" in patch:
        patch["category_label"] = CATEGORY_LABELS.get(patch["category"], "Не визначено")
    if "status" in patch:
        patch["status_label"] = {"in_stock": "В наявності", "expected": "Очікується на прибуття", "unavailable": "Немає в наявності"}[patch["status"]]
    merged = {**p, **patch}
    if {"category", "volume_ml", "nicotine_mg", "name"} & patch.keys():     # юридичний статус рахується заново
        merged["compliance"] = patch["compliance"] = classify(merged["category"], merged.get("volume_ml"), merged.get("nicotine_mg"), merged["name"])
    if {"name", "brand", "product_line"} & patch.keys():
        key = f"{merged['brand']}|{merged.get('product_line') or ''}|{merged['name'].lower()}"
        if db.products.find_one({"dedupe_key": key, "_id": {"$ne": p["_id"]}}):
            raise HTTPException(409, "Такий товар уже існує")
        patch["dedupe_key"] = key
    patch.update(reprice(merged, markups))     # завжди від закупівельної, не від final
    patch["updated_at"] = datetime.now(timezone.utc)
    if patch.get("images"):
        patch["needs_content"] = False
    db.products.update_one({"_id": p["_id"]}, {"$set": to_db(patch)})
    grouped = 0
    if apply_image_to_group and "images" in patch:     # фото в магазині спільне для лінійки (рідини) або моделі (под-системи)
        gf = None
        if merged.get("category") == "liquid" and merged.get("product_line"):
            gf = {"category": "liquid", "brand": merged["brand"], "product_line": merged["product_line"]}
        elif merged.get("category") == "pod" and merged.get("model"):
            gf = {"category": "pod", "brand": merged["brand"], "model": merged["model"]}
        if gf:
            grouped = db.products.update_many({**gf, "_id": {"$ne": p["_id"]}},
                                              {"$set": {"images": patch["images"], "needs_content": False, "updated_at": patch["updated_at"]}}).modified_count
    invalidate_catalog()
    audit(db, admin, "product.update", {"id": pid, "fields": [k for k in patch if k != "updated_at"], "group_images": grouped})
    fresh = db.products.find_one({"_id": p["_id"]})
    entry = devblog.change_entry(p, load(fresh), note=f"Фото застосовано ще до {grouped} поз. лінійки/моделі" if grouped else "")
    if entry:
        devblog.publish(changed=[entry], source="Зміна товару", actor=admin, bg=bg)
    out = public(fresh)
    out["group_updated"] = grouped
    return out


@router.delete("/products/{pid}")
def delete_product(pid: str, bg: BackgroundTasks, confirm: bool = False, db=Depends(get_db), admin=Depends(current_admin)):
    if not confirm:
        raise HTTPException(400, "Потрібне підтвердження (confirm=true)")
    gone = db.products.find_one({"_id": _oid(pid)})
    if gone:
        photo_archive.remember(db, [load(gone)])    # фото не втрачаються: повернуться, коли товар зʼявиться знову
    r = db.products.delete_one({"_id": _oid(pid)})
    if not r.deleted_count:
        raise HTTPException(404, "Товар не знайдено")
    invalidate_catalog()
    audit(db, admin, "product.delete", {"id": pid})
    if gone:
        devblog.publish(removed=[devblog.snapshot(load(gone), archived=True)], source="Видалення товару", actor=admin, bg=bg)
    return {"deleted": True}


@router.get("/media/{name}")
def media(name: str, _=Depends(current_admin)):
    f = (settings.images_dir / name).resolve()
    if f.parent != settings.images_dir.resolve() or not f.is_file():
        raise HTTPException(404)
    return FileResponse(f)
