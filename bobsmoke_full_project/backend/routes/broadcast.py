"""Розсилка з dashboard: текст із форматуванням (+ фото та файли) -> усім користувачам бота. Відправка у фоні, прогрес читається опитуванням."""
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel, Field

from ..auth.security import audit, current_admin
from ..config import settings
from ..database import get_db, public
from ..services import broadcast as bc
from ..services.images import ATTACH_MAX_BYTES, ImageError, prepare_attachment
from ..services.telegram_api import tg_call

router = APIRouter(prefix="/api/broadcast", tags=["broadcast"])


class BroadcastIn(BaseModel):
    text: str = Field(default="", max_length=12000)       # може бути порожнім, якщо є вкладення
    button: bool = False                 # кнопка «Відкрити магазин» під повідомленням
    attachments: list[str] = Field(default_factory=list, max_length=bc.MAX_ATTACH)   # id файлів з /attachments


def _prepare(body: BroadcastIn, db) -> tuple[str, dict | None, list[dict]]:
    try:
        clean = bc.clean_html(body.text, allow_empty=True)
        files = bc.load_attachments(db, body.attachments)
        bc.check_plan(clean, len(files), body.button)
    except bc.FormatError as e:
        raise HTTPException(422, str(e))
    markup = None
    if body.button:
        from bot import shop_bot
        url = shop_bot.app_url()
        if not url:
            raise HTTPException(422, "Кнопку не можна додати: PUBLIC_URL не задано")
        markup = shop_bot._open_markup(url)
    return clean, markup, files


def _view(d: dict) -> dict:
    v = public(d)
    v.pop("attachments", None)
    done = (v.get("sent") or 0) + (v.get("failed") or 0) + (v.get("blocked") or 0)
    v["done"] = done
    v["percent"] = round(100 * done / v["total"]) if v.get("total") else 100
    return v


@router.post("/attachments", status_code=201)
async def upload_attachment(file: UploadFile, db=Depends(get_db), admin=Depends(current_admin)):
    """Фото (JPG/PNG/WebP) або будь-який файл до 15 МБ. Зберігається до відправки, після розсилки видаляється."""
    raw = await file.read(ATTACH_MAX_BYTES + 1)
    try:
        item = prepare_attachment(raw, file.filename or "file")
    except ImageError as e:
        raise HTTPException(422, str(e))
    doc = bc.save_attachment(db, item)
    audit(db, admin, "broadcast.attach", {"name": doc["name"], "bytes": doc["size"]})
    return {"id": doc["_id"], "name": doc["name"], "kind": doc["kind"], "size": doc["size"]}


@router.delete("/attachments/{aid}")
def delete_attachment(aid: str, db=Depends(get_db), _=Depends(current_admin)):
    db.broadcast_files.delete_one({"_id": aid, "broadcast": None})      # вже запущеної розсилки не чіпаємо
    return {"ok": True}


@router.get("")
def overview(db=Depends(get_db), _=Depends(current_admin)):
    ids, flagged = bc.recipients(db)
    cur = bc.active(db)
    hist = list(db.broadcasts.find({}, {"text": 0}).sort("created_at", -1).limit(20))
    return {"recipients": len(ids), "blocked": len(flagged), "active": _view(cur) if cur else None,
            "history": [_view(h) for h in hist]}


@router.post("", status_code=201)
def send_all(body: BroadcastIn, db=Depends(get_db), admin=Depends(current_admin)):
    clean, markup, files = _prepare(body, db)
    if bc.active(db):
        raise HTTPException(409, "Попередня розсилка ще виконується: дочекайтесь завершення або скасуйте її")
    ids, _ = bc.recipients(db)
    if not ids:
        raise HTTPException(422, "У боті ще немає зареєстрованих користувачів")
    doc = bc.create(db, clean, admin, len(ids), body.button, files)
    bc.attach_to(db, [f["_id"] for f in files], doc["_id"])
    audit(db, admin, "broadcast.start", {"id": doc["_id"], "total": len(ids)})
    bc.start(db, doc["_id"], markup)
    return _view(doc)


@router.post("/test")
def send_test(body: BroadcastIn, db=Depends(get_db), admin=Depends(current_admin)):
    """Пробне повідомлення лише операторам (BOT_ALLOWED_IDS): перевірити вигляд перед розсилкою всім."""
    clean, markup, files = _prepare(body, db)
    targets = sorted(settings.operator_ids)
    if not targets:
        raise HTTPException(422, "У BOT_ALLOWED_IDS немає жодного Telegram ID: нікуди надсилати тест")
    media = bc.Media(files) if files else None
    ok, errors = 0, []
    for uid in targets:
        res = bc.deliver(tg_call, uid, clean, media, markup)
        if res.get("ok"):
            ok += 1
        else:
            errors.append(res.get("description") or "помилка Telegram")
    if not ok:
        raise HTTPException(502, f"Тест не доставлено: {errors[0]}. Відкрийте бота й натисніть /start")
    return {"sent": ok, "errors": errors}


@router.get("/{bid}")
def progress(bid: str, db=Depends(get_db), _=Depends(current_admin)):
    d = db.broadcasts.find_one({"_id": bid})
    if not d:
        raise HTTPException(404, "Розсилку не знайдено")
    return _view(d)


@router.post("/{bid}/cancel")
def cancel(bid: str, db=Depends(get_db), admin=Depends(current_admin)):
    r = db.broadcasts.update_one({"_id": bid, "status": "running"}, {"$set": {"status": "cancelling"}})
    if not r.modified_count:
        raise HTTPException(409, "Розсилка вже завершена")
    audit(db, admin, "broadcast.cancel", {"id": bid})
    return {"ok": True}
