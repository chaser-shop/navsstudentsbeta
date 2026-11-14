"""Адмін-статистика, аналітика, картка користувача, пошук користувачів/замовлень, історія чату.
Потребують: pip install -r requirements-dev.txt (fastapi, httpx, mongomock)."""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
pytest.importorskip("mongomock")
import mongomock  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.auth.security import current_admin  # noqa: E402
from backend.database import get_db, to_db  # noqa: E402
from backend.services.orders import STATUS_LABELS  # noqa: E402

NOW = datetime(2026, 11, 12, 10, 0, tzinfo=timezone.utc)          # 12:00 за Києвом, «сьогодні» = 2026-11-12
H, D = timedelta(hours=1), timedelta(days=1)


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "x" * 40)
    from backend.main import app
    from backend.routes import stats
    monkeypatch.setattr(stats, "_now", lambda: NOW)
    db = mongomock.MongoClient().db
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[current_admin] = lambda: "admin"
    yield TestClient(app), db, app
    app.dependency_overrides.clear()


def _item(pid, qty, line_total, profit=None, brand="X", category="pod", name="Товар", display_name=None):
    i = {"product_id": pid, "name": name, "display_name": display_name or f"{brand} {name}", "brand": brand, "title": name,
         "category": category, "qty": qty, "unit_price": Decimal(str(line_total)) / qty, "line_total": Decimal(str(line_total))}
    if profit is not None:
        i["profit"] = Decimal(str(profit))
    return i


def _order(db, number, status, created, total, *, tg_id=None, order_type="wholesale", profit=None, items=None, payment=None,
           promo=None, discount=0, name="Покупець", phone="", username="", contact=""):
    cust = {"name": name, "phone": phone, "contact": contact, "tg_username": username, "delivery": {"city": "Київ", "warehouse": "№1"}}
    if tg_id is not None:
        cust["tg_id"] = tg_id
    doc = {"number": number, "status": status, "created_at": created, "updated_at": created, "customer": cust,
           "items": items if items is not None else [_item("p0", 1, total)], "subtotal": Decimal(str(total)) + Decimal(str(discount)),
           "discount": Decimal(str(discount)), "promo": promo, "total": Decimal(str(total)),
           "profit": Decimal(str(profit)) if profit is not None else None, "history": [], "notes": []}
    if order_type is not None:
        doc["order_type"] = order_type
    if payment is not None:
        doc["payment"] = payment
    db.orders.insert_one(to_db(doc))


def _product(db, name, category, status, price, images=(), hot=False, brand="X"):
    return str(db.products.insert_one(to_db({"name": name, "brand": brand, "category": category, "status": status, "hot": hot,
                                             "final_price": Decimal(str(price)), "images": list(images)})).inserted_id)


# ---------- огляд для dashboard ----------

def test_overview_counts_revenue_series_and_lists(env):
    c, db, _ = env
    p1 = _product(db, "Pod A", "pod", "in_stock", 100, images=["a.webp"], hot=True)
    p2 = _product(db, "Liq", "liquid", "expected", 50, brand="Y")
    p3 = _product(db, "Cart", "cartridge", "unavailable", 20, images=[""], brand="Z")
    _order(db, "ORD-1", "new", NOW - H / 2, 1000, tg_id=42, profit=100, items=[_item(p1, 2, 1000)])
    _order(db, "ORD-2", "new", NOW - 3 * H, 500, tg_id=43, order_type="retail")
    _order(db, "ORD-3", "confirmed", NOW - 2 * D, 2000, tg_id=42, profit=300)
    _order(db, "ORD-4", "rejected", NOW - D, 9999, tg_id=44, profit=10)
    _order(db, "ORD-5", "cancelled", NOW - H, 7777, tg_id=0)
    _order(db, "ORD-6", "done", NOW - 10 * D, 1500, tg_id=42, profit=200)
    _order(db, "ORD-7", "done", NOW - 40 * D, 800)
    _order(db, "ORD-8", "shipped", NOW - 8 * D, 300, tg_id=43)
    _order(db, "ORD-9", "done", NOW - 100 * D, 5000, tg_id=45)
    db.users.insert_many([{"_id": 42, "first_name": "Іван", "registered_at": NOW - 2 * D, "last_seen_at": NOW - H},
                          {"_id": 43, "first_name": "Олена", "registered_at": NOW - 20 * D, "last_seen_at": NOW - 10 * D},
                          {"_id": 44, "first_name": "Петро", "registered_at": NOW - 60 * D, "last_seen_at": NOW - 3 * D}])
    db.carts.insert_many([{"_id": 42, "items": [{"product_id": p1, "qty": 2}, {"product_id": p2, "qty": 1}]},
                          {"_id": 43, "items": []},
                          {"_id": 44, "items": [{"product_id": "bad", "qty": 1}]},
                          {"_id": 45, "items": [{"product_id": p3, "qty": 3}]}])
    db.chats.insert_many([{"_id": 42, "unread": 3}, {"_id": 43, "unread": 0}, {"_id": 44, "unread": 1}])
    for i in range(15):
        db.audit_log.insert_one({"admin": "admin", "action": "order.status", "details": {"number": f"ORD-{i}"},
                                 "at": NOW - (i + 1) * timedelta(minutes=1)})
    db.audit_log.insert_one(to_db({"admin": "boss", "action": "product.update", "at": NOW,
                                   "details": {"fields": ["name"], "nested": {"a": 1}, "long": "я" * 300, "n": 5, "ok": True,
                                               "f": 1.5, "none": None, "price": Decimal("12.50")}}))

    r = c.get("/api/stats/overview")
    assert r.status_code == 200
    j = r.json()
    assert j["tz"] == "Europe/Kyiv" and j["generated_at"].startswith("2026-11-12T10:00:00")
    o = j["orders"]
    assert o["by_status"] == {"new": 2, "confirmed": 1, "packing": 0, "shipped": 1, "done": 3, "rejected": 1,
                              "in_progress": 0, "cancelled": 1}
    assert o["active"] == 4 and o["new"] == 2 and o["stale_new"] == 1 and o["statuses"] == STATUS_LABELS
    assert o["today"] == {"count": 2, "revenue": 1500.0}                     # скасоване сьогодні не рахується
    rev = j["revenue"]
    assert rev["d7"] == 3500.0 and rev["d7_prev"] == 1800.0
    assert rev["d30"] == 5300.0 and rev["orders_d30"] == 5 and rev["avg_d30"] == 1060.0
    assert rev["d30_prev"] == 800.0 and rev["orders_d30_prev"] == 1
    assert rev["profit_d30"] == 600.0                                        # лише відомі прибутки, без відхиленого
    s = j["series"]
    assert len(s) == 30 and s[0]["date"] == "2026-10-14" and s[-1] == {"date": "2026-11-12", "orders": 2, "revenue": 1500.0}
    assert sum(x["orders"] for x in s) == 5 and sum(x["revenue"] for x in s) == 5300.0
    assert j["customers"] == {"total": 3, "new_7d": 1, "new_30d": 2, "active_7d": 2, "with_orders": 4,
                              "carts": 2, "carts_total": 310.0}
    p = j["products"]
    assert {k: p[k] for k in ("total", "in_stock", "expected", "unavailable", "hot", "no_photo")} == \
        {"total": 3, "in_stock": 1, "expected": 1, "unavailable": 1, "hot": 1, "no_photo": 2}
    assert [(x["id"], x["total"], x["in_stock"]) for x in p["by_category"]] == \
        [("liquid", 1, 0), ("pod", 1, 1), ("cartridge", 1, 0), ("booster", 0, 0)]
    assert p["by_category"][0]["label"] == "Рідини"
    assert j["chats"] == {"unread": 4, "threads_unread": 2}
    ro = j["recent_orders"]
    assert [x["number"] for x in ro] == ["ORD-1", "ORD-5", "ORD-2", "ORD-4", "ORD-3", "ORD-8", "ORD-6", "ORD-7"]
    assert ro[0]["total"] == 1000.0 and ro[0]["items_count"] == 2 and ro[0]["order_type"] == "wholesale"
    assert ro[0]["customer"] == {"name": "Покупець", "tg_id": 42} and ro[0]["created_at"].endswith("+00:00")
    assert ro[2]["order_type"] == "retail" and ro[-1]["customer"]["tg_id"] is None
    act = j["activity"]
    assert len(act) == 15 and act[0]["admin"] == "boss" and act[0]["action"] == "product.update"
    assert act[0]["details"] == {"long": "я" * 120, "n": 5, "ok": True, "f": 1.5, "price": 12.5}
    assert act[1]["details"] == {"number": "ORD-0"} and act[0]["at"].startswith("2026-11-12T10:00:00")


def test_overview_on_empty_database(env):
    c, _, _ = env
    j = c.get("/api/stats/overview").json()
    assert j["revenue"]["avg_d30"] is None and j["revenue"]["profit_d30"] is None
    assert j["orders"]["today"] == {"count": 0, "revenue": 0.0} and len(j["series"]) == 30
    assert j["recent_orders"] == [] and j["activity"] == [] and j["customers"]["carts"] == 0


# ---------- аналітика за період ----------

def _analytics_data(db):
    utc = timezone.utc
    cod = {"method": "cod", "label": "Накладений платіж (передоплата 200 грн)"}
    prepaid = {"method": "prepaid", "label": "Повна оплата на карту"}
    _order(db, "ORD-A1", "done", datetime(2026, 11, 2, 10, tzinfo=utc), 200, tg_id=42, profit=40, payment=cod, name="Іван (замовлення)",
           items=[_item("p1", 2, 200, 40, "X", "pod", "Pod A")])
    _order(db, "ORD-A2", "new", datetime(2026, 11, 5, 12, tzinfo=utc), 360, tg_id=43, order_type="retail", payment=prepaid,
           discount=40, promo={"code": "SALE", "percent": Decimal("10"), "amount": Decimal("40")}, username="olena",
           items=[_item("p2", 4, 400, None, "Y", "liquid", "Liq", "Y Liq (стара назва)")])
    _order(db, "ORD-A3", "rejected", datetime(2026, 11, 6, 12, tzinfo=utc), 999, tg_id=42, items=[_item("p1", 10, 999)])
    _order(db, "ORD-A4", "shipped", datetime(2026, 11, 10, 8, tzinfo=utc), 150, tg_id=0, order_type=None, profit=30,
           items=[_item("p1", 1, 100, 20, "X", "pod", "Pod A"), _item("p3", 2, 50, 10, "Z", "cartridge", "Cart")])
    # 22:30 UTC = 00:30 за Києвом наступного дня
    _order(db, "ORD-A5", "done", datetime(2026, 11, 11, 22, 30, tzinfo=utc), 100, tg_id=45, payment=cod,
           items=[_item("p2", 1, 100, None, "Y", "liquid", "Liq", "Y Liq 30 мл")])
    _order(db, "ORD-A6", "new", datetime(2026, 10, 31, 22, 30, tzinfo=utc), 50, tg_id=46, order_type="retail", profit=5, payment=prepaid,
           items=[_item("p3", 1, 50, 5, "Z", "cartridge", "Cart")])
    _order(db, "ORD-B1", "done", datetime(2026, 10, 25, 10, tzinfo=utc), 500, tg_id=42, profit=50)
    _order(db, "ORD-B2", "cancelled", datetime(2026, 10, 28, 10, tzinfo=utc), 300, tg_id=43)
    _order(db, "ORD-B3", "done", datetime(2026, 10, 31, 21, 30, tzinfo=utc), 70, tg_id=47)          # 23:30 за Києвом — ще попередній період
    _order(db, "ORD-C1", "done", datetime(2026, 9, 20, 10, tzinfo=utc), 1000, tg_id=46)
    _order(db, "ORD-C2", "cancelled", datetime(2026, 9, 2, 10, tzinfo=utc), 1000, tg_id=45)
    _order(db, "ORD-C3", "new", datetime(2026, 11, 12, 22, 30, tzinfo=utc), 1000, tg_id=42)          # уже 13.11 за Києвом
    db.users.insert_many([
        {"_id": 42, "first_name": "Іван", "last_name": "Петренко", "username": "ivan", "registered_at": datetime(2026, 11, 3, 10)},
        {"_id": 43, "first_name": "Олена", "registered_at": datetime(2026, 10, 1, 10)},
        {"_id": 45, "first_name": "Оля", "registered_at": datetime(2026, 11, 11, 22, 10)},
        {"_id": 46, "first_name": "Марко", "registered_at": datetime(2026, 10, 31, 21, 0)}])


def test_analytics_explicit_range(env):
    c, db, _ = env
    _analytics_data(db)
    r = c.get("/api/stats/analytics", params={"date_from": "2026-11-01", "date_to": "2026-11-12"})
    assert r.status_code == 200
    j = r.json()
    assert j["range"] == {"from": "2026-11-01", "to": "2026-11-12", "days": 12, "prev_from": "2026-10-20", "prev_to": "2026-10-31"}
    assert j["summary"] == {"orders": 5, "orders_prev": 2, "revenue": 860.0, "revenue_prev": 570.0, "done_revenue": 300.0,
                            "avg": 172.0, "avg_prev": 285.0, "profit": 75.0, "profit_prev": 50.0, "items": 11, "discounts": 40.0,
                            "cancelled": 1, "customers": 4, "new_customers": 2, "returning_customers": 2,
                            "promo_orders": 1, "promo_discount": 40.0}
    s = {x["date"]: x for x in j["series"]}
    assert len(j["series"]) == 12 and j["series"][0]["date"] == "2026-11-01" and j["series"][-1]["date"] == "2026-11-12"
    assert s["2026-11-01"] == {"date": "2026-11-01", "orders": 1, "revenue": 50.0, "profit": 5.0, "new_users": 0}
    assert s["2026-11-05"]["revenue"] == 360.0 and s["2026-11-05"]["profit"] == 0.0
    assert s["2026-11-03"]["new_users"] == 1 and s["2026-11-12"]["new_users"] == 1 and s["2026-11-12"]["orders"] == 1
    assert [(x["status"], x["count"], x["revenue"]) for x in j["by_status"]] == \
        [("new", 2, 410.0), ("shipped", 1, 150.0), ("done", 2, 300.0), ("rejected", 1, 999.0)]
    assert j["by_status"][0]["label"] == "Нове"
    assert j["by_type"] == [{"type": "wholesale", "label": "Опт", "count": 3, "revenue": 450.0},
                            {"type": "retail", "label": "Роздріб", "count": 2, "revenue": 410.0}]
    assert [(x["method"], x["label"], x["count"], x["revenue"]) for x in j["by_payment"]] == \
        [("prepaid", "Повна оплата на карту", 2, 410.0), ("cod", "Накладений платіж", 2, 300.0), ("unknown", "Не вказано", 1, 150.0)]
    assert [(x["id"], x["label"], x["qty"], x["revenue"]) for x in j["by_category"]] == \
        [("liquid", "Рідини", 5, 500.0), ("pod", "Под-системи", 3, 300.0), ("cartridge", "Картриджі (пачки)", 3, 100.0)]
    tp = j["top_products"]
    assert [(x["product_id"], x["qty"], x["revenue"], x["profit"], x["orders"]) for x in tp] == \
        [("p2", 5, 500.0, None, 2), ("p1", 3, 300.0, 60.0, 2), ("p3", 3, 100.0, 15.0, 2)]
    assert tp[0]["name"] == "Y Liq 30 мл" and tp[0]["brand"] == "Y" and tp[0]["category"] == "liquid"   # назва з найновішого замовлення
    assert j["top_brands"] == [{"brand": "Y", "qty": 5, "revenue": 500.0}, {"brand": "X", "qty": 3, "revenue": 300.0},
                               {"brand": "Z", "qty": 3, "revenue": 100.0}]
    tc = j["top_customers"]
    assert [(x["tg_id"], x["orders"], x["revenue"]) for x in tc] == [(43, 1, 360.0), (42, 1, 200.0), (45, 1, 100.0), (46, 1, 50.0)]
    assert tc[0]["name"] == "Олена" and tc[0]["username"] == "olena"
    assert tc[1]["name"] == "Іван Петренко" and tc[1]["username"] == "ivan"
    expected = [0] * 7
    for d in (date(2026, 11, 1), date(2026, 11, 2), date(2026, 11, 5), date(2026, 11, 10), date(2026, 11, 12)):
        expected[d.weekday()] += 1
    assert [w["day"] for w in j["by_weekday"]] == list(range(7)) and [w["orders"] for w in j["by_weekday"]] == expected
    assert sum(w["revenue"] for w in j["by_weekday"]) == 860.0


def test_analytics_default_range_and_validation(env):
    c, db, _ = env
    _analytics_data(db)
    j = c.get("/api/stats/analytics").json()
    assert j["range"] == {"from": "2026-10-14", "to": "2026-11-12", "days": 30, "prev_from": "2026-09-14", "prev_to": "2026-10-13"}
    assert len(j["series"]) == 30 and j["summary"]["orders"] == 7       # A1–A6 (крім відхиленого) + B1, B3
    assert j["summary"]["orders_prev"] == 1 and j["summary"]["revenue_prev"] == 1000.0          # C1
    only_to = c.get("/api/stats/analytics", params={"date_to": "2026-11-10"}).json()["range"]
    assert only_to["from"] == "2026-10-12" and only_to["to"] == "2026-11-10"
    assert c.get("/api/stats/analytics", params={"date_from": "2025-11-12", "date_to": "2026-11-12"}).json()["range"]["days"] == 366
    for params in ({"date_from": "2026-13-01"}, {"date_from": "12.11.2026"}, {"date_to": "2026-02-30"},
                   {"date_from": "2026-11-12", "date_to": "2026-11-01"}, {"date_from": "2025-01-01", "date_to": "2026-11-12"}):
        bad = c.get("/api/stats/analytics", params=params)
        assert bad.status_code == 422, params
        assert isinstance(bad.json()["detail"], str) and any("а" <= ch <= "я" for ch in bad.json()["detail"].lower())


def test_stats_and_user_detail_require_admin(env):
    c, _, app = env
    app.dependency_overrides.pop(current_admin)
    for path in ("/api/stats/overview", "/api/stats/analytics", "/api/users/42"):
        assert c.get(path).status_code == 401


# ---------- картка користувача ----------

def test_user_detail(env):
    c, db, _ = env
    pid = _product(db, "Pod A", "pod", "in_stock", 100)
    db.users.insert_many([
        {"_id": 42, "first_name": "Іван", "last_name": "Петренко", "username": "ivan", "registered_at": NOW - 30 * D,
         "last_seen_at": NOW - H, "referred_by": 99, "referred_at": NOW - 29 * D},
        {"_id": 99, "first_name": "Реф", "username": "ref"},
        {"_id": 50, "first_name": "Друг1", "referred_by": 42}, {"_id": 51, "first_name": "Друг2", "referred_by": 42}])
    _order(db, "ORD-U1", "done", NOW - 5 * D, 1000, tg_id=42, profit=100)
    _order(db, "ORD-U2", "rejected", NOW - 3 * D, 500, tg_id=42, profit=50)
    _order(db, "ORD-U3", "new", NOW - D, 300, tg_id=42, order_type="retail", payment={"method": "prepaid", "label": "Повна оплата на карту"},
           items=[_item("p1", 2, 200), _item("p2", 1, 100)])
    _order(db, "ORD-X", "done", NOW - D, 777, tg_id=43)
    db.carts.insert_one({"_id": 42, "items": [{"product_id": pid, "qty": 2}], "updated_at": NOW - H})
    db.promo_codes.insert_many([to_db({"_id": "REF-ABC", "percent": Decimal("5"), "kind": "referral_reward", "owner_tg_id": 42, "active": True,
                                       "uses_left": 1, "max_uses": 1, "used": 0, "expires_at": None, "created_at": NOW}),
                                to_db({"_id": "OTHER", "percent": Decimal("7"), "kind": "manual", "owner_tg_id": 43, "created_at": NOW})])
    db.chats.insert_one({"_id": 42, "unread": 2, "last_at": NOW - H})

    r = c.get("/api/users/42")
    assert r.status_code == 200
    j = r.json()
    assert j["id"] == 42 and j["name"] == "Іван Петренко" and j["first_name"] == "Іван" and j["username"] == "ivan"
    assert j["bot_blocked"] is False and j["registered_at"].endswith("+00:00") and j["referred_at"]
    assert j["referred_by"] == {"id": 99, "name": "Реф", "username": "ref"} and j["invited"] == 2
    st = j["stats"]
    assert {k: st[k] for k in ("orders", "active", "done", "cancelled", "spent", "avg", "profit")} == \
        {"orders": 3, "active": 1, "done": 1, "cancelled": 1, "spent": 1300.0, "avg": 650.0, "profit": 100.0}
    assert st["first_order_at"].startswith("2026-11-07T10:00:00") and st["last_order_at"].startswith("2026-11-11T10:00:00")
    assert [o["number"] for o in j["orders"]] == ["ORD-U3", "ORD-U2", "ORD-U1"]
    assert j["orders"][0] == {"number": "ORD-U3", "status": "new", "total": 300.0, "created_at": j["orders"][0]["created_at"],
                              "order_type": "retail", "items_count": 3, "payment_label": "Повна оплата на карту"}
    assert j["orders"][2]["order_type"] == "wholesale" and j["orders"][2]["payment_label"] == ""
    assert j["cart"]["items"] == [{"name": "Pod A", "qty": 2, "price": 100.0}] and j["cart"]["total"] == 200.0
    assert j["promo_codes"] == [{"code": "REF-ABC", "percent": 5.0, "kind": "referral_reward", "active": True, "uses_left": 1,
                                 "used": 0, "expires_at": None}]
    assert j["chat"]["unread"] == 2 and j["chat"]["last_at"].endswith("+00:00") and j["statuses"] == STATUS_LABELS

    bare = c.get("/api/users/99").json()
    assert bare["referred_by"] is None and bare["cart"] is None and bare["chat"] is None and bare["orders"] == []
    assert bare["stats"]["avg"] is None and bare["stats"]["profit"] is None and bare["stats"]["first_order_at"] is None
    missing = c.get("/api/users/777")
    assert missing.status_code == 404 and missing.json()["detail"] == "Користувача не знайдено"
    db.user_sync.insert_one({"_id": "state", "status": "done", "checked": 5})
    assert c.get("/api/users/sync").json() == {"status": "done", "checked": 5}     # /sync не перехоплюється маршрутом /{tg_id}


# ---------- пошук користувачів ----------

def test_users_search_runs_in_database_not_after_limit(env):
    c, db, _ = env
    for i in range(4):
        db.users.insert_one({"_id": 100 + i, "first_name": f"Новий{i}", "last_seen_at": NOW - i * H})
    db.users.insert_one({"_id": 5550001, "first_name": "Старий", "last_name": "Користувач", "username": "Old_User",
                         "last_seen_at": datetime(2020, 1, 1)})
    for q in ("старий", "@old_user", "КОРИСТУВАЧ старий", "5550001"):
        j = c.get("/api/users", params={"q": q, "limit": 2}).json()
        assert [u["id"] for u in j["users"]] == [5550001], q
        assert j["total"] == 5 and j["matched"] == 1
    j = c.get("/api/users", params={"limit": 2}).json()
    assert [u["id"] for u in j["users"]] == [100, 101] and j["total"] == 5 and j["matched"] == 5
    u = j["users"][0]
    assert set(u) == {"id", "name", "username", "registered_at", "last_seen_at", "orders", "orders_sum", "cart"}
    none = c.get("/api/users", params={"q": "нікого (такого"}).json()
    assert none["users"] == [] and none["matched"] == 0 and none["total"] == 5


# ---------- фільтри замовлень ----------

def test_orders_search_filters_and_pages(env):
    c, db, _ = env
    for i in range(31):
        _order(db, f"ORD-20261110-{i + 1:04d}", "new", NOW - (i + 10) * H, 100, name=f"Клієнт {i}")
    _order(db, "ORD-20261101-0001", "done", NOW - D, 500, tg_id=555, order_type=None, name="Тарас Шевченко", phone="+380671112233",
           username="taras")
    _order(db, "ORD-20261101-0002", "new", NOW - 2 * D, 300, tg_id=0, order_type="retail", name="Леся", phone="0509998877",
           contact="@lesya_contact")

    def numbers(**params):
        r = c.get("/api/orders", params=params)
        assert r.status_code == 200, r.text
        return [o["number"] for o in r.json()["items"]]

    assert numbers(q="шевч") == ["ORD-20261101-0001"]
    assert numbers(q="0671112233") == ["ORD-20261101-0001"]
    assert numbers(q="555") == ["ORD-20261101-0001"]                          # Telegram ID
    assert numbers(q="TARAS") == ["ORD-20261101-0001"]
    assert numbers(q="lesya_contact") == ["ORD-20261101-0002"]
    assert numbers(q="20261101-0002") == ["ORD-20261101-0002"]
    assert numbers(q="(") == []
    assert numbers(tg_id=555) == ["ORD-20261101-0001"]
    assert numbers(order_type="retail") == ["ORD-20261101-0002"]
    wholesale = c.get("/api/orders", params={"order_type": "wholesale"}).json()
    assert wholesale["total"] == 32 and "ORD-20261101-0001" in [o["number"] for o in wholesale["items"]]   # без order_type = опт
    assert c.get("/api/orders", params={"order_type": "foo"}).status_code == 422

    first = c.get("/api/orders").json()
    assert first["total"] == 33 and first["page"] == 1 and first["pages"] == 2 and len(first["items"]) == 30
    assert {"items", "total", "statuses", "active_count"} <= set(first) and first["active_count"] == 32
    second = c.get("/api/orders", params={"page": 2}).json()
    assert second["page"] == 2 and second["pages"] == 2 and len(second["items"]) == 3
    empty = c.get("/api/orders", params={"q": "нічого"}).json()
    assert empty["total"] == 0 and empty["pages"] == 1


# ---------- історія чату ----------

def test_chat_thread_returns_newest_500_in_chronological_order(env):
    c, db, _ = env
    db.chats.insert_one({"_id": 42, "unread": 5, "last_at": NOW})
    base = NOW - 1000 * timedelta(minutes=1)
    db.messages.insert_many([{"tg_id": 42, "dir": "in", "text": f"m{i}", "kind": "text", "at": base + i * timedelta(minutes=1)}
                             for i in range(505)])
    db.messages.insert_many([{"tg_id": 42, "dir": "out", "text": t, "kind": "text", "by": "admin", "at": NOW} for t in ("tie-a", "tie-b")])
    db.messages.insert_one({"tg_id": 43, "dir": "in", "text": "чужий", "kind": "text", "at": NOW + H})
    th = c.get("/api/chats/42").json()
    texts = [m["text"] for m in th["messages"]]
    assert len(texts) == 500 and texts[0] == "m7" and texts[-3:] == ["m504", "tie-a", "tie-b"]
    assert texts[:-2] == [f"m{i}" for i in range(7, 505)]
    assert db.chats.find_one({"_id": 42})["unread"] == 0


def test_categories_expose_shop_defaults_and_overview_counts_new_without_photo(env):
    client, db, _ = env
    _product(db, "Новий под", "pod", "in_stock", 100)
    _product(db, "Старий под", "pod", "in_stock", 100, images=("a.webp",))
    db.products.update_one({"name": "Новий под"}, {"$set": {"needs_content": True}})
    p = client.get("/api/stats/overview").json()["products"]
    assert p["needs_content"] == 1 and p["no_photo"] == 1
    cats = {c["id"]: c for c in client.get("/api/categories").json()}
    assert cats["pod"] == {"id": "pod", "label": "Под-системи", "title": "Под-системи", "sub": "Пристрої та стартові набори"}
    assert cats["cartridge"]["label"] == "Картриджі (пачки)" and cats["cartridge"]["title"] == "Картриджі"
    assert set(cats) == {"liquid", "pod", "cartridge", "booster"}
