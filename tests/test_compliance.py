from backend.services.compliance import classify


def test_aroma_products_are_not_auto_blocked_by_volume_or_nicotine_fields():
    assert classify("liquid", 30, 50)["status"] == "ok"
    assert classify("liquid", 10, 50)["status"] == "ok"
    assert classify("liquid", None, None)["status"] == "ok"


def test_categories_are_not_auto_blocked():
    assert classify("pod")["status"] == "ok"
    assert classify("cartridge", name="Cartridge 3ml 0.4 ohm")["status"] == "ok"
