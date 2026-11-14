"""Фото товарів. Завантажені фото зберігаються в MongoDB (колекція media), бо диск на Render не постійний.
Старі фото з imports/images віддаються з диска. Публічний GET /img/<файл>: ці фото й так бачить покупець."""
import re

from bson import Binary
from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from ..auth.security import audit, current_admin
from ..config import settings
from ..database import get_db
from ..services.images import MAX_BYTES, ImageError, process_upload

router = APIRouter(tags=["media"])
_NAME = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


@router.post("/api/media", status_code=201)
async def upload(file: UploadFile, db=Depends(get_db), admin=Depends(current_admin)):
    raw = await file.read(MAX_BYTES + 1)
    try:
        name, data = process_upload(raw)
    except ImageError as e:
        raise HTTPException(422, str(e))
    db.media.update_one({"_id": name}, {"$set": {"data": Binary(data), "type": "image/webp"}}, upsert=True)
    audit(db, admin, "media.upload", {"name": name, "bytes": len(data)})
    return {"name": name, "path": f"uploads/{name}", "url": f"/img/{name}"}


@router.get("/img/{name}")
def image(name: str, db=Depends(get_db)):
    if not _NAME.match(name):
        raise HTTPException(404)
    f = (settings.images_dir / name).resolve()
    if f.parent == settings.images_dir.resolve() and f.is_file():
        return FileResponse(f)
    doc = db.media.find_one({"_id": name})
    if not doc:
        raise HTTPException(404)
    return Response(bytes(doc["data"]), media_type=doc.get("type", "image/webp"))
