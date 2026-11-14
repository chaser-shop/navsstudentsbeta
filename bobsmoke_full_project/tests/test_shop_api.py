"""API Mini App. Потребує: pip install -r requirements-dev.txt (fastapi, httpx, mongomock)."""
import json
import time
from decimal import Decimal

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
pytest.importorskip("mongomock")
import mongomock  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.database import get_db, to_db  # noqa: E402
from backend.services.telegram_auth import sign_init_data  # noqa: E402

TOKEN = "123456:TEST-TOKEN"


def hdr(uid=42):
    f = {"auth_date": str(int(time.time())), "user": json.dumps({"id": uid, "first_name": "Іван", "username": "ivan"}, ensure_ascii=False)}
    return {"X-Telegram-Init-Data": sign_init_data(f, TOKEN)}


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "x" * 40)
    monkeypatch.setenv("BOT_TOKEN", TOKEN)
    monkeypatch.setenv("BOT_ALLOWED_IDS", "")
    monkeypatch.delenv("MINIAPP_DEV_MODE", raising=False)
    monkeypatch.setenv("REQUIRED_CHANNEL", "off")       # перевірка підписки в цих тестах вимкнена
    from backend.main import app
    from backend.routes import shop
    db = mongomock.MongoClient().db
    pod = db.products.insert_one(to_db({"name": "Pod A", "brand": "X", "category": "pod", "model": "A", "variant": "Black", "status": "in_stock",
                                        "purchase_price": Decimal("800"), "final_price": Decimal("882"), "internal": {"mrc": "1"},
                                        "compliance": {"status": "hold_legal_review"}, "images": ["imports/images/a.webp"]}))
    liq = db.products.insert_one(to_db({"name": "Liq", "brand": "Y", "category": "liquid", "product_line": "L 30ml", "status": "in_stock",
                                        "final_price": Decimal("250"), "compliance": {"status": "blocked_by_law"}}))
    db.ids = (str(pod.inserted_id), str(liq.inserted_id))
    db.delivered = []                                   # замість реальної відправки в Telegram (подяка + чек)
    monkeypatch.setattr(shop, "deliver_order", lambda d, number: db.delivered.append(number))
    app.dependency_overrides[get_db] = lambda: db
    shop._cache.update(at=0.0, data=None)
    yield TestClient(app), db
    app.dependency_overrides.clear()


def _order(pid, qty=1, **kw):
    body = {"first_name": "Іван", "last_name": "Петренко", "phone": "0671234567",
            "delivery": {"city": "Київ", "area": "Київська", "warehouse": "№1", "city_ref": "c", "warehouse_ref": "w"},
            "items": [{"product_id": pid, "qty": qty}]}
    body.update(kw)
    return body


def test_shop_requires_valid_telegram_signature(env):
    c, _ = env
    assert c.get("/api/shop/catalog").status_code == 401
    assert c.get("/api/shop/catalog", headers={"X-Telegram-Init-Data": "hash=bad"}).status_code == 401
    assert c.post("/api/shop/orders", json=_order("x")).status_code == 401


def test_catalog_hides_internal_fields_but_lists_all(env):
    c, _ = env
    r = c.get("/api/shop/catalog", headers=hdr())
    assert r.status_code == 200
    body = r.text
    assert "purchase_price" not in body and "internal" not in body and "mrc" not in body
    assert len(r.json()["products"]) == 2


def test_order_uses_server_price_and_accepts_legacy_blocked_aroma(env):
    c, db = env
    ok = c.post("/api/shop/orders", json=_order(db.ids[0], 3), headers=hdr())
    assert ok.status_code == 201 and ok.json()["total"] == 2646
    aroma = c.post("/api/shop/orders", json=_order(db.ids[1], 9), headers=hdr())
    assert aroma.status_code == 201 and aroma.json()["total"] == 2250
    assert db.orders.count_documents({}) == 2 and db.orders.find_one()["customer"]["tg_id"] == 42


def test_client_cannot_inject_price_or_skip_delivery(env):
    c, db = env
    body = _order(db.ids[0], 3)
    body["items"][0]["price"] = 1
    assert c.post("/api/shop/orders", json=body, headers=hdr()).json()["total"] == 2646
    body = _order(db.ids[0], 3)
    body["delivery"]["warehouse_ref"] = ""
    assert c.post("/api/shop/orders", json=body, headers=hdr()).status_code == 422


def test_my_orders_are_private_and_rate_limit_works(env, monkeypatch):
    c, db = env
    c.post("/api/shop/orders", json=_order(db.ids[0], 3), headers=hdr(42))
    assert len(c.get("/api/shop/orders", headers=hdr(42)).json()) == 1
    assert c.get("/api/shop/orders", headers=hdr(43)).json() == []
    monkeypatch.setenv("ORDERS_PER_HOUR", "1")
    assert c.post("/api/shop/orders", json=_order(db.ids[0], 3), headers=hdr(42)).status_code == 429


def test_webhook_rejects_wrong_secret(env):
    c, _ = env
    assert c.post("/telegram/webhook", json={}).status_code == 403
    assert c.post("/telegram/webhook", json={}, headers={"X-Telegram-Bot-Api-Secret-Token": "nope"}).status_code == 403


def test_minimum_order_total_is_enforced_on_server(env):
    c, db = env
    low = c.post("/api/shop/orders", json=_order(db.ids[0], 2), headers=hdr())          # 2 x 882 = 1764 < 2100
    assert low.status_code == 422 and "2100" in low.json()["detail"]
    assert db.orders.count_documents({}) == 0
    edge = c.post("/api/shop/orders", json=_order(db.ids[1], 9), headers=hdr())         # 9 x 250 = 2250
    assert edge.status_code == 201
    assert c.get("/api/shop/catalog", headers=hdr()).json()["shop"]["min_order"] == 2100


def test_prepayment_can_be_switched_back_on(env, monkeypatch):
    monkeypatch.setenv("PREPAY_ENABLED", "1")
    c, db = env
    assert c.get("/api/shop/catalog", headers=hdr()).json()["shop"]["prepay_enabled"] is True
    r = c.post("/api/shop/orders", json=_order(db.ids[0], 3), headers=hdr())
    o = db.orders.find_one({"number": r.json()["number"]})
    assert o["payment"]["method"] == "cod" and str(o["payment"]["prepay_amount"]) == "100.00"
    assert o["prepay_consent"]["accepted"] is True


def test_payment_method_is_chosen_stored_and_triggers_customer_message(env):
    c, db = env
    r = c.post("/api/shop/orders", json=_order(db.ids[0], 3), headers=hdr())              # без payment_method = накладений платіж
    assert r.status_code == 201 and r.json()["payment_method"] == "cod"
    o = db.orders.find_one({"number": r.json()["number"]})
    assert o["payment"] == {"method": "cod", "label": "Накладений платіж"}            # передоплату вимкнено за замовчуванням
    assert "prepay_consent" not in o and r.json()["prepay"] is None
    assert (str(o["subtotal"]), str(o["discount"]), str(o["total"])) == ("2646.00", "0.00", "2646.00")
    assert o["items"][0]["title"] and ["Колір", "Black"] in o["items"][0]["attrs"]
    r = c.post("/api/shop/orders", json=_order(db.ids[0], 3, payment_method="prepaid"), headers=hdr())
    o2 = db.orders.find_one({"number": r.json()["number"]})
    assert r.json()["payment_method"] == "prepaid" and o2["payment"] == {"method": "prepaid", "label": "Повна оплата на карту"}
    assert "prepay_consent" not in o2
    assert c.post("/api/shop/orders", json=_order(db.ids[0], 3, payment_method="crypto"), headers=hdr()).status_code == 422
    assert db.orders.count_documents({}) == 2
    assert db.delivered == [o["number"], o2["number"]]   # кожному успішному замовленню іде подяка з чеком


def test_cart_sync_and_last_seen_are_stored_for_dashboard(env):
    c, db = env
    c.get("/api/shop/catalog", headers=hdr(77))
    u = db.users.find_one({"_id": 77})
    assert u and u["last_seen_at"] and u["registered_at"]
    assert c.put("/api/shop/cart", json={"items": [{"product_id": db.ids[0], "qty": 2}]}, headers=hdr(77)).status_code == 200
    assert db.carts.find_one({"_id": 77})["items"][0]["qty"] == 2
    c.put("/api/shop/cart", json={"items": []}, headers=hdr(77))
    assert db.carts.find_one({"_id": 77}) is None
