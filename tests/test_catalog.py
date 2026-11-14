import json
from pathlib import Path

from backend.services.catalog import build_catalog
from backend.services.importer import normalize
from backend.services.pricing import DEFAULT_MARKUPS

ROWS = json.loads((Path(__file__).resolve().parent.parent / "imports" / "products_clean.json").read_text(encoding="utf-8"))


def _docs():
    out = []
    for i, r in enumerate(ROWS):
        d = normalize(r, DEFAULT_MARKUPS)
        d["_id"] = f"{i:024x}"
        out.append(d)
    return out


def test_every_imported_product_is_in_the_catalog():
    c = build_catalog(_docs())
    assert sum(len(p["variants"]) for p in c["products"]) == len(ROWS) == 800
    ids = [v["id"] for p in c["products"] for v in p["variants"]]
    assert len(set(ids)) == 800


def test_no_internal_fields_leak():
    blob = json.dumps(build_catalog(_docs()), ensure_ascii=False)
    for secret in ("purchase_price", "supplier_mrc", "internal", "dedupe_key", "markup", "source_row", "reasons"):
        assert secret not in blob


def test_liquids_are_view_only_and_pods_are_orderable():
    c = build_catalog(_docs())
    liq = [p for p in c["products"] if p["category"] == "liquid"]
    pods = [p for p in c["products"] if p["category"] == "pod"]
    assert liq and all(not v["purchasable"] and v["blocked"] for p in liq for v in p["variants"])
    assert pods and all(v["purchasable"] for p in pods for v in p["variants"] if v["inStock"])


def test_expected_items_are_not_purchasable():
    c = build_catalog(_docs())
    exp = [v for p in c["products"] for v in p["variants"] if v["expected"]]
    assert len(exp) == 8 and not any(v["purchasable"] for v in exp)


def test_show_blocked_off_hides_liquids():
    c = build_catalog(_docs(), show_blocked=False)
    assert all(p["category"] != "liquid" for p in c["products"])
    assert all(cat["id"] != "liquid" for cat in c["categories"])


def test_cartridges_group_by_resistance_and_images_are_public_paths():
    c = build_catalog(_docs())
    cart = next(p for p in c["products"] if p["category"] == "cartridge" and len(p["variants"]) == 3)
    assert all("Ω" in v["label"] for v in cart["variants"])
    imgs = [p["image"] for p in c["products"] if p["image"]]
    assert imgs and all(i.startswith("/img/") and i.endswith(".webp") and "imports" not in i for i in imgs)


def test_unavailable_status_is_skipped_and_group_ids_are_stable():
    d = _docs()
    d[0]["status"] = "unavailable"
    assert sum(len(p["variants"]) for p in build_catalog(d)["products"]) == 799
    assert [p["id"] for p in build_catalog(_docs())["products"]] == [p["id"] for p in build_catalog(_docs())["products"]]


def test_every_liquid_offers_50_and_65_and_keeps_own_strength():
    c = build_catalog(_docs())
    liquids = [p for p in c["products"] if p["category"] == "liquid"]
    assert liquids and all({50, 65} <= set(p["strengths"]) for p in liquids)
    assert all(v["nicotine"] in p["strengths"] for p in liquids for v in p["variants"])
    hard = next(p for p in liquids if "Hard" in p["name"])           # HYPE Hard 70 мг: власна міцність не губиться
    assert hard["strengths"] == [50, 65, 70] and hard["variants"][0]["nicotine"] == 70
    triple = next(p for p in liquids if "Triple" in p["name"])       # Flavorlab Triple 65 мг: за замовчуванням 65
    assert triple["variants"][0]["nicotine"] == 65


def test_non_liquids_have_no_strength_choice():
    c = build_catalog(_docs())
    assert all("strengths" not in p and "nicotine" not in v
               for p in c["products"] if p["category"] != "liquid" for v in p["variants"])
