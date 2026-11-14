"""Оновлення наявності з Excel, який адміністратор завантажує в dashboard.

Потік: завантаження .xlsx -> порівняння з каталогом -> список пропозицій (зміна статусу / новий товар) ->
адміністратор кожну підтверджує або відхиляє. Без підтвердження в каталозі нічого не змінюється.
Пропозиції живуть у колекції sync_sessions (остання завантажена таблиця), тож після перезавантаження сторінки
можна продовжити з того ж місця.
"""
import uuid
from datetime import datetime, timezone
from decimal import InvalidOperation
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from pymongo.errors import DuplicateKeyError

from ..auth.security import audit, current_admin
from ..database import get_db, load, public, to_db
from ..services import devblog, photo_archive, sheet_sync as ss
from ..services.pricing import D, money
from .pricing import get_markups
from .shop import invalidate_catalog

router = APIRouter(prefix="/api/sync", tags=["sync"])

MAX_XLSX = 60 * 1024 * 1024       # прайси з вбудованими картинками важать 20–30 МБ; картинки при читанні ігноруються
PROJECTION = {"name": 1, "brand": 1, "product_line": 1, "model": 1, "category": 1, "status": 1, "images": 1,
              "image_scope": 1, "volume_ml": 1, "nicotine_mg": 1, "dedupe_key": 1, "internal.manual": 1}


def _build_items(plan: dict) -> list:
    items = []
    for i, u in enumerate(plan["updates"], 1):
        items.append({"id": f"s{i}", "kind": "status", "state": "pending", "product_id": u["id"], "name": u["name"],
                      "brand": u["brand"], "line": u["line"], "from": u["from"], "to": u["to"], "why": u["why"]})
    for i, (doc, info) in enumerate(zip(plan["inserts"], plan["new_info"]), 1):
        items.append({"id": f"n{i}", "kind": "new", "state": "pending", "name": info["name"], "brand": info["brand"],
                      "line": info["line"], "category": doc.get("category"), "price": info["price"],
                      "new_line": info["new_line"], "has_photo": info["has_photo"], "tab": info["tab"], "doc": doc})
    for i, m in enumerate(plan["manual"], 1):
        items.append({"id": f"m{i}", "kind": "manual", "state": "info", "name": m["name"], "line": m["line"],
                      "tab": m["tab"], "reason": m["why"], "price": m.get("price"), "status": m.get("status"),
                      "brand": m.get("brand"), "category": m.get("category")})
    return items


def _view(db, sess: dict) -> dict:
    v = public(sess)
    for it in v["items"]:
        it.pop("doc", None)
    manual = [it for it in v["items"] if it["kind"] == "manual"]
    if manual:                                       # позиції, які адмін уже додав кнопкою «Додати», показуємо як додані
        have: dict = {}
        for p in db.products.find({"name": {"$in": [it["name"] for it in manual]}}, {"name": 1, "product_line": 1}):
            have.setdefault(ss.norm_name(p["name"]), set()).add(ss.norm_name(p.get("product_line") or ""))
        for it in manual:
            lines = have.get(ss.norm_name(it["name"]))
            if lines and (not it.get("line") or ss.norm_name(it["line"]) in lines or "" in lines):
                it["state"] = "added"
    v["pending"] = sum(1 for it in v["items"] if it["state"] == "pending")
    v["lines"] = sorted(x for x in db.products.distinct("product_line", {"category": "liquid"}) if x)
    return v


# ---------- завантаження файлу та поточна сесія ----------
@router.post("/upload")
def upload(file: UploadFile = File(...), db=Depends(get_db), admin=Depends(current_admin)):
    name = file.filename or "table.xlsx"
    if not name.lower().endswith(".xlsx"):
        raise HTTPException(415, "Потрібен файл Excel у форматі .xlsx")
    data = file.file.read(MAX_XLSX + 1)
    if len(data) > MAX_XLSX:
        raise HTTPException(413, "Файл завеликий (понад 60 МБ). Збережіть таблицю без картинок і спробуйте ще раз")
    try:
        rows = ss.parse_workbook(data)
    except ss.SheetError as e:
        raise HTTPException(422, str(e))
    docs = [load(d) for d in db.products.find({}, PROJECTION)]
    plan = ss.plan_sync(rows, docs, get_markups(db))
    arch = photo_archive.lookup(db, [d.get("dedupe_key") for d in plan["inserts"]])
    for doc, info in zip(plan["inserts"], plan["new_info"]):     # раніше видалений товар повертається з фото
        if photo_archive.apply(doc, arch):
            info["has_photo"] = True
    sess = {"_id": uuid.uuid4().hex, "filename": name[:120], "created_at": datetime.now(timezone.utc),
            "created_by": admin, "warnings": plan["warnings"], "report": plan["report"], "items": _build_items(plan)}
    db.sync_sessions.delete_many({})                     # актуальна лише остання завантажена таблиця
    db.sync_sessions.insert_one(to_db(sess))
    audit(db, admin, "sync.upload", {"file": sess["filename"], **plan["report"]})
    return _view(db, sess)


@router.get("/session")
def current_session(db=Depends(get_db), _=Depends(current_admin)):
    sess = db.sync_sessions.find_one({}, sort=[("created_at", -1)])
    return {"session": _view(db, load(sess)) if sess else None}


@router.delete("/session/{sid}")
def discard_session(sid: str, db=Depends(get_db), _=Depends(current_admin)):
    db.sync_sessions.delete_one({"_id": sid})
    return {"deleted": True}


# ---------- рішення адміністратора ----------
class Decision(BaseModel):
    id: str = Field(max_length=20)
    action: Literal["approve", "reject"]
    line: str | None = Field(None, max_length=200)      # лише для нових товарів: лінійка, яку обрав адмін
    price: str | int | float | None = None              # лише для нових: ціна продажу, грн


class DecideIn(BaseModel):
    decisions: list[Decision] = Field(min_length=1, max_length=500)


def _claim(db, sid: str, iid: str) -> bool:
    """Захоплює позицію (pending -> working): подвійний клік чи два вікна не застосують її двічі."""
    r = db.sync_sessions.update_one({"_id": sid, "items": {"$elemMatch": {"id": iid, "state": "pending"}}},
                                    {"$set": {"items.$.state": "working"}})
    return r.modified_count == 1


def _set_state(db, sid: str, iid: str, state: str, note: str | None = None) -> None:
    s = {"items.$.state": state}
    if note:
        s["items.$.note"] = note
    db.sync_sessions.update_one({"_id": sid, "items.id": iid}, {"$set": s})


def _apply_status(db, it: dict, now) -> tuple:
    p = db.products.find_one({"_id": it["product_id"]}, {"status": 1})
    if not p:
        return "stale", "Товар уже видалено з каталогу"
    if p.get("status") == it["to"]:
        return "approved", "У каталозі вже такий статус"
    if p.get("status") != it["from"]:
        return "stale", "Статус у каталозі змінився після завантаження файлу"
    db.products.update_one({"_id": it["product_id"], "status": it["from"]}, {"$set": {
        "status": it["to"], "status_label": ss.STATUS_LABELS[it["to"]], "updated_at": now, "sheet_synced_at": now}})
    return "approved", None


def _apply_new(db, it: dict, dec: Decision, markups: dict, index: dict, now, admin: str, out: dict | None = None) -> tuple:
    final = None
    if dec.price not in (None, ""):
        try:
            final = money(D(str(dec.price).replace(",", ".").replace(" ", "")))
        except (InvalidOperation, ValueError, ArithmeticError):
            raise ValueError("Некоректна ціна")
        if final < 0:
            raise ValueError("Ціна не може бути від’ємною")
    new = ss.finalize_new(it["doc"], markups, line=dec.line, final=final, index=index)
    if new.get("category") == "liquid" and not new.get("product_line"):
        raise ValueError("Вкажіть лінійку")
    msg = "Такий товар уже є в цій лінійці: змініть лінійку або відхиліть"
    if db.products.find_one({"dedupe_key": new["dedupe_key"]}, {"_id": 1}):
        raise ValueError(msg)
    photo_archive.restore(db, [new])                     # фото з архіву, якщо адмін змінив лінійку й ключ збігся з видаленим товаром
    try:
        db.products.insert_one(to_db({**new, "created_at": now, "updated_at": now, "created_by": admin}))
    except DuplicateKeyError:
        raise ValueError(msg)
    if out is not None:
        out["doc"] = new                                 # для dev-blog: фінальна ціна/лінійка після правок адміна
    return "approved", None


@router.post("/session/{sid}/decide")
def decide(sid: str, body: DecideIn, bg: BackgroundTasks, db=Depends(get_db), admin=Depends(current_admin)):
    sess = db.sync_sessions.find_one({"_id": sid})
    if not sess:
        raise HTTPException(404, "Таблицю не знайдено: завантажте файл ще раз")
    by_id = {it["id"]: it for it in load(sess)["items"]}
    now = datetime.now(timezone.utc)
    markups, index = get_markups(db), None
    results, approved, rejected = [], [], 0
    blog_added, blog_changed = [], []
    for dec in body.decisions:
        it = by_id.get(dec.id)
        if not it or it["kind"] == "manual":
            results.append({"id": dec.id, "state": "error", "error": "Позицію не знайдено"})
            continue
        if not _claim(db, sid, it["id"]):
            results.append({"id": it["id"], "state": "error", "error": "Уже опрацьовано (оновіть сторінку)"})
            continue
        try:
            if dec.action == "reject":
                state, note = "rejected", None
            elif it["kind"] == "status":
                state, note = _apply_status(db, it, now)
                if state == "approved" and not note:     # note = «у каталозі вже такий статус»: нічого не змінилось
                    blog_changed.append({"name": it["name"], "brand": it.get("brand") or "", "line": it.get("line") or "",
                                         "diffs": [("Статус", devblog._status(it["from"]), devblog._status(it["to"]))], "note": ""})
            else:
                if index is None:
                    index = ss.line_index([load(d) for d in db.products.find({"product_line": {"$ne": None}}, PROJECTION)])
                made: dict = {}
                state, note = _apply_new(db, it, dec, markups, index, now, admin, out=made)
                if made.get("doc"):
                    blog_added.append(devblog.snapshot(load(made["doc"])))
        except ValueError as e:                          # помилку можна виправити (ціна, лінійка): позиція лишається в очікуванні
            _set_state(db, sid, it["id"], "pending")
            results.append({"id": it["id"], "state": "pending", "error": str(e)})
            continue
        except Exception:
            _set_state(db, sid, it["id"], "pending")
            raise
        _set_state(db, sid, it["id"], state, note)
        results.append({"id": it["id"], "state": state, "note": note})
        if state == "approved":
            approved.append(it["name"])
        elif state == "rejected":
            rejected += 1
    if approved:
        invalidate_catalog()
    if approved or rejected:
        audit(db, admin, "sync.decide", {"approved": len(approved), "rejected": rejected, "names": approved[:20]})
    devblog.publish(added=blog_added, changed=blog_changed, source=f"Оновлення з Excel · {sess.get('filename') or ''}".rstrip(" ·"),
                    actor=admin, bg=bg)
    left = db.sync_sessions.find_one({"_id": sid})
    pending = sum(1 for i in (left or {}).get("items", []) if i["state"] == "pending")
    return {"results": results, "pending": pending}
