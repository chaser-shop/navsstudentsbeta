"""Вебхук Telegram. Запит приймається лише з правильним секретним заголовком."""
import hmac
import logging

from fastapi import APIRouter, Body, HTTPException, Request

from bot import shop_bot

from ..services.telegram_api import webhook_token

router = APIRouter(tags=["telegram"])
log = logging.getLogger("telegram")


@router.post("/telegram/webhook")
def webhook(request: Request, update: dict = Body(...)):
    got = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
    if not hmac.compare_digest(got, webhook_token()):
        raise HTTPException(403, "Forbidden")
    try:
        shop_bot.handle_update(update)
    except Exception:                      # Telegram повторює запит при не-200, тому відповідаємо 200 і логуємо
        log.exception("Помилка обробки оновлення")
    return {"ok": True}
