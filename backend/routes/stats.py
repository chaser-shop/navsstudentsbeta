"""Статистика для dashboard (огляд) і вкладки «Аналітика». Лише читання.

Дні рахуються за часом магазину (Europe/Kyiv). Виручка = сума total замовлень, крім відхилених і скасованих.
Агрегація — у Python по обмежених датою вибірках із проєкцією (без $group, щоб так само працювало й на mongomock у тестах)."""
import math
import re
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException

from ..auth.security import current_admin
from ..database import get_db, load
from ..services.orders import ACTIVE_STATUSES, ORDER_TYPES, PAYMENT_LABELS, STATUS_LABELS, STATUSES
from ..services.pricing import CATEGORY_LABELS

router = APIRouter(prefix="/api/stats", tags=["stats"])

TZ_NAME = "Europe/Kyiv"
TZ = ZoneInfo(TZ_NAME)
CANCELLED = ["rejected", "cancelled"]
MAX_DAYS = 366
ZERO = Decimal("0")

_ANALYTICS_FIELDS = {"status": 1, "total": 1, "discount": 1, "profit": 1, "created_at": 1, "order_type": 1,
                     "payment.method": 1, "payment.label": 1, "promo": 1,
                     "customer.tg_id": 1, "customer.name": 1, "customer.tg_username": 1,
                     "items.product_id": 1, "items.name": 1, "items.display_name": 1, "items.title": 1, "items.brand": 1,
                     "items.category": 1, "items.qty": 1, "items.line_total": 1, "items.profit": 1}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def utc(d: datetime) -> datetime:
    """pymongo (tz_aware) віддає aware-дати, mongomock — naive, що означає UTC."""
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d.astimezone(timezone.utc)


def iso(d) -> str | None:
    return utc(d).isoformat() if isinstance(d, datetime) else None


def local_day(d: datetime) -> date:
    return utc(d).astimezone(TZ).date()


def day_start(d: date) -> datetime:
    """Північ дня магазину (Київ) в UTC — межа для запитів до Mongo."""
    return datetime.combine(d, time.min, tzinfo=TZ).astimezone(timezone.utc)


def dec(v) -> Decimal:
    try:
        d = v if isinstance(v, Decimal) else Decimal(str(v)) if v is not None else ZERO
    except ArithmeticError:
        return ZERO
    return d if d.is_finite() else ZERO


def num(v) -> float:
    return round(float(v), 2)


def _ok(o: dict) -> bool:
    return o.get("status") not in CANCELLED


def _qty(o: dict) -> int:
    return sum(int(i.get("qty") or 0) for i in o.get("items") or [])


def _tg_id(o: dict) -> int | None:
    t = (o.get("customer") or {}).get("tg_id")
    return t if isinstance(t, int) and not isinstance(t, bool) and t > 0 else None


def _person(u: dict | None) -> str:
    return " ".join(x for x in ((u or {}).get("first_name"), (u or {}).get("last_name")) if x)


def _scalars(details) -> dict:
    """Для стрічки подій: лише прості значення; вкладені списки/словники відкидаються, довгі рядки обрізаються."""
    out: dict = {}
    if not isinstance(details, dict):
        return out
    for k, v in load(details).items():
        if isinstance(v, str):
            out[str(k)] = v[:120]
        elif isinstance(v, (bool, int)) or (isinstance(v, float) and math.isfinite(v)):
            out[str(k)] = v
        elif isinstance(v, Decimal) and v.is_finite():
            out[str(k)] = float(v)
    return out


def _carts(db) -> tuple[int, Decimal]:
    """Непорожні кошики за поточними цінами каталогу, як у списку користувачів: позиції без товару в каталозі не рахуються."""
    carts = list(db.carts.find({"items.0": {"$exists": True}}, {"items": 1}))
    oids = set()
    for c in carts:
        for it in c.get("items") or []:
            try:
                oids.add(ObjectId(it["product_id"]))
            except Exception:
                pass
    prices = {str(p["_id"]): dec(load(p).get("final_price"))
              for p in db.products.find({"_id": {"$in": list(oids)}}, {"final_price": 1})} if oids else {}
    count, total = 0, ZERO
    for c in carts:
        known = [it for it in c.get("items") or [] if str(it.get("product_id")) in prices]
        if known:
            count += 1
            total += sum((prices[str(it["product_id"])] * int(it.get("qty") or 0) for it in known), ZERO)
    return count, total


@router.get("/overview")
def overview(db=Depends(get_db), _=Depends(current_admin)):
    now = _now()
    today = now.astimezone(TZ).date()

    # день -> підсумки; 60 днів: поточні 30 + попередні 30 для порівняння
    days: dict = {}
    for o in db.orders.find({"created_at": {"$gte": day_start(today - timedelta(days=59)), "$lt": day_start(today + timedelta(days=1))},
                             "status": {"$nin": CANCELLED}}, {"total": 1, "profit": 1, "created_at": 1}):
        if not isinstance(o.get("created_at"), datetime):
            continue
        o = load(o)
        b = days.setdefault(local_day(o["created_at"]), {"orders": 0, "revenue": ZERO, "profit": ZERO, "known": 0})
        b["orders"] += 1
        b["revenue"] += dec(o.get("total"))
        if o.get("profit") is not None:
            b["profit"] += dec(o["profit"])
            b["known"] += 1

    def window(length: int, offset: int = 0) -> dict:
        """length днів, що закінчуються за offset днів до сьогодні (включно)."""
        sel = [days[d] for d in (today - timedelta(days=i) for i in range(offset, offset + length)) if d in days]
        return {"orders": sum(b["orders"] for b in sel), "revenue": sum((b["revenue"] for b in sel), ZERO),
                "profit": sum((b["profit"] for b in sel), ZERO) if any(b["known"] for b in sel) else None}

    d1, d7, d7p, d30, d30p = window(1), window(7), window(7, 7), window(30), window(30, 30)
    series = []
    for i in range(29, -1, -1):
        d = today - timedelta(days=i)
        b = days.get(d) or {"orders": 0, "revenue": ZERO}
        series.append({"date": d.isoformat(), "orders": b["orders"], "revenue": num(b["revenue"])})

    by_status = {s: db.orders.count_documents({"status": s}) for s in STATUSES}
    d7_start, d30_start = day_start(today - timedelta(days=6)), day_start(today - timedelta(days=29))
    carts, carts_total = _carts(db)

    products = {"total": 0, "in_stock": 0, "expected": 0, "unavailable": 0, "hot": 0, "no_photo": 0, "needs_content": 0}
    cats = {k: {"id": k, "label": v, "total": 0, "in_stock": 0} for k, v in CATEGORY_LABELS.items()}
    for p in db.products.find({}, {"category": 1, "status": 1, "hot": 1, "images": 1, "needs_content": 1}):
        st = p.get("status")
        products["total"] += 1
        if st in ("in_stock", "expected", "unavailable"):
            products[st] += 1
        products["hot"] += 1 if p.get("hot") else 0
        products["no_photo"] += 0 if any(p.get("images") or []) else 1
        products["needs_content"] += 1 if p.get("needs_content") else 0   # фільтр «Без фото (нові)» у товарах
        c = cats.get(p.get("category"))
        if c:
            c["total"] += 1
            c["in_stock"] += 1 if st == "in_stock" else 0
    products["by_category"] = list(cats.values())

    unread = [int(r.get("unread") or 0) for r in db.chats.find({"unread": {"$gt": 0}}, {"unread": 1})]

    recent = []
    for o in db.orders.find({}, {"number": 1, "status": 1, "total": 1, "created_at": 1, "order_type": 1, "items.qty": 1,
                                 "customer.name": 1, "customer.tg_id": 1}).sort("created_at", -1).limit(8):
        o = load(o)
        cust = o.get("customer") or {}
        recent.append({"number": o.get("number"), "status": o.get("status"), "total": num(dec(o.get("total"))),
                       "created_at": iso(o.get("created_at")), "order_type": o.get("order_type") or "wholesale",
                       "items_count": _qty(o), "customer": {"name": cust.get("name") or "", "tg_id": cust.get("tg_id")}})

    activity = [{"at": iso(a.get("at")), "admin": str(a.get("admin") or ""), "action": str(a.get("action") or ""),
                 "details": _scalars(a.get("details"))}
                for a in db.audit_log.find({}).sort("at", -1).limit(15)]

    return {
        "generated_at": iso(now), "tz": TZ_NAME,
        "orders": {"active": sum(by_status[s] for s in ACTIVE_STATUSES), "new": by_status["new"],
                   "stale_new": db.orders.count_documents({"status": "new", "created_at": {"$lt": now - timedelta(hours=2)}}),
                   "by_status": by_status, "statuses": STATUS_LABELS,
                   "today": {"count": d1["orders"], "revenue": num(d1["revenue"])}},
        "revenue": {"d7": num(d7["revenue"]), "d7_prev": num(d7p["revenue"]), "d30": num(d30["revenue"]), "d30_prev": num(d30p["revenue"]),
                    "orders_d30": d30["orders"], "orders_d30_prev": d30p["orders"],
                    "avg_d30": num(d30["revenue"] / d30["orders"]) if d30["orders"] else None,
                    "profit_d30": num(d30["profit"]) if d30["profit"] is not None else None},
        "series": series,
        "customers": {"total": db.users.count_documents({}),
                      "new_7d": db.users.count_documents({"registered_at": {"$gte": d7_start}}),
                      "new_30d": db.users.count_documents({"registered_at": {"$gte": d30_start}}),
                      "active_7d": db.users.count_documents({"last_seen_at": {"$gte": d7_start}}),
                      "with_orders": len(db.orders.distinct("customer.tg_id", {"customer.tg_id": {"$gt": 0}})),
                      "carts": carts, "carts_total": num(carts_total)},
        "products": products,
        "chats": {"unread": sum(unread), "threads_unread": len(unread)},
        "recent_orders": recent,
        "activity": activity,
    }


def _parse_day(raw: str) -> date | None:
    s = (raw or "").strip()
    if not s:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        try:
            return date.fromisoformat(s)
        except ValueError:
            pass
    raise HTTPException(422, "Дата має бути у форматі РРРР-ММ-ДД")


def _ranked(rows, limit: int | None = None) -> list:
    rows = sorted(rows, key=lambda r: (-r["revenue"], -r.get("qty", r.get("count", r.get("orders", 0)))))
    return rows[:limit] if limit else rows


def _money_rows(rows: list) -> list:
    out = []
    for r in rows:
        r = {**r, "revenue": num(r["revenue"])}
        if "profit" in r:
            r["profit"] = num(r["profit"]) if r["profit"] is not None else None
        out.append(r)
    return out


@router.get("/analytics")
def analytics(date_from: str = "", date_to: str = "", db=Depends(get_db), _=Depends(current_admin)):
    """Період — включно, дні за Києвом; за замовчуванням останні 30 днів. Порівняння з попереднім періодом такої ж довжини."""
    today = _now().astimezone(TZ).date()
    d_to = _parse_day(date_to) or today
    d_from = _parse_day(date_from) or d_to - timedelta(days=29)
    if d_from > d_to:
        raise HTTPException(422, "Початкова дата не може бути пізнішою за кінцеву")
    n_days = (d_to - d_from).days + 1
    if n_days > MAX_DAYS:
        raise HTTPException(422, f"Період не може перевищувати {MAX_DAYS} днів")
    try:
        prev_to = d_from - timedelta(days=1)
        prev_from = prev_to - timedelta(days=n_days - 1)
        start, end, prev_start = day_start(d_from), day_start(d_to + timedelta(days=1)), day_start(prev_from)
    except OverflowError:
        raise HTTPException(422, "Некоректний період")

    cur = [load(o) for o in db.orders.find({"created_at": {"$gte": start, "$lt": end}}, _ANALYTICS_FIELDS).sort("created_at", -1)]
    prev = [load(o) for o in db.orders.find({"created_at": {"$gte": prev_start, "$lt": start}}, {"status": 1, "total": 1, "profit": 1})]
    cur = [o for o in cur if isinstance(o.get("created_at"), datetime)]
    ok = [o for o in cur if _ok(o)]

    def totals(rows: list) -> tuple[int, Decimal, Decimal | None]:
        good = [o for o in rows if _ok(o)]
        known = [dec(o["profit"]) for o in good if o.get("profit") is not None]
        return len(good), sum((dec(o.get("total")) for o in good), ZERO), (sum(known, ZERO) if known else None)

    n, revenue, profit = totals(cur)
    pn, prev_revenue, prev_profit = totals(prev)

    customers = {t for t in map(_tg_id, ok) if t}
    returning = len(db.orders.distinct("customer.tg_id", {"customer.tg_id": {"$in": list(customers)}, "created_at": {"$lt": start},
                                                          "status": {"$nin": CANCELLED}})) if customers else 0

    series = {d_from + timedelta(days=i): {"orders": 0, "revenue": ZERO, "profit": ZERO, "new_users": 0} for i in range(n_days)}
    new_users = 0
    for u in db.users.find({"registered_at": {"$gte": start, "$lt": end}}, {"registered_at": 1}):
        new_users += 1
        s = series.get(local_day(u["registered_at"]))
        if s:
            s["new_users"] += 1

    by_status: dict = {}
    for o in cur:
        b = by_status.setdefault(o.get("status"), {"count": 0, "revenue": ZERO})
        b["count"] += 1
        b["revenue"] += dec(o.get("total"))

    by_type = {t: {"count": 0, "revenue": ZERO} for t in ORDER_TYPES}
    by_payment: dict = {}
    by_category: dict = {}
    products: dict = {}
    brands: dict = {}
    buyers: dict = {}
    weekdays = [{"orders": 0, "revenue": ZERO} for _ in range(7)]
    items_total = 0
    discounts = promo_discount = ZERO
    promo_orders = 0

    for o in ok:                                       # найновіші першими: назви товарів/покупців беруться з останнього замовлення
        total = dec(o.get("total"))
        day = local_day(o["created_at"])
        s = series.get(day)
        if s:
            s["orders"] += 1
            s["revenue"] += total
            if o.get("profit") is not None:
                s["profit"] += dec(o["profit"])
        weekdays[day.weekday()]["orders"] += 1
        weekdays[day.weekday()]["revenue"] += total
        discounts += dec(o.get("discount"))
        if o.get("promo"):
            promo_orders += 1
            promo_discount += dec(o["promo"].get("amount")) if isinstance(o["promo"], dict) else ZERO

        t = by_type[o.get("order_type") if o.get("order_type") in ORDER_TYPES else "wholesale"]
        t["count"] += 1
        t["revenue"] += total

        pay = o.get("payment") or {}
        method = pay.get("method") or "unknown"
        b = by_payment.setdefault(method, {"method": method, "count": 0, "revenue": ZERO,
                                           "label": PAYMENT_LABELS.get(method) or ("Не вказано" if method == "unknown" else pay.get("label") or method)})
        b["count"] += 1
        b["revenue"] += total

        tg = _tg_id(o)
        if tg:
            c = buyers.setdefault(tg, {"tg_id": tg, "name": (o.get("customer") or {}).get("name") or "",
                                       "username": (o.get("customer") or {}).get("tg_username") or "", "orders": 0, "revenue": ZERO})
            c["orders"] += 1
            c["revenue"] += total

        seen = set()
        for i in o.get("items") or []:
            qty, line = int(i.get("qty") or 0), dec(i.get("line_total"))
            items_total += qty
            cat = i.get("category") or "unknown"
            b = by_category.setdefault(cat, {"id": cat, "label": CATEGORY_LABELS.get(cat, "Не визначено"), "qty": 0, "revenue": ZERO})
            b["qty"] += qty
            b["revenue"] += line
            key = str(i.get("product_id") or f"name:{i.get('name')}")
            p = products.setdefault(key, {"product_id": i.get("product_id"), "name": i.get("display_name") or i.get("title") or i.get("name") or "",
                                          "brand": i.get("brand") or "", "category": i.get("category"),
                                          "qty": 0, "revenue": ZERO, "profit": None, "orders": 0})
            p["qty"] += qty
            p["revenue"] += line
            if i.get("profit") is not None:
                p["profit"] = (p["profit"] or ZERO) + dec(i["profit"])
            if key not in seen:
                seen.add(key)
                p["orders"] += 1
            brand = i.get("brand") or "Без бренду"
            b = brands.setdefault(brand, {"brand": brand, "qty": 0, "revenue": ZERO})
            b["qty"] += qty
            b["revenue"] += line

    top_buyers = _ranked(buyers.values(), 8)
    people = {u["_id"]: u for u in db.users.find({"_id": {"$in": [c["tg_id"] for c in top_buyers]}},
                                                 {"first_name": 1, "last_name": 1, "username": 1})} if top_buyers else {}
    for c in top_buyers:
        u = people.get(c["tg_id"])
        c["name"] = _person(u) or c["name"] or "Без імені"
        c["username"] = (u or {}).get("username") or c["username"]

    statuses = STATUSES + [s for s in by_status if s not in STATUSES]
    return {
        "range": {"from": d_from.isoformat(), "to": d_to.isoformat(), "days": n_days,
                  "prev_from": prev_from.isoformat(), "prev_to": prev_to.isoformat()},
        "summary": {"orders": n, "orders_prev": pn, "revenue": num(revenue), "revenue_prev": num(prev_revenue),
                    "done_revenue": num(sum((dec(o.get("total")) for o in cur if o.get("status") == "done"), ZERO)),
                    "avg": num(revenue / n) if n else None, "avg_prev": num(prev_revenue / pn) if pn else None,
                    "profit": num(profit) if profit is not None else None,
                    "profit_prev": num(prev_profit) if prev_profit is not None else None,
                    "items": items_total, "discounts": num(discounts), "cancelled": len(cur) - len(ok),
                    "customers": len(customers), "new_customers": new_users, "returning_customers": returning,
                    "promo_orders": promo_orders, "promo_discount": num(promo_discount)},
        "series": [{"date": d.isoformat(), "orders": s["orders"], "revenue": num(s["revenue"]), "profit": num(s["profit"]),
                    "new_users": s["new_users"]} for d, s in series.items()],
        "by_status": [{"status": s, "label": STATUS_LABELS.get(s, str(s)), "count": by_status[s]["count"],
                       "revenue": num(by_status[s]["revenue"])} for s in statuses if s in by_status],
        "by_type": [{"type": t, "label": ORDER_TYPES[t], "count": b["count"], "revenue": num(b["revenue"])} for t, b in by_type.items()],
        "by_payment": _money_rows(_ranked(by_payment.values())),
        "by_category": _money_rows(_ranked(by_category.values())),
        "top_products": _money_rows(_ranked(products.values(), 10)),
        "top_brands": _money_rows(_ranked(brands.values(), 8)),
        "top_customers": _money_rows(top_buyers),
        "by_weekday": [{"day": i, "orders": w["orders"], "revenue": num(w["revenue"])} for i, w in enumerate(weekdays)],
    }
