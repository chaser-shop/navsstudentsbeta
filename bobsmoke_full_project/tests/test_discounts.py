"""Знижки за сумою замовлення: чиста логіка."""
from decimal import Decimal

from backend.services import discounts as dc

T = dc.DEFAULT_TIERS


def pct(total):
    return dc.discount_for(total, T)


def test_default_tiers_match_price_list():
    assert [(t["from"], t["percent"]) for t in T] == [(10000, 2), (20000, 3), (30000, 4), (40000, 5), (50000, 6), (70000, 8), (90000, 10)]


def test_below_first_tier_no_discount():
    assert pct(9999.99) == (Decimal("0"), Decimal("0.00"))


def test_threshold_is_inclusive():
    assert pct(10000) == (Decimal("2"), Decimal("200.00"))
    assert pct(20000)[0] == Decimal("3") and pct(69999)[0] == Decimal("6") and pct(70000)[0] == Decimal("8")


def test_top_tier_applies_above_last_threshold():
    assert pct(150000) == (Decimal("10"), Decimal("15000.00"))


def test_amount_rounds_to_kopecks():
    assert pct(Decimal("10333.33"))[1] == Decimal("206.67")


def test_next_tier_hint():
    assert dc.next_tier(8000, T)["from"] == 10000 and dc.next_tier(95000, T) is None


def test_no_tiers_means_no_discount():
    assert dc.discount_for(100000, []) == (Decimal("0"), Decimal("0.00"))


def test_normalize_tiers_sorts_and_validates():
    out = dc.normalize_tiers([{"from": "20000", "percent": "3"}, {"from": 10000, "percent": 2}])
    assert out == [{"from": 10000, "percent": 2}, {"from": 20000, "percent": 3}]
    for bad in ([{"from": 0, "percent": 2}], [{"from": 1000, "percent": 0}], [{"from": 1000, "percent": 101}],
                [{"from": "x", "percent": 2}], "nope"):
        try:
            dc.normalize_tiers(bad); assert False, bad
        except ValueError:
            pass
