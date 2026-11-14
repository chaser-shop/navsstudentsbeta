"""Промокоди: чиста логіка (без БД)."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from backend.services import promo as pr
from backend.services import referral

NOW = datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc)


def doc(**kw):
    d = {"_id": "SALE10", "percent": Decimal("10"), "active": True, "owner_tg_id": None, "uses_left": None, "used_by": [], "expires_at": None}
    d.update(kw)
    return d


def bad(d, uid=1, text=""):
    try:
        pr.check(d, uid, NOW)
    except pr.PromoError as e:
        assert text in str(e), str(e)
        return
    assert False, "очікувалась помилка"


def test_normalize_code_uppercases_and_strips_spaces():
    assert pr.normalize_code(" sale 10 ") == "SALE10"
    assert pr.normalize_code("знижка-5") == "ЗНИЖКА-5"
    for x in ("ab", "", "a" * 33, "sale!", None):
        try:
            pr.normalize_code(x); assert False, x
        except pr.PromoError:
            pass


def test_normalize_percent_bounds():
    assert pr.normalize_percent("10") == Decimal("10") and pr.normalize_percent("2,5") == Decimal("2.5")
    for x in ("0", "-1", "101", "abc", "nan", ""):
        try:
            pr.normalize_percent(x); assert False, x
        except pr.PromoError:
            pass


def test_check_ok_returns_percent():
    assert pr.check(doc(), 1, NOW) == Decimal("10")
    assert pr.check(doc(uses_left=3, owner_tg_id=1), 1, NOW) == Decimal("10")


def test_check_rejects_unknown_disabled_expired():
    bad(None, text="не знайдено")
    bad(doc(active=False), text="не діє")
    bad(doc(expires_at=NOW - timedelta(seconds=1)), text="Термін")
    assert pr.check(doc(expires_at=NOW + timedelta(days=1)), 1, NOW)
    assert pr.check(doc(expires_at=datetime(2026, 12, 1)), 1, NOW)         # дата без таймзони (mongomock) теж працює


def test_check_rejects_foreign_personal_code_reuse_and_exhausted():
    bad(doc(owner_tg_id=2), uid=1, text="іншому клієнту")
    bad(doc(used_by=[1]), uid=1, text="вже використовували")
    bad(doc(uses_left=0), text="уже використано")


def test_amount_rounds_to_kopecks_and_generated_code_is_readable():
    assert pr.amount(2646, Decimal("10")) == Decimal("264.60")
    assert pr.amount("1000.01", 3) == Decimal("30.00")
    c = pr.generate_code("REF")
    assert c.startswith("REF-") and len(c) == 10 and not set(c[4:]) & set("0O1IL")


def test_referral_start_payload_parsing():
    assert referral.parse_start("ref_12345") == 12345
    for x in ("", "ref_", "ref_abc", "ref_-5", "ref_0", "promo_1", "ref_1; drop"):
        assert referral.parse_start(x) is None, x
