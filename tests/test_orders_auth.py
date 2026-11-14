"""Потребують: pip install -r requirements.txt (mongomock, fastapi, httpx, argon2-cffi)."""
import os
from decimal import Decimal

import pytest

pytest.importorskip("mongomock")
pytest.importorskip("argon2")
import mongomock  # noqa: E402

from backend.database import to_db  # noqa: E402
from backend.services import orders as svc  # noqa: E402


@pytest.fixture()
def db():
    d = mongomock.MongoClient().db
    ok = d.products.insert_one(to_db({"name": "Pod A", "brand": "X", "category": "pod", "status": "in_stock",
                                      "final_price": Decimal("882"), "compliance": {"status": "hold_legal_review"}}))
    bad = d.products.insert_one(to_db({"name": "Liq", "brand": "Y", "category": "liquid", "status": "in_stock",
                                       "final_price": Decimal("250"), "compliance": {"status": "blocked_by_law"}}))
    d.ids = (str(ok.inserted_id), str(bad.inserted_id))
    return d


def test_order_uses_server_price_and_snapshots_it(db):
    o = svc.create_order(db, {"name": "A"}, [{"product_id": db.ids[0], "qty": 2}, {"product_id": db.ids[0], "qty": 1}], "adm")
    assert o["total"] == Decimal("2646.00") and len(o["items"]) == 1 and o["items"][0]["qty"] == 3
    db.products.update_one({}, {"$set": {"final_price": to_db(Decimal("1"))}})      # прайс змінився
    stored = db.orders.find_one({"number": o["number"]})
    assert str(stored["items"][0]["unit_price"]) == "882.00"


def test_legacy_blocked_status_does_not_block_aroma_order(db):
    order = svc.create_order(db, {"name": "A"}, [{"product_id": db.ids[1], "qty": 1}], "adm")
    assert order["items"][0]["name"] == "Liq"


def test_invalid_quantity_and_empty(db):
    with pytest.raises(svc.OrderError):
        svc.create_order(db, {}, [{"product_id": db.ids[0], "qty": 0}], "adm")
    with pytest.raises(svc.OrderError):
        svc.create_order(db, {}, [], "adm")


def test_unique_order_numbers_and_status(db):
    a = svc.create_order(db, {"name": "A"}, [{"product_id": db.ids[0], "qty": 1}], "adm")
    b = svc.create_order(db, {"name": "B"}, [{"product_id": db.ids[0], "qty": 1}], "adm")
    assert a["number"] != b["number"]
    assert svc.set_status(db, a["number"], "confirmed")["status"] == "confirmed"
    with pytest.raises(svc.OrderError):
        svc.set_status(db, a["number"], "nonsense")


def test_admin_routes_require_auth(monkeypatch):
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient
    monkeypatch.setenv("JWT_SECRET", "x" * 40)
    from backend.database import get_db
    from backend.main import app
    app.dependency_overrides[get_db] = lambda: mongomock.MongoClient().db
    c = TestClient(app)
    for path in ("/api/products", "/api/orders", "/api/pricing/markups", "/api/settings", "/api/brands"):
        assert c.get(path).status_code == 401
    assert c.get("/api/products", headers={"Authorization": "Bearer garbage"}).status_code == 401


def test_status_reason_history_and_customer_message(db):
    o = svc.create_order(db, {"name": "A"}, [{"product_id": db.ids[0], "qty": 1}], "adm")
    r = svc.set_status(db, o["number"], "rejected", "  немає в наявності ", "adm")
    assert r["status"] == "rejected" and r["status_reason"] == "немає в наявності" and r["history"][-1]["status"] == "rejected"
    assert "Причина: немає в наявності" in svc.customer_message(o["number"], "rejected", "немає в наявності")
    assert "збирається" in svc.customer_message(o["number"], "packing")
    assert svc.customer_message(o["number"], "new") is None
    assert "packing" in svc.ACTIVE_STATUSES and "rejected" not in svc.ACTIVE_STATUSES


def test_liquid_strength_is_validated_and_split_into_lines(db):
    liq = str(db.products.find_one({"name": "Liq"})["_id"])
    db.products.update_one({"name": "Liq"}, {"$set": {"nicotine_mg": 50}})
    o = svc.create_order(db, {"name": "A"}, [{"product_id": liq, "qty": 1, "nicotine_mg": 50},
                                              {"product_id": liq, "qty": 2, "nicotine_mg": 65},
                                              {"product_id": liq, "qty": 1, "nicotine_mg": 65}], "adm")
    by = {i["nicotine_mg"]: i for i in o["items"]}
    assert len(o["items"]) == 2 and by[50]["qty"] == 1 and by[65]["qty"] == 3
    assert by[65]["display_name"].endswith("65 мг") and o["total"] == Decimal("1000.00")
    with pytest.raises(svc.OrderError):
        svc.create_order(db, {}, [{"product_id": liq, "qty": 1, "nicotine_mg": 30}], "adm")       # такої міцності немає
    with pytest.raises(svc.OrderError):
        svc.create_order(db, {}, [{"product_id": db.ids[0], "qty": 1, "nicotine_mg": 50}], "adm")  # не рідина


def test_wholesale_order_gets_tier_discount_and_retail_does_not(db):
    from backend.services.discounts import DEFAULT_TIERS
    db.products.update_one({"name": "Pod A"}, {"$set": {"final_price": to_db(Decimal("1000"))}})
    o = svc.create_order(db, {"name": "A"}, [{"product_id": db.ids[0], "qty": 20}], "adm", discount_tiers=DEFAULT_TIERS)
    assert o["subtotal"] == Decimal("20000.00") and o["discount"] == Decimal("600.00") and o["total"] == Decimal("19400.00")
    assert o["discount_percent"] == Decimal("3")
    r = svc.create_order(db, {"name": "A"}, [{"product_id": db.ids[0], "qty": 20}], "adm", order_type="retail", discount_tiers=DEFAULT_TIERS)
    assert r["discount"] == Decimal("0.00") and r["total"] == Decimal("20000.00")


def test_order_without_tiers_has_no_discount(db):
    o = svc.create_order(db, {"name": "A"}, [{"product_id": db.ids[0], "qty": 50}], "adm")
    assert o["discount"] == Decimal("0.00")
