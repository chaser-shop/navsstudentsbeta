"""Оновлення наявності з Excel: чиста логіка (xlsx -> пропозиції). Потребує openpyxl."""
import io
import json
from decimal import Decimal
from pathlib import Path

from openpyxl import Workbook

from backend.services import sheet_sync as ss
from backend.services.importer import normalize
from backend.services.pricing import DEFAULT_MARKUPS

ROWS = json.loads((Path(__file__).resolve().parent.parent / "imports" / "products_clean.json").read_text(encoding="utf-8"))
TXT = {"in_stock": "В наявності", "unavailable": "Немає в наявності", "expected": "Очікується"}


def _docs():
    out = []
    for i, r in enumerate(ROWS):
        d = normalize(r, DEFAULT_MARKUPS)
        d["_id"] = f"{i:024x}"
        out.append(d)
    return out


def _xlsx(docs, status=None, drop=(), extra=()):
    """Книга як у постачальника: вкладка на бренд, рядок-заголовок з «МРЦ», далі товари. status: {id: статус}."""
    status = status or {}
    wb, tabs = Workbook(), {}
    wb.remove(wb.active)
    for d in docs:
        if d["_id"] in drop:
            continue
        tab = d["internal"]["source_sheet"]
        ws = tabs.get(tab) or tabs.setdefault(tab, wb.create_sheet(tab))
        if not ws.max_row or ws.max_row == 1 and ws["A1"].value is None:
            ws.append(["Номенклатура", "Наявність", "Ціна гривня"])      # шапка: «Наявність» не має стати товаром
        line = d.get("product_line") or d.get("model") or d["brand"]
        if getattr(ws, "_line", None) != line:
            ws.append([line, "*** МРЦ 400 грн ***"])
            ws._line = line
        ws.append([d["name"], TXT[status.get(d["_id"], d["status"])], f"{d['purchase_price']} грн."])
    for tab, line, name, st, price in extra:
        ws = tabs.get(tab) or tabs.setdefault(tab, wb.create_sheet(tab))
        ws.append([line, "*** МРЦ 400 грн ***"])
        ws.append([name, TXT[st], f"{price} грн."])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _plan(docs, data, **kw):
    return ss.plan_sync(ss.parse_workbook(data), docs, DEFAULT_MARKUPS, **kw)


def test_unchanged_sheet_changes_nothing():
    docs = _docs()
    p = _plan(docs, _xlsx(docs))
    assert p["updates"] == [] and p["inserts"] == [] and p["warnings"] == []
    assert p["report"]["matched"] == p["report"]["managed"] == 800


def test_out_of_stock_and_arrival_change_status():
    docs = _docs()
    liquid = [d for d in docs if d["category"] == "liquid"]
    gone, back = liquid[0], liquid[1]
    back["status"] = "unavailable"                                  # у БД вже було «немає», а в таблиці знову є
    p = _plan(docs, _xlsx(docs, status={gone["_id"]: "unavailable", back["_id"]: "in_stock"}))
    got = {u["id"]: (u["from"], u["to"]) for u in p["updates"]}
    assert got == {gone["_id"]: ("in_stock", "unavailable"), back["_id"]: ("unavailable", "in_stock")}


def test_expected_to_in_stock_when_it_arrives():
    docs = _docs()
    pod = next(d for d in docs if d["status"] == "expected")
    p = _plan(docs, _xlsx(docs, status={pod["_id"]: "in_stock"}))
    assert [(u["from"], u["to"]) for u in p["updates"]] == [("expected", "in_stock")]


def test_row_removed_from_sheet_becomes_unavailable():
    docs = _docs()
    d = next(x for x in docs if x["category"] == "liquid")
    p = _plan(docs, _xlsx(docs, drop={d["_id"]}))
    assert [(u["id"], u["to"]) for u in p["updates"]] == [(d["_id"], "unavailable")]


def test_header_row_and_sections_are_not_products():
    rows = ss.parse_workbook(_xlsx(_docs()))
    assert all(r["name"] not in ("Номенклатура",) for r in rows)
    assert all(r["status"] in ("in_stock", "unavailable", "expected") for r in rows)


def test_whitespace_and_ohm_spelling_still_match():
    docs = _docs()
    cart = next(d for d in docs if "ohm" in d["name"])
    data = _xlsx(docs, drop={cart["_id"]},
                 extra=[("Девайси", "OXVA XLIM Cartridge", cart["name"].replace(" ohm", "om").replace(" ", "  ", 1) + "\u200b", "in_stock", 104)])
    p = _plan(docs, data)
    assert p["updates"] == [] and p["inserts"] == [] and p["manual"] == []


def test_new_flavor_in_known_line_inherits_line_photo_and_price():
    docs = _docs()
    line = next(d for d in docs if d["brand"] == "HYPE" and d["images"])
    p = _plan(docs, _xlsx(docs, extra=[("Punch|Hype", line["product_line"], "Kiwi Test", "in_stock", 150)]))
    assert len(p["inserts"]) == 1
    n, info = p["inserts"][0], p["new_info"][0]
    assert n["brand"] == "HYPE" and n["category"] == "liquid" and n["volume_ml"] == 30 and n["nicotine_mg"] == 70
    assert n["final_price"] == Decimal("160.00") and n["images"] == line["images"]
    assert n["needs_content"] is False and info["new_line"] is False and n["status"] == "in_stock"


def test_brand_new_line_needs_photo_and_description():
    docs = _docs()
    p = _plan(docs, _xlsx(docs, extra=[("Chaser|ElfLiq", "CHASER SUPER 30ml", "Mango Test", "in_stock", 170)]))
    n = p["inserts"][0]
    assert n["brand"] == "Chaser" and n["product_line"] == "CHASER SUPER 30ml" and n["nicotine_mg"] == 50
    assert n["needs_content"] is True and p["new_info"][0]["new_line"] is True
    assert p["new_info"][0]["price"] == Decimal("180.00") and p["new_info"][0]["name"] == "Mango Test"


def test_out_of_stock_never_seen_product_is_ignored():
    docs = _docs()
    p = _plan(docs, _xlsx(docs, extra=[("Octobar", "Octobar Prime 30ml 50mg", "Never Imported", "unavailable", 150)]))
    assert p["inserts"] == [] and p["manual"] == [] and p["report"]["ignored_unavailable_new"] == 1


def test_new_device_is_reported_for_manual_add_not_inserted():
    docs = _docs()
    p = _plan(docs, _xlsx(docs, extra=[("Девайси", "VAPORESSO NEW", "VAPORESSO NEW Black", "in_stock", 800)]))
    assert p["inserts"] == [] and len(p["manual"]) == 1 and "вручну" in p["manual"][0]["why"]


def test_manual_device_carries_name_price_status_and_guesses_for_the_add_button():
    docs = _docs()
    p = _plan(docs, _xlsx(docs, extra=[("Девайси", "VAPORESSO NEW", "Vaporesso XROS 6 mini Black Denim", "in_stock", 800),
                                        ("Девайси", "OXVA XLIM Cartridge", "OXVA XLIM Cartridge 0.4 ohm", "expected", 104),
                                        ("Девайси", "VAPORESSO NEW", "Vaporesso XROS 6 Azure Flow", "in_stock", None)]))
    m = {x["name"]: x for x in p["manual"]}
    pod = m["Vaporesso XROS 6 mini Black Denim"]
    assert (pod["price"], pod["status"], pod["category"], pod["brand"]) == ("800", "in_stock", "pod", "VAPORESSO")       # бренд береться в тому написанні, що вже є в каталозі
    cart = m["OXVA XLIM Cartridge 0.4 ohm"]
    assert (cart["price"], cart["status"], cart["category"], cart["brand"]) == ("104", "expected", "cartridge", "OXVA")
    assert m["Vaporesso XROS 6 Azure Flow"]["price"] is None and "ціну" in m["Vaporesso XROS 6 Azure Flow"]["why"]


def test_unknown_status_text_changes_nothing():
    docs = _docs()
    d = next(x for x in docs if x["category"] == "liquid")
    data = _xlsx(docs)
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(data))
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            if row[0].value == d["name"] and row[1].value == "В наявності":
                row[1].value = "Закінчується"
                break
    buf = io.BytesIO(); wb.save(buf)
    p = _plan(docs, buf.getvalue())
    assert p["updates"] == [] and p["report"]["unknown_status"] >= 1


def test_partial_file_gives_warning_not_block():
    docs = _docs()
    keep = {d["_id"] for d in docs[:100]}
    p = _plan(docs, _xlsx(docs, drop={d["_id"] for d in docs if d["_id"] not in keep}))
    assert any("структура" in w for w in p["warnings"]) and "blocked" not in p


def test_mass_disappearance_gives_warning_but_keeps_proposals():
    docs = _docs()
    liquids = [d for d in docs if d["category"] == "liquid"]
    st = {d["_id"]: "unavailable" for d in liquids[:300]}
    p = _plan(docs, _xlsx(docs, status=st))
    assert any("закінчується" in w for w in p["warnings"]) and len(p["updates"]) == 300


def test_many_new_items_are_all_proposed():
    docs = _docs()
    extra = [("Chaser|ElfLiq", "CHASER SUPER 30ml", f"Flavor {i}", "in_stock", 170) for i in range(45)]
    p = _plan(docs, _xlsx(docs, extra=extra))
    assert len(p["inserts"]) == 45


def test_status_proposal_has_names_for_the_admin():
    docs = _docs()
    d = next(x for x in docs if x["category"] == "liquid")
    p = _plan(docs, _xlsx(docs, status={d["_id"]: "unavailable"}))
    u = p["updates"][0]
    assert u["name"] == d["name"] and u["brand"] == d["brand"] and u["line"] == d["product_line"] and u["why"]


def test_finalize_new_applies_admin_line_and_price():
    docs = _docs()
    line = next(d for d in docs if d["brand"] == "HYPE" and d["images"])
    p = _plan(docs, _xlsx(docs, extra=[("Chaser|ElfLiq", "CHASER SUPER 30ml", "Mango Test", "in_stock", 170)]))
    base = p["inserts"][0]
    assert base["needs_content"] is True and base["brand"] == "Chaser"
    out = ss.finalize_new(base, DEFAULT_MARKUPS, line=line["product_line"], final=Decimal("199"), index=ss.line_index(docs))
    assert out["product_line"] == line["product_line"] and out["brand"] == "HYPE"
    assert out["final_price"] == Decimal("199.00") and out["purchase_price"] == Decimal("189.00")
    assert out["images"] == line["images"] and out["needs_content"] is False
    assert out["dedupe_key"] == f"HYPE|{line['product_line']}|mango test"


def test_finalize_new_without_edits_keeps_proposal():
    docs = _docs()
    p = _plan(docs, _xlsx(docs, extra=[("Chaser|ElfLiq", "CHASER SUPER 30ml", "Mango Test", "in_stock", 170)]))
    base = p["inserts"][0]
    out = ss.finalize_new(base, DEFAULT_MARKUPS, line=base["product_line"], final=None, index=ss.line_index(docs))
    assert out["final_price"] == base["final_price"] and out["dedupe_key"] == base["dedupe_key"]


def test_finalize_new_brand_new_line_parses_volume_and_nicotine():
    docs = _docs()
    p = _plan(docs, _xlsx(docs, extra=[("Chaser|ElfLiq", "CHASER SUPER 30ml", "Mango Test", "in_stock", 170)]))
    out = ss.finalize_new(p["inserts"][0], DEFAULT_MARKUPS, line="MY LINE 15ml 20mg", index=ss.line_index(docs))
    assert out["volume_ml"] == 15 and out["nicotine_mg"] == 20 and out["images"] == [] and out["needs_content"] is True


def test_empty_workbook_raises():
    wb = Workbook(); buf = io.BytesIO(); wb.save(buf)
    try:
        ss.parse_workbook(buf.getvalue()); assert False
    except ss.SheetError:
        pass
    try:
        ss.parse_workbook(b"<html>login</html>"); assert False
    except ss.SheetError:
        pass


def test_products_without_source_sheet_mark_still_match_and_are_not_new():
    docs = _docs()
    gone = next(d for d in docs if d["category"] == "liquid")
    data = _xlsx(docs, status={gone["_id"]: "unavailable"})
    for d in docs:
        d["internal"] = {}                                         # база з іншого імпорту: без мітки source_sheet
    p = _plan(docs, data)
    assert p["inserts"] == [] and [u["id"] for u in p["updates"]] == [gone["_id"]]


def test_manually_added_products_are_left_alone():
    docs = _docs()
    docs[0]["internal"] = {"manual": True}
    p = _plan(docs, _xlsx(docs, drop={docs[0]["_id"]}))
    assert p["updates"] == []


def test_existing_product_with_unmatched_line_is_not_proposed_as_new():
    docs = _docs()
    d = next(x for x in docs if x["category"] == "liquid")
    data = _xlsx(docs)
    d["internal"] = {"manual": True}                               # не звіряється, але в каталозі є
    p = _plan(docs, data)
    assert all(i["name"] != d["name"] or i["line"] != d["product_line"] for i in p["new_info"])
