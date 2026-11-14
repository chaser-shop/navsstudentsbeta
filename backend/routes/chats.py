"""Чат менеджера з покупцями в dashboard. Повідомлення покупців зберігає вебхук бота (bot/shop_bot.py), тут їх читають і відповідають."""
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field

from ..auth.security import audit, current_admin
from ..database import get_db, load, public
from ..services import chat
from ..services.telegram_api import tg_call, tg_download

router = APIRouter(prefix="/api/chats", tags=["chats"])


class MessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


def _name(db, tg_id: int, st: dict | None = None) -> dict:
    u = db.users.find_one({"_id": tg_id}) or {}
    name = " ".join(x for x in (u.get("first_name"), u.get("last_name")) if x) or (st or {}).get("name") or "Без імені"
    return {"name": name, "username": u.get("username") or (st or {}).get("username") or ""}


@router.get("")
def list_chats(limit: int = Query(200, ge=1, le=500), db=Depends(get_db), _=Depends(current_admin)):
    rows = list(db.chats.find({}).sort("last_at", -1).limit(limit))
    out = [{"id": r["_id"], **_name(db, r["_id"], r), "last_text": r.get("last_text", ""), "last_dir": r.get("last_dir", ""),
            "last_at": public(r.get("last_at")), "unread": int(r.get("unread") or 0)} for r in rows]
    return {"chats": out, "unread": sum(c["unread"] for c in out)}


@router.get("/{tg_id}")
def thread(tg_id: int, db=Depends(get_db), _=Depends(current_admin)):
    """Історія переписки; відкриття чату позначає його прочитаним."""
    st = db.chats.find_one({"_id": tg_id})
    if not st:
        raise HTTPException(404, "Чат не знайдено")
    # останні 500 повідомлень у хронологічному порядку; _id розв'язує однакові «at» у порядку запису
    msgs = list(db.messages.find({"tg_id": tg_id}).sort([("at", -1), ("_id", -1)]).limit(500))[::-1]
    db.chats.update_one({"_id": tg_id}, {"$set": {"unread": 0}})
    orders = []
    for o in db.orders.find({"customer.tg_id": tg_id}).sort("created_at", -1).limit(5):
        o = load(o)
        orders.append({"number": o["number"], "total": float(o["total"]), "status": o["status"], "created_at": public(o["created_at"]),
                       "payment": (o.get("payment") or {}).get("label", "")})
    return {"id": tg_id, **_name(db, tg_id, st), "orders": orders,
            "messages": [{"id": str(m["_id"]), "dir": m["dir"], "text": m.get("text", ""), "kind": m.get("kind", "text"),
                          "by": m.get("by", ""), "at": public(m["at"]), "photo": bool((m.get("media") or {}).get("file_id"))} for m in msgs]}


@router.post("/{tg_id}/messages", status_code=201)
def send(tg_id: int, body: MessageIn, db=Depends(get_db), admin=Depends(current_admin)):
    if not db.chats.find_one({"_id": tg_id}) and not db.users.find_one({"_id": tg_id}):
        raise HTTPException(404, "Покупця не знайдено")
    text = body.text.strip()
    if not text:
        raise HTTPException(422, "Порожнє повідомлення")
    res = tg_call("sendMessage", {"chat_id": tg_id, "text": text})
    if not res.get("ok"):
        raise HTTPException(502, f"Telegram не доставив повідомлення: {res.get('description') or 'невідома помилка'}")
    chat.log_message(db, tg_id, "out", text, tg_message_id=(res.get("result") or {}).get("message_id"), by=admin)
    audit(db, admin, "chat.send", {"tg_id": tg_id})
    return {"ok": True}


@router.get("/{tg_id}/photo/{message_id}")
def photo(tg_id: int, message_id: str, db=Depends(get_db), _=Depends(current_admin)):
    """Фото від покупця (скріншот оплати тощо). Віддаються лише файли, що є в переписці з цим покупцем."""
    from bson import ObjectId
    try:
        m = db.messages.find_one({"_id": ObjectId(message_id), "tg_id": tg_id})
    except Exception:
        m = None
    fid = ((m or {}).get("media") or {}).get("file_id")
    if not fid:
        raise HTTPException(404, "Файл не знайдено")
    got = tg_download(fid)
    if not got:
        raise HTTPException(502, "Не вдалося завантажити файл із Telegram")
    return Response(got[0], media_type=got[1], headers={"Cache-Control": "private, max-age=3600"})
