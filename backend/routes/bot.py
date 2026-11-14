"""Кошики для Telegram-бота (колекція carts). Доступ лише з адмін-токеном."""
from datetime import datetime, timezone

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth.security import current_admin
from ..database import get_db, load, public
from ..models.schemas import OrderItemIn

router = APIRouter(prefix="/api/bot", tags=["bot"])


class CartIn(BaseModel):
    items: list[OrderItemIn] = Field(max_length=100)


def _view(db, doc):
    items = []
    for it in (doc or {}).get("items", []):
        try:
            p = db.products.find_one({"_id": ObjectId(it["product_id"])})
        except Exception:
            p = None
        if p:
            p = load(p)
            items.append({"product_id": it["product_id"], "qty": it["qty"], "name": p["name"], "brand": p["brand"],
                          "unit_price": p.get("final_price"), "status": p.get("status"),
                          "blocked": False})
    return public({"items": items})


@router.get("/cart/{tg_id}")
def get_cart(tg_id: int, db=Depends(get_db), _=Depends(current_admin)):
    return _view(db, db.carts.find_one({"_id": tg_id}))


@router.put("/cart/{tg_id}")
def put_cart(tg_id: int, body: CartIn, db=Depends(get_db), _=Depends(current_admin)):
    merged: dict = {}
    for i in body.items:
        merged[i.product_id] = min(1000, merged.get(i.product_id, 0) + i.qty)
    for pid in merged:
        try:
            p = db.products.find_one({"_id": ObjectId(pid)})
        except Exception:
            p = None
        if not p:
            raise HTTPException(404, "Товар не знайдено")
    doc = {"items": [{"product_id": k, "qty": v} for k, v in merged.items()], "updated_at": datetime.now(timezone.utc)}
    db.carts.update_one({"_id": tg_id}, {"$set": doc}, upsert=True)
    return _view(db, doc)
