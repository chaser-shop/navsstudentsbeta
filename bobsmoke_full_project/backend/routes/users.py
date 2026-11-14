"""Користувачі бота / Mini App для dashboard: реєстрація, останній візит, активний кошик, замовлення."""
import threading
from datetime import timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth.security import audit, current_admin
from ..database import get_db, load
from ..services import user_sync
from .bot import _view

router = APIRouter(prefix="/api/users", tags=["users"])


def _iso(d):
    return d.replace(tzinfo=timezone.utc).isoformat() if d else None


@router.get("")
def list_users(q: str = "", limit: int = Query(300, ge=1, le=1000), db=Depends(get_db), _=Depends(current_admin)):
    users = list(db.users.find({}).sort("last_seen_at", -1).limit(limit))
    ids = [u["_id"] for u in users]
    carts = {c["_id"]: c for c in db.carts.find({"_id": {"$in": ids}}) if c.get("items")}
    stats: dict = {}
    for o in db.orders.find({"customer.tg_id": {"$in": ids}}, {"customer.tg_id": 1, "total": 1}):
        o = load(o)
        s = stats.setdefault(o["customer"]["tg_id"], {"n": 0, "sum": 0.0})
        s["n"] += 1; s["sum"] += float(o["total"])
    out, needle = [], q.strip().lower().lstrip("@")
    for u in users:
        name = " ".join(x for x in (u.get("first_name"), u.get("last_name")) if x) or "Без імені"
        if needle and needle not in f"{name} {u.get('username', '')} {u['_id']}".lower():
            continue
        cart = None
        if u["_id"] in carts:
            v = _view(db, carts[u["_id"]])
            items = [{"name": i["name"], "qty": i["qty"], "price": float(i["unit_price"] or 0)} for i in v["items"]]
            if items:
                cart = {"items": items, "total": sum(i["price"] * i["qty"] for i in items),
                        "updated_at": _iso(carts[u["_id"]].get("updated_at"))}
        st = stats.get(u["_id"], {"n": 0, "sum": 0.0})
        out.append({"id": u["_id"], "name": name, "username": u.get("username") or "",
                    "registered_at": _iso(u.get("registered_at")), "last_seen_at": _iso(u.get("last_seen_at")),
                    "orders": st["n"], "orders_sum": st["sum"], "cart": cart})
    return {"users": out}


@router.get("/sync")
def sync_state(db=Depends(get_db), _=Depends(current_admin)):
    """Стан перевірки «хто заблокував бота»: running / done / error + скільки перевірено й видалено."""
    return user_sync.state(db)


@router.post("/sync", status_code=202)
def sync_start(db=Depends(get_db), admin=Depends(current_admin)):
    """Запускає перевірку всіх користувачів у фоні: заблокованих видаляє зі списку."""
    if user_sync.state(db).get("status") == "running":
        raise HTTPException(409, "Перевірка вже триває")
    audit(db, admin, "users.sync", {})
    threading.Thread(target=user_sync.run, args=(db,), daemon=True, name="user-sync-manual").start()
    return {"ok": True}
