"""Чек (PNG), розрахунки на Decimal і текст повідомлення «Дякую за замовлення». Потребують лише Pillow (без MongoDB/pytest)."""
import io
from datetime import datetime, timezone
from decimal import Decimal as D

from PIL import Image

from backend.services import order_messages
from backend.services.pricing import order_totals
from backend.services.receipt import W, _wrap, build_receipt_data, fmt, render_receipt, F

PNG = b"\x89PNG\r\n\x1a\n"


def _order(n_items=2, **kw):
    items = [{"title": f"Товар {i}", "attrs": [["Смак", "Blueberry"], ["Об'єм", "30 мл"]], "qty": i + 1, "unit_price": D("250.00")}
             for i in range(n_items)]
    o = {"number": "ORD-20261021-0001", "created_at": datetime(2026, 10, 21, 12, 30, tzinfo=timezone.utc),
         "customer": {"name": "Петренко Іван", "phone": "+380671234567",
                      "delivery": {"carrier": "nova_poshta", "city": "Київ", "area": "Київська", "warehouse": "Відділення №1"}},
         "payment": {"method": "cod", "prepay_amount": D("100.00"), "label": "Накладений платіж (передоплата 100 грн)"},
         "items": items, "total": D("0")}
    o.update(kw)
    return o


def _h(png):
    return Image.open(io.BytesIO(png)).height


def test_totals_use_decimal_without_float_errors():
    t = order_totals([{"unit_price": "0.10", "qty": 3}, {"unit_price": D("19.99"), "qty": 7}])
    assert t["subtotal"] == D("140.23") and t["discount"] == D("0.00") and t["total"] == D("140.23")


def test_total_is_subtotal_minus_discount_and_delivery_is_not_added():
    t = order_totals([{"unit_price": D("1000"), "qty": 2, "discount": D("100")}, {"unit_price": D("500"), "qty": 1}], order_discount=D("50"))
    assert t["subtotal"] == D("2500.00") and t["discount"] == D("150.00") and t["total"] == D("2350.00")
    assert t["lines"][0]["net"] == D("1900.00")
    assert order_totals([{"unit_price": 100, "qty": 1}], order_discount=1000)["total"] == D("0.00")   # знижка не більша за суму


def test_money_format():
    assert fmt(2646) == "2\xa0646.00" and fmt(0) == "0.00" and fmt(D("1234567.5")) == "1\xa0234\xa0567.50"


def test_receipt_is_png_and_height_adapts_to_item_count():
    one, many = render_receipt(_order(1)), render_receipt(_order(15))
    assert one.startswith(PNG) and many.startswith(PNG)
    assert Image.open(io.BytesIO(one)).width == W
    assert _h(many) > _h(one) + 14 * 100            # кожна позиція додає висоту, жодних обмежень на 2 товари


def test_long_names_and_address_are_wrapped_not_cut():
    long_word = "Надзвичайно" * 12
    lines = _wrap(f"Назва {long_word} кінець", F["item"], W - 88)
    assert len(lines) >= 2 and all(F["item"].getlength(x) <= W - 88 for x in lines)
    assert "".join(lines).replace(" ", "").endswith("кінець")
    short = _h(render_receipt(_order(1)))
    o = _order(1)
    o["items"][0]["title"] = "Дуже довга назва товару " * 8
    o["customer"]["delivery"]["warehouse"] = "Відділення №12 (до 30 кг): вул. Преображенська, 1/2 " * 3
    assert _h(render_receipt(o)) > short


def test_empty_fields_are_hidden_and_pickup_has_no_address():
    o = _order(1)
    o["customer"] = {"name": "Іван", "phone": ""}
    o["payment"] = {}
    labels = [k for k, _ in build_receipt_data(o)["rows"]]
    assert labels == ["Номер замовлення", "Дата та час", "ПІБ"]
    assert render_receipt(o).startswith(PNG)


def test_discount_line_defaults_to_zero_and_lines_are_exact():
    d = build_receipt_data(_order(2))
    assert d["totals"]["discount"] == D("0.00") and d["totals"]["subtotal"] == D("750.00") and d["totals"]["total"] == D("750.00")
    assert [i["net"] for i in d["items"]] == [D("250.00"), D("500.00")]


def test_receipt_date_is_shown_in_kyiv_time():
    assert dict(build_receipt_data(_order(1))["rows"])["Дата та час"] == "21.10.2026 15:30"      # 12:30 UTC = 15:30 EEST


def test_thanks_text_cod_follows_template():
    o = _order(2, total=D("750.00"))
    t = order_messages.thanks_text(o, {"payment_card": "5375 4141 0000 0000", "manager": "@ikwig337", "shop_name": "Bob Smoke", "prepay": 100, "prepay_enabled": True})
    assert t.startswith("<b>Дякую за замовлення</b> <tg-spoiler>№ORD-20261021-0001</tg-spoiler>\nДо оплати : <b>750.00 ₴</b>\n")
    assert "Вам необхідно відправити предоплату <b>100.00 ₴</b> на карту <code>5375 4141 0000 0000</code>, та прикріпити чек в цей чат." in t
    assert "Менеджер обробить замовлення та надішле деталі відправки вам в цей чат повідомлення." in t
    assert "Після відправлення ви отримаєте ТТН для відстеження посилки 📦" in t
    assert "напишіть менеджеру @ikwig337 💬" in t and t.endswith("<b>Дякуємо, що обираєте Bob Smoke💨</b>")


def test_thanks_text_cod_without_prepayment_asks_to_transfer_nothing():
    o = _order(2, total=D("750.00"))
    t = order_messages.thanks_text(o, {"payment_card": "5375 4141 0000 0000", "manager": "@ikwig337", "shop_name": "Bob Smoke",
                                       "prepay": 100, "prepay_enabled": False})
    assert "предоплат" not in t.lower() and "100" not in t and "прикріпити чек" not in t and "5375" not in t
    assert "До оплати : <b>750.00 ₴</b>" in t and "Оплата замовлення — при отриманні на Новій пошті." in t
    assert "Менеджер обробить замовлення" in t and "напишіть менеджеру @ikwig337 💬" in t


def test_payment_info_without_prepayment_has_no_amount():
    from backend.services.orders import payment_info
    assert payment_info("cod", None) == {"method": "cod", "label": "Накладений платіж"}
    assert payment_info("cod", 100)["label"] == "Накладений платіж (передоплата 100 грн)"      # увімкнено: як раніше


def test_thanks_text_prepaid_and_missing_card_and_escaping():
    o = _order(1, total=D("2646"), payment={"method": "prepaid", "label": "Повна оплата на карту"})
    t = order_messages.thanks_text(o, {"payment_card": "<b>1</b>", "manager": "@m", "shop_name": "Bob Smoke"})
    assert "оплатити замовлення повністю — <b>2\xa0646.00 ₴</b>" in t and "<code>&lt;b&gt;1&lt;/b&gt;</code>" in t
    t = order_messages.thanks_text(_order(1, total=D("100"), payment={"method": "prepaid", "label": "Повна оплата на карту"}),
                                   {"payment_card": "", "manager": "@m", "shop_name": "Bob Smoke"})
    assert "надішле менеджер" in t and "<code>" not in t
