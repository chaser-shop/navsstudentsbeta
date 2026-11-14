"""Промокоди в dashboard: створити, вимкнути/увімкнути, видалити. Персональні коди рефералки тут не показуються."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from ..auth.security import audit, current_admin
from ..database import get_db, public
from ..models.schemas import PromoActiveIn, PromoCodeIn
from ..services import promo as svc

router = APIRouter(prefix="/api/promo", tags=["promo"])


def _view(doc: dict) -> dict:
    d = public(doc)
    d.pop("used_by", None)
    return d


@router.get("")
def list_codes(db=Depends(get_db), _=Depends(current_admin)):
    rows = db.promo_codes.find({"kind": "manual"}).sort("created_at", -1).limit(200)
    return {"items": [_view(r) for r in rows]}


@router.post("", status_code=201)
def create(body: PromoCodeIn, db=Depends(get_db), admin=Depends(current_admin)):
    expires = None
    if body.expires:
        try:
            d = datetime.strptime(body.expires, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(422, "Дата у форматі РРРР-ММ-ДД")
        expires = d.replace(hour=23, minute=59, second=59, tzinfo=timezone.utc)      # діє весь останній день
    try:
        doc = svc.create_code(db, percent=body.percent, code=(body.code or "").strip() or None, max_uses=body.max_uses,
                              expires_at=expires, prefix="PROMO")
    except svc.PromoError as e:
        raise HTTPException(422, str(e))
    audit(db, admin, "promo.create", {"code": doc["_id"], "percent": str(doc["percent"])})
    return _view(doc)


@router.patch("/{code}")
def set_active(code: str, body: PromoActiveIn, db=Depends(get_db), admin=Depends(current_admin)):
    r = db.promo_codes.update_one({"_id": code.upper(), "kind": "manual"}, {"$set": {"active": body.active}})
    if not r.matched_count:
        raise HTTPException(404, "Промокод не знайдено")
    audit(db, admin, "promo.active", {"code": code.upper(), "active": body.active})
    return {"ok": True}


@router.delete("/{code}")
def delete(code: str, db=Depends(get_db), admin=Depends(current_admin)):
    r = db.promo_codes.delete_one({"_id": code.upper(), "kind": "manual"})
    if not r.deleted_count:
        raise HTTPException(404, "Промокод не знайдено")
    audit(db, admin, "promo.delete", {"code": code.upper()})
    return {"ok": True}
