from decimal import Decimal as D

from backend.services.lines import apply_op, line_of, plan_prices, retail_price, summarize
from backend.services.pricing import DEFAULT_MARKUPS

M = DEFAULT_MARKUPS


def liq(i, name, final, rm=None, line="Chaser ULTRA"):
    return {"_id": i, "name": name, "brand": "Chaser", "category": "liquid", "product_line": line, "status": "in_stock",
            "purchase_price": D(final) - 10, "final_price": D(final), "retail_markup": None if rm is None else D(rm)}


def test_retail_follows_general_or_own_markup_and_cartridge_is_exempt():
    assert retail_price(liq(1, "a", 190), 100) == D("290")
    assert retail_price(liq(1, "a", 190, rm=60), 100) == D("250")
    assert retail_price({"category": "cartridge", "final_price": D(100)}, 100) == D("100")


def test_line_priority_custom_then_price_list_then_shop_group():
    assert line_of({**liq(1, "a", 1), "custom_line": "  Мої  рідини "})[1] == "Мої рідини"
    assert line_of(liq(1, "a", 1))[1] == "Chaser ULTRA"
    pod = {"_id": 7, "name": "XROS 3 Black", "brand": "Vaporesso", "category": "pod", "model": "XROS 3", "variant": "Black"}
    assert line_of(pod)[1] == "Vaporesso XROS 3"
    assert line_of(pod)[0] == line_of({**pod, "_id": 8, "variant": "Red"})[0]      # усі кольори моделі — одна лінійка


def test_apply_op_modes():
    assert apply_op(D(190), {"mode": "set", "value": "200"}) == D("200")
    assert apply_op(D(190), {"mode": "shift", "value": "-10"}) == D("180")
    assert apply_op(D(190), {"mode": "percent", "value": "10"}) == D("209")


def test_wholesale_only_moves_retail_with_it():
    r = plan_prices([liq(1, "a", 190), liq(2, "b", 190)], {"mode": "set", "value": "200"}, None, False, M, 100)
    c = r["changes"][0]
    assert c["new"] == {"wholesale": "200", "retail": "300"} and c["patch"]["final_price"] == D("200") and not r["errors"]


def test_both_prices_at_once_sets_markup_per_product():
    r = plan_prices([liq(1, "a", 190), liq(2, "b", 200)], {"mode": "set", "value": "210"}, {"mode": "set", "value": "300"}, False, M, 100)
    assert [c["new"] for c in r["changes"]] == [{"wholesale": "210", "retail": "300"}] * 2
    assert r["changes"][0]["patch"]["retail_markup"] == D("90")


def test_retail_below_wholesale_is_an_error_and_unchanged_is_skipped():
    r = plan_prices([liq(1, "a", 190)], None, {"mode": "set", "value": "150"}, False, M, 100)
    assert r["errors"] and not r["changes"]
    assert plan_prices([liq(1, "a", 190)], {"mode": "set", "value": "190"}, None, False, M, 100)["unchanged"] == 1


def test_wholesale_below_category_markup_is_error_and_reset_restores_general():
    assert plan_prices([liq(1, "a", 190)], {"mode": "set", "value": "5"}, None, False, M, 100)["errors"]
    c = plan_prices([liq(1, "a", 190, rm=60)], None, None, True, M, 100)["changes"][0]
    assert c["patch"]["retail_markup"] is None and c["new"]["retail"] == "290"


def test_summary_shows_range_when_prices_differ():
    s = summarize([liq(1, "a", 190), liq(2, "b", 205)], 100)[0]
    assert s["count"] == 2 and s["wholesale"] == {"min": "190", "max": "205"} and s["retail"]["max"] == "305"
