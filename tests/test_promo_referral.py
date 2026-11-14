"""Промокоди й рефералка поверх MongoDB (mongomock) + API Mini App. Потребує: pip install -r requirements-dev.txt"""
from decimal import Decimal

import pytest

pytest.importorskip("mongomock")
import mongomock  # noqa: E402

from backend.services import promo, referral  # noqa: E402
from tests.test_shop_api import _order, env, hdr  # noqa: E402,F401  (env — fixture з test_shop_api)


@pytest.fixture()
def db():
    return mongomock.MongoClient().db


def test_one_time_code_can_be_redeemed_once_and_released(db):
    promo.create_code(db, percent=5, code="ONCE", max_uses=1)
    r = promo.redeem(db, "once", 1)
    assert r["code"] == "ONCE" and r["percent"] == Decimal("5")
    with pytest.raises(promo.PromoError):
        promo.redeem(db, "ONCE", 2)                      # ліміт вичерпано
    promo.release(db, r, 1)                              # замовлення не вийшло -> код знову вільний
    assert promo.redeem(db, "ONCE", 2)["code"] == "ONCE"


def test_same_customer_cannot_reuse_unlimited_code(db):
    promo.create_code(db, percent=10, code="SALE10")
    promo.redeem(db, "SALE10", 1)
    with pytest.raises(promo.PromoError):
        promo.redeem(db, "SALE10", 1)
    assert promo.redeem(db, "SALE10", 2)["code"] == "SALE10"


def test_duplicate_code_rejected(db, monkeypatch):
    promo.create_code(db, percent=10, code="DUP")
    with pytest.raises(promo.PromoError):
        promo.create_code(db, percent=10, code="dup")


def _users(db, *ids):
    for i in ids:
        db.users.insert_one({"_id": i})


def test_referral_attach_is_one_time_and_not_self(db):
    _users(db, 1, 2, 3)
    assert referral.attach(db, 1, 1) is None                    # не себе
    gift = referral.attach(db, 2, 1)
    assert gift and gift["code"].startswith("REF-") and gift["percent"] == 3
    assert db.users.find_one({"_id": 2})["referred_by"] == 1
    assert referral.attach(db, 2, 3) is None                    # вдруге запросити не можна
    assert referral.attach(db, 4, 1) is None                    # невідомий користувач (немає запису)


def test_referral_not_counted_for_customers_with_orders(db):
    _users(db, 1, 2)
    db.orders.insert_one({"number": "X", "customer": {"tg_id": 2}})
    assert referral.attach(db, 2, 1) is None


def test_referrer_rewarded_once_after_first_done_order(db):
    _users(db, 1, 2)
    referral.attach(db, 2, 1)
    sent = []
    call = lambda m, p=None, **kw: sent.append((m, p)) or {"ok": True}      # noqa: E731
    order = {"number": "ORD-1", "customer": {"tg_id": 2}}
    res = referral.reward_on_done(db, order, call=call)
    assert res["referrer_id"] == 1 and res["percent"] == 3
    assert sent[0][1]["chat_id"] == 1 and res["code"] in sent[0][1]["text"]
    assert db.promo_codes.find_one({"_id": res["code"]})["owner_tg_id"] == 1
    assert referral.reward_on_done(db, {"number": "ORD-2", "customer": {"tg_id": 2}}, call=call) is None   # лише за перше
    assert referral.reward_on_done(db, {"number": "ORD-3", "customer": {"tg_id": 9}}, call=call) is None   # не запрошений


def test_referral_percent_zero_disables_rewards(db):
    db.settings.insert_one({"_id": "general", "referral_reward_percent": 0, "referral_friend_percent": 0})
    _users(db, 1, 2)
    assert referral.attach(db, 2, 1) is None                    # запрошення записано, але подарунка немає
    assert referral.reward_on_done(db, {"number": "A", "customer": {"tg_id": 2}}, call=lambda *a, **k: {"ok": True}) is None
    assert db.promo_codes.count_documents({}) == 0


def test_order_with_promo_applies_percent_and_blocks_second_use(env):
    c, db = env
    promo.create_code(db, percent=10, code="SALE10")
    r = c.post("/api/shop/orders", json=_order(db.ids[0], 3, promo_code="sale10"), headers=hdr(42))
    assert r.status_code == 201 and r.json()["total"] == 2381.40            # 2646 − 10 % = 264.60
    o = db.orders.find_one({"number": r.json()["number"]})
    assert o["promo"]["code"] == "SALE10" and str(o["discount"]) == "264.60"
    again = c.post("/api/shop/orders", json=_order(db.ids[0], 3, promo_code="SALE10"), headers=hdr(42))
    assert again.status_code == 422 and "вже використовували" in again.json()["detail"]


def test_failed_order_does_not_burn_one_time_code(env):
    c, db = env
    promo.create_code(db, percent=10, code="ONCE", max_uses=1)
    low = c.post("/api/shop/orders", json=_order(db.ids[0], 1, promo_code="ONCE"), headers=hdr(42))      # нижче мінімуму
    assert low.status_code == 422
    assert db.promo_codes.find_one({"_id": "ONCE"})["uses_left"] == 1
    assert c.post("/api/shop/orders", json=_order(db.ids[0], 3, promo_code="ONCE"), headers=hdr(42)).status_code == 201


def test_promo_check_and_personal_code_is_private(env):
    c, db = env
    promo.create_code(db, percent=5, code="MINE", owner_tg_id=42, max_uses=1)
    ok = c.post("/api/shop/promo/check", json={"code": "mine"}, headers=hdr(42))
    assert ok.status_code == 200 and ok.json() == {"code": "MINE", "percent": 5.0}
    assert c.post("/api/shop/promo/check", json={"code": "MINE"}, headers=hdr(43)).status_code == 422
    assert c.post("/api/shop/promo/check", json={"code": "NOPE"}, headers=hdr(42)).status_code == 422
    assert db.promo_codes.find_one({"_id": "MINE"})["used"] == 0              # перевірка код не «спалює»


def test_referral_screen_returns_link_stats_and_codes(env, monkeypatch):
    c, db = env
    monkeypatch.setenv("BOT_USERNAME", "my_shop_bot")
    db.users.insert_one({"_id": 42})
    db.users.insert_one({"_id": 50, "referred_by": 42})
    promo.create_code(db, percent=3, owner_tg_id=42, max_uses=1, kind="referral_reward")
    r = c.get("/api/shop/referral", headers=hdr(42)).json()
    assert r["link"] == "https://t.me/my_shop_bot?start=ref_42" and r["invited"] == 1 and r["rewarded"] == 0
    assert r["reward_percent"] == 3 and len(r["codes"]) == 1
