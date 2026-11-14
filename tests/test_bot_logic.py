from backend.services.validators import normalize_phone
from bot.novaposhta import NovaPoshta, NPError


def test_phone_normalization():
    assert normalize_phone("0671234567") == "+380671234567"
    assert normalize_phone("+38 (067) 123-45-67") == "+380671234567"
    assert normalize_phone("380671234567") == "+380671234567"
    for bad in ("12345", "+1 202 555 0100", "", "06712345678"):
        try:
            normalize_phone(bad)
            assert False, bad
        except ValueError:
            pass


def _fake(responses):
    calls = []

    def post(payload):
        calls.append(payload)
        return responses[payload["calledMethod"]]
    return post, calls


def test_city_search_returns_area_and_skips_cities_without_warehouses():
    post, calls = _fake({"searchSettlements": {"success": True, "data": [{"Addresses": [
        {"MainDescription": "Київ", "Area": "Київська", "Region": "", "Present": "м. Київ, Київська обл.",
         "DeliveryCity": "ref-kyiv", "Warehouses": "400"},
        {"MainDescription": "Київ", "Area": "Інша", "Present": "с. Київ", "DeliveryCity": "", "Warehouses": "0"}]}]}})
    res = NovaPoshta("KEY", post).search_cities(" Київ ")
    assert len(res) == 1 and res[0]["area"] == "Київська" and res[0]["city_ref"] == "ref-kyiv"
    assert calls[0]["methodProperties"]["CityName"] == "Київ" and calls[0]["apiKey"] == "KEY"


def test_warehouses_and_filter():
    post, calls = _fake({"getWarehouses": {"success": True, "data": [
        {"Description": "Відділення №1", "Ref": "r1", "Number": "1"}]}})
    ws = NovaPoshta("KEY", post).warehouses("ref-kyiv", find="12", page=2)
    assert ws == [{"title": "Відділення №1", "ref": "r1", "number": "1"}]
    p = calls[0]["methodProperties"]
    assert p["CityRef"] == "ref-kyiv" and p["FindByString"] == "12" and p["Page"] == "2"


def test_api_error_is_raised():
    post, _ = _fake({"getWarehouses": {"success": False, "errors": ["API key is invalid"]}})
    try:
        NovaPoshta("BAD", post).warehouses("x")
        assert False
    except NPError as e:
        assert "invalid" in str(e)
    try:
        NovaPoshta("")
        assert False
    except NPError:
        pass
