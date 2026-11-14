"""Тонка обгортка над Telegram Bot API (requests). У тестах `post` підміняється."""
import hashlib
import logging

import requests

from ..config import settings

log = logging.getLogger("telegram")


def _post(url: str, payload: dict) -> dict:
    r = requests.post(url, json=payload, timeout=10)
    try:
        return r.json()
    except ValueError:
        return {"ok": False, "description": f"HTTP {r.status_code}"}


def _post_files(url: str, payload: dict, files: dict) -> dict:
    """multipart-запит (завантаження фото/файлів). Вкладені обʼєкти (reply_markup, media) передаються як JSON-рядки."""
    import json
    data = {k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v)) for k, v in payload.items()}
    r = requests.post(url, data=data, files=files, timeout=120)
    try:
        return r.json()
    except ValueError:
        return {"ok": False, "description": f"HTTP {r.status_code}"}


def tg_call(method: str, payload: dict | None = None, token: str | None = None, post=_post, files: dict | None = None) -> dict:
    """files = {поле: (імʼя, байти, mime)} — тоді запит іде як multipart (завантаження фото/файлів)."""
    token = token or settings.bot_token
    if not token:
        return {"ok": False, "description": "BOT_TOKEN не задано"}
    try:
        url = f"https://api.telegram.org/bot{token}/{method}"
        if files:
            return _post_files(url, payload or {}, files)
        return post(url, payload or {})
    except requests.RequestException as e:
        log.warning("Telegram %s: %s", method, e)
        return {"ok": False, "description": str(e)}


def webhook_token() -> str:
    """Секрет для заголовка X-Telegram-Bot-Api-Secret-Token (лише [0-9a-f], як вимагає Telegram)."""
    base = settings.webhook_secret or settings.bot_token
    return hashlib.sha256(("tgwh:" + base).encode()).hexdigest()


def notify_operators(text: str, call=tg_call, parse_mode: str | None = None) -> None:
    """Повідомлення операторам (BOT_ALLOWED_IDS). Помилки не зупиняють створення замовлення.
    parse_mode="HTML" — для оформлених повідомлень (dev-blog); такий текст не обрізаємо посеред тега."""
    for uid in sorted(settings.operator_ids):
        payload = {"chat_id": uid, "text": text[:4096] if parse_mode else text[:4000]}
        if parse_mode:
            payload.update(parse_mode=parse_mode, disable_web_page_preview=True)
        res = call("sendMessage", payload)
        if not res.get("ok"):
            log.warning("Не вдалося сповістити %s: %s", uid, res.get("description"))


def tg_send_photo(chat_id: int, png: bytes, caption: str = "", reply_to: int | None = None, as_document: bool = False,
                  filename: str = "receipt.png", token: str | None = None, post=None) -> dict:
    """Надсилає зображення (multipart). reply_to — id повідомлення, під яким має зʼявитися картинка."""
    import json
    token = token or settings.bot_token
    if not token:
        return {"ok": False, "description": "BOT_TOKEN не задано"}
    method, field = ("sendDocument", "document") if as_document else ("sendPhoto", "photo")
    data = {"chat_id": str(chat_id)}
    if caption:
        data["caption"] = caption[:1000]
    if reply_to:
        data["reply_parameters"] = json.dumps({"message_id": reply_to, "allow_sending_without_reply": True})
    try:
        r = (post or requests.post)(f"https://api.telegram.org/bot{token}/{method}", data=data,
                                    files={field: (filename, png, "image/png")}, timeout=30)
        return r.json()
    except (requests.RequestException, ValueError) as e:
        log.warning("Telegram %s: %s", method, e)
        return {"ok": False, "description": str(e)}


def tg_download(file_id: str, token: str | None = None) -> tuple[bytes, str] | None:
    """Завантажує файл, надісланий покупцем боту (скріншот оплати тощо). -> (байти, content-type) або None."""
    token = token or settings.bot_token
    info = tg_call("getFile", {"file_id": file_id}, token=token)
    path = (info.get("result") or {}).get("file_path") if info.get("ok") else None
    if not path:
        return None
    try:
        r = requests.get(f"https://api.telegram.org/file/bot{token}/{path}", timeout=30)
        r.raise_for_status()
    except requests.RequestException as e:
        log.warning("Telegram file: %s", e)
        return None
    ext = path.rsplit(".", 1)[-1].lower()
    return r.content, {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(ext, "application/octet-stream")
