from datetime import datetime, timezone

from bson import ObjectId
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pymongo import UpdateOne

from ..auth.security import audit, current_admin
from ..database import get_db, load, to_db
from ..models.schemas import LineAssignIn, LinePriceIn
from ..services import devblog, lines as ln
from ..services.orders import RETAIL_EXEMPT
from ..services.shop_settings import get_retail_markup
from .pricing import get_markups
from .shop import invalidate_catalog

router = APIRouter(prefix="/api/lines", tags=["lines"])


def _docs(db):
    return [load(p) for p in db.products.find({})]


@router.get("")
def list_lines(db=Depends(get_db), _=Depends(current_admin)):
    general = get_retail_markup(db)
    return {"lines": ln.summarize(_docs(db), general, RETAIL_EXEMPT), "retail_markup": general}


@router.post("/price")
def change_price(body: LinePriceIn, bg: BackgroundTasks, db=Depends(get_db), admin=Depends(current_admin)):
    """Опт і/або роздріб для всієї лінійки одразу. dry_run=true — лише показати, що зміниться."""
    docs = [p for p in _docs(db) if ln.line_of(p)[0] == body.line_key]
    if not docs:
        raise HTTPException(404, "Лінійку не знайдено")
    name = ln.line_of(docs[0])[1]
    plan = ln.plan_prices(docs, body.wholesale.model_dump() if body.wholesale else None,
                          body.retail.model_dump() if body.retail else None, body.reset_retail,
                          get_markups(db), get_retail_markup(db), RETAIL_EXEMPT)
    view = {"line": name, "total": len(docs), "affected": len(plan["changes"]), "unchanged": plan["unchanged"],
            "errors": plan["errors"][:20], "changes": [{k: c[k] for k in ("id", "name", "old", "new")} for c in plan["changes"][:200]]}
    if body.dry_run:
        return view
    if plan["errors"]:
        e = plan["errors"][0]
        raise HTTPException(422, f"Нічого не змінено. «{e['name']}»: {e['reason']} (усього проблем: {len(plan['errors'])})")
    now = datetime.now(timezone.utc)
    if plan["changes"]:
        db.products.bulk_write([UpdateOne({"_id": ObjectId(c["id"])}, {"$set": to_db({**c["patch"], "updated_at": now})}) for c in plan["changes"]])
        invalidate_catalog()
    audit(db, admin, "line.price", {"line": name, "key": body.line_key, "updated": len(plan["changes"])})
    one = lambda k, side: next(iter({c[side][k] for c in plan["changes"]}), None) if len({c["new"][k] for c in plan["changes"]}) == 1 else "різні"
    diffs = [(lbl, "різні" if len({c["old"][k] for c in plan["changes"]}) > 1 else plan["changes"][0]["old"][k], one(k, "new"))
             for k, lbl, on in (("wholesale", "Опт", body.wholesale), ("retail", "Роздріб", body.retail or body.reset_retail)) if on and plan["changes"]]
    if plan["changes"]:
        devblog.publish(changed=[{"name": f"Лінійка «{name}»", "brand": "", "line": "", "diffs": diffs, "note": f"{len(plan['changes'])} поз."}],
                        source="Групова зміна цін", actor=admin, bg=bg)
    return {**view, "updated": len(plan["changes"])}


@router.post("/assign")
def assign(body: LineAssignIn, db=Depends(get_db), admin=Depends(current_admin)):
    """Додає вибрані товари (будь-якої категорії) до лінійки. Порожня назва прибирає власну лінійку."""
    try:
        oids = [ObjectId(i) for i in body.ids]
    except Exception:
        raise HTTPException(422, "Некоректні товари")
    line = " ".join((body.line or "").split()) or None
    r = db.products.update_many({"_id": {"$in": oids}}, {"$set": {"custom_line": line, "updated_at": datetime.now(timezone.utc)}})
    invalidate_catalog()
    audit(db, admin, "line.assign", {"line": line, "count": r.matched_count})
    return {"updated": r.matched_count, "line": line}
