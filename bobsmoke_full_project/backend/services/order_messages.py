"""Повідомлення покупцю після оформлення: подяка з реквізитами + чек (PNG) відповіддю під цим же повідомленням."""
import html
import logging
import re

from . import chat
from .pricing import money
from .receipt import fmt, render_receipt
from .telegram_api import notify_operators, tg_call, tg_send_photo

log = logging.getLogger("order_messages")

# Висота, вище якої Telegram надто стискає фото; тоді чек іде файлом (без втрати чіткості)
MAX_PHOTO_HEIGHT = 3200


def _m(v) -> str:
    return f"{fmt(v)} ₴"


def plain_text(text: str) -> str:
    """Прибирає HTML-теги Telegram (b, code, tg-spoiler) для історії чату в dashboard."""
    return html.unescape(re.sub(r"</?(?:b|i|u|s|code|pre|tg-spoiler)>", "", text))


def thanks_text(order: dict, shop: dict) -> str:
    """HTML-текст для sendMessage (parse_mode=HTML): жирні заголовки/суми, номер замовлення під спойлером,
    номер картки в <code> (у Telegram його можна скопіювати одним дотиком)."""
    esc = html.escape
    method = (order.get("payment") or {}).get("method", "cod")
    total = money(order["total"])
    card = (shop.get("payment_card") or "").strip()
    manager = esc(shop.get("manager") or "")
    name = esc(shop.get("shop_name") or "Bob Smoke")
    where = f"на карту <code>{esc(card)}</code>" if card else "за реквізитами, які надішле менеджер у цей чат"
    if method == "prepaid":
        pay = (f"Вам необхідно оплатити замовлення повністю — <b>{_m(total)}</b> {where}.\n"
               f"Після оплати надішліть, будь ласка, скріншот переказу в цей чат.")
    elif shop.get("prepay_enabled"):
        prepay = money((order.get("payment") or {}).get("prepay_amount") or shop.get("prepay") or 100)
        pay = f"Вам необхідно відправити предоплату <b>{_m(prepay)}</b> {where}, та прикріпити чек в цей чат."
    else:                                          # накладений платіж без передоплати: переказувати нічого не потрібно
        pay = "Оплата замовлення — при отриманні на Новій пошті."
    return (f"<b>Дякую за замовлення</b> <tg-spoiler>№{esc(str(order['number']))}</tg-spoiler>\n"
            f"До оплати : <b>{_m(total)}</b>\n\n"
            f"🚚 Доставка Новою поштою\n"
            f"{pay}\n"
            f"Доставка <b>Новою поштою:</b>\n"
            f"Менеджер обробить замовлення та надішле деталі відправки вам в цей чат повідомлення.\n\n"
            f"Після відправлення ви отримаєте ТТН для відстеження посилки 📦\n\n"
            f"Якщо у вас виникнуть питання — просто напишіть менеджеру {manager} 💬\n"
            f"<b>Дякуємо, що обираєте {name}💨</b>")


def deliver_order(db, number: str, call=tg_call, send_photo=tg_send_photo) -> dict:
    """Надсилає покупцю подяку, а під нею (reply) — чек. Помилки не падають у користувача: логуються, оператори отримують сповіщення."""
    from ..database import load
    from .shop_settings import get_shop
    raw = db.orders.find_one({"number": number})
    if not raw:
        return {"ok": False, "error": "order not found"}
    order = load(raw)
    tg_id = (order.get("customer") or {}).get("tg_id")
    if not isinstance(tg_id, int) or tg_id <= 0:
        return {"ok": False, "error": "no telegram id"}
    shop = get_shop(db)
    result = {"ok": False, "message": False, "receipt": False}

    text = thanks_text(order, shop)
    res = call("sendMessage", {"chat_id": tg_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True})
    if not res.get("ok"):
        log.warning("Подяку не доставлено %s: %s", number, res.get("description"))
        notify_operators(f"⚠️ Не вдалося надіслати покупцю повідомлення про замовлення {number}: {res.get('description')}", call=call)
        return result
    msg_id = (res.get("result") or {}).get("message_id")
    result["message"] = True
    chat.log_message(db, tg_id, "out", plain_text(text), kind="order", tg_message_id=msg_id)

    try:
        png = render_receipt(order, shop)
        from PIL import Image
        import io
        h = Image.open(io.BytesIO(png)).height
        sent = send_photo(tg_id, png, reply_to=msg_id, as_document=h > MAX_PHOTO_HEIGHT, filename=f"{number}.png")
        result["receipt"] = bool(sent.get("ok"))
        if not sent.get("ok"):
            raise RuntimeError(sent.get("description") or "sendPhoto failed")
        chat.log_message(db, tg_id, "out", f"Чек {number}", kind="receipt", tg_message_id=(sent.get("result") or {}).get("message_id"))
    except Exception as e:                  # чек не вдався — замовлення все одно прийняте
        log.exception("Чек %s не надіслано", number)
        notify_operators(f"⚠️ Чек для замовлення {number} не надіслано покупцю: {e}", call=call)
    result["ok"] = result["message"]
    db.orders.update_one({"number": number}, {"$set": {"customer_notified": {"message": result["message"], "receipt": result["receipt"]}}})
    needs_card = (order.get("payment") or {}).get("method") == "prepaid" or shop.get("prepay_enabled")
    if needs_card and not shop.get("payment_card"):
        notify_operators("⚠️ У dashboard не вказано номер картки (Налаштування → Оплата): покупцям не показується, куди платити.", call=call)
    return result
