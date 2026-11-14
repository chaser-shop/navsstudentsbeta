"""Обробка завантажених фото: перевірка, зменшення, конвертація у WebP. Без залежностей від БД."""
import hashlib
import io
import mimetypes
import os
import re

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_BYTES = 8 * 1024 * 1024
MAX_SIDE = 1200
Image.MAX_IMAGE_PIXELS = 40_000_000


class ImageError(ValueError):
    pass


def process_upload(raw: bytes) -> tuple[str, bytes]:
    """-> (ім'я файлу '<hash>.webp', байти WebP)."""
    if not raw:
        raise ImageError("Порожній файл")
    if len(raw) > MAX_BYTES:
        raise ImageError("Файл завеликий (максимум 8 МБ)")
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ImageError("Це не зображення (дозволено JPG, PNG, WebP)")
    if im.format not in ("JPEG", "PNG", "WEBP"):
        raise ImageError("Дозволено лише JPG, PNG або WebP")
    im = ImageOps.exif_transpose(im)
    has_alpha = im.mode in ("RGBA", "LA") or "transparency" in im.info
    im = im.convert("RGBA" if has_alpha else "RGB")
    im.thumbnail((MAX_SIDE, MAX_SIDE))
    out = io.BytesIO()
    im.save(out, "WEBP", quality=85, method=4)
    data = out.getvalue()
    return hashlib.sha1(data).hexdigest()[:12] + ".webp", data


# ---------- вкладення розсилки ----------
ATTACH_MAX_BYTES = 15 * 1024 * 1024      # ліміт документа MongoDB 16 МБ
PHOTO_MAX_SIDE = 2560
PHOTO_MAX_BYTES = 10 * 1024 * 1024        # ліміт Telegram для sendPhoto


def safe_filename(name: str, default: str = "file") -> str:
    name = os.path.basename((name or "").replace("\\", "/"))
    name = re.sub(r"[\x00-\x1f\"<>|?*:]", "", name).strip(" .")
    return (name or default)[:100]


def prepare_attachment(raw: bytes, filename: str) -> dict:
    """Фото JPG/PNG/WebP -> стискається й надсилається як фото; усе інше -> документ як є.
    -> {kind: photo|document, name, mime, data}"""
    if not raw:
        raise ImageError("Порожній файл")
    if len(raw) > ATTACH_MAX_BYTES:
        raise ImageError("Файл завеликий (максимум 15 МБ)")
    name = safe_filename(filename)
    doc = {"kind": "document", "name": name, "mime": mimetypes.guess_type(name)[0] or "application/octet-stream", "data": raw}
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        return doc
    if im.format not in ("JPEG", "PNG", "WEBP"):
        return doc
    im = ImageOps.exif_transpose(im)
    w, h = im.size
    if max(w, h) > 20 * max(1, min(w, h)):       # Telegram не приймає фото з таким співвідношенням сторін
        return doc
    alpha = im.mode in ("RGBA", "LA") or "transparency" in im.info
    im = im.convert("RGBA" if alpha else "RGB")
    im.thumbnail((PHOTO_MAX_SIDE, PHOTO_MAX_SIDE))
    out = io.BytesIO()
    if alpha:
        im.save(out, "PNG", optimize=True)
        ext, mime = "png", "image/png"
    else:
        im.save(out, "JPEG", quality=88, optimize=True)
        ext, mime = "jpg", "image/jpeg"
    data = out.getvalue()
    if len(data) > PHOTO_MAX_BYTES:
        return doc
    stem = os.path.splitext(name)[0] or "photo"
    return {"kind": "photo", "name": f"{stem}.{ext}", "mime": mime, "data": data}
