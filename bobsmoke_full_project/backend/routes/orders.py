import logging
import re
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from ..auth.security import audit, current_admin
from ..database import get_db, load, public
from ..models.schemas import NoteIn, OrderIn, StatusIn
from ..services import orders as svc, referral
from ..services.order_messages import deliver_order
from ..services.receipt import render_receipt
from ..services.shop_settings import get_discount_tiers, get_shop
from ..services.telegram_api import tg_call

router = APIRouter(prefix="/api/orders", tags=["orders"])


@router.get("")
def list_orders(number: str = "", status: str = "", active: bool = False, date_from: str = "", date_to: str = "",
                page: int = Query(1, ge=1), db=Depends(get_db), _=Depends(current_admin)):
    f: dict = {}
    if number:
        f["number"] = {"$regex": re.escape(number.strip()), "$options": "i"}
    if status:
        f["status"] = status
    elif active:
        f["status"] = {"$in": svc.ACTIVE_STATUSES}
    try:
        rng = {}
        if date_from:
            rng["$gte"] = datetime.fromisoformat(date_from)
        if date_to:
            rng["$lt"] = datetime.fromisoformat(date_to) + timedelta(days=1)
    except ValueError:
        raise HTTPException(422, "Дата у форматі YYYY-MM-DD")
    if rng:
        f["created_at"] = rng
    items = list(db.orders.find(f).sort("created_at", -1).skip((page - 1) * 30).limit(30))
    svc.fill_display_names(db, items)
    return {"items": [public(i) for i in items], "total": db.orders.count_documents(f),
            "statuses": svc.STATUS_LABELS,
            "active_count": db.orders.count_documents({"status": {"$in": svc.ACTIVE_STATUSES}})}


@router.post("", status_code=201)
def create(body: OrderIn, db=Depends(get_db), admin=Depends(current_admin)):
    try:
        o = svc.create_order(db, {"name": body.customer_name, "contact": body.contact, "phone": body.phone,
                              "delivery": body.delivery.model_dump() if body.delivery else None},
                             [i.model_dump() for i in body.items], admin,
                             discount_tiers=get_discount_tiers(db))
    except svc.OrderError as e:
        raise HTTPException(422, str(e))
    audit(db, admin, "order.create", {"number": o["number"]})
    return public(o)


@router.patch("/{number}/status")
def status(number: str, body: StatusIn, db=Depends(get_db), admin=Depends(current_admin)):
    before = db.orders.find_one({"number": number}, {"status": 1})
    try:
        o = svc.set_status(db, number, body.status, body.reason, admin)
    except svc.OrderError as e:
        raise HTTPException(422, str(e))
    if not o:
        raise HTTPException(404, "Замовлення не знайдено")
    audit(db, admin, "order.status", {"number": number, "status": body.status})
    notified = None                          # None = не надсилали (немає Telegram-клієнта, вимкнено або статус не змінився)
    tg_id = (o.get("customer") or {}).get("tg_id")
    text = svc.customer_message(number, body.status, body.reason)
    if body.notify and text and isinstance(tg_id, int) and tg_id > 0 and (before or {}).get("status") != body.status:
        notified = bool(tg_call("sendMessage", {"chat_id": tg_id, "text": text}).get("ok"))
    if body.status == "done" and (before or {}).get("status") != "done":
        try:                                 # перше виконане замовлення запрошеного друга -> промокод тому, хто запросив
            referral.reward_on_done(db, load(o))
        except Exception:
            logging.getLogger("referral").exception("Не вдалося видати реферальну нагороду за %s", number)
    return {**public(o), "notified": notified}


@router.post("/{number}/notes")
def note(number: str, body: NoteIn, db=Depends(get_db), admin=Depends(current_admin)):
    try:
        o = svc.add_note(db, number, body.text, admin)
    except svc.OrderError as e:
        raise HTTPException(422, str(e))
    if not o:
        raise HTTPException(404, "Замовлення не знайдено")
    return public(o)


@router.get("/{number}/receipt.png")
def receipt(number: str, db=Depends(get_db), _=Depends(current_admin)):
    """Чек замовлення (той самий, що отримує покупець) для перегляду в dashboard."""
    o = db.orders.find_one({"number": number})
    if not o:
        raise HTTPException(404, "Замовлення не знайдено")
    return Response(render_receipt(load(o), get_shop(db)), media_type="image/png", headers={"Cache-Control": "no-store"})


@router.post("/{number}/resend")
def resend(number: str, db=Depends(get_db), admin=Depends(current_admin)):
    """Повторно надіслати покупцю подяку з реквізитами та чек (напр., якщо змінили номер картки)."""
    if not db.orders.find_one({"number": number}, {"_id": 1}):
        raise HTTPException(404, "Замовлення не знайдено")
    r = deliver_order(db, number)
    audit(db, admin, "order.resend", {"number": number})
    if not r.get("ok"):
        raise HTTPException(502, "Не вдалося надіслати повідомлення покупцю (можливо, він заблокував бота)")
    return r
