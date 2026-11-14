"""Чек замовлення у вигляді PNG (Pillow). Висота підлаштовується під кількість товарів і довжину тексту.

Дані беруться з документа замовлення; суми рахуються тут заново через pricing.order_totals (Decimal),
а не довіряються збереженим полям. Логотип: файл backend/assets/logo.png (або LOGO_PATH), інакше малюється знак «B».
"""
import io
import os
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .pricing import D, money, order_totals

ASSETS = Path(__file__).resolve().parent.parent / "assets"
FONT_REG, FONT_BOLD = ASSETS / "fonts" / "LiberationSans-Regular.ttf", ASSETS / "fonts" / "LiberationSans-Bold.ttf"

# --- кольори чека (м’які, лагідні відтінки). Змінюються тут в одному місці. ---
BAR = (79, 124, 10)             # смуги заголовків і «Загальна сума» (білий текст, контраст ≈ 5:1)
TOP_STRIP = (10, 10, 12)        # тонка темна смуга зверху
ACCENT = (200, 255, 61)         # світлий акцент (знак логотипа)
INK = (24, 24, 28)              # основний темний текст
MUTED = (110, 110, 120)         # підписи
LINE = (222, 222, 228)          # тонкі горизонтальні лінії
WHITE = (255, 255, 255)

W = 900                         # ширина, px: на екрані смартфона це ≈ 2.2x, текст читається без збільшення
PAD = 44
LABEL_W = 270                   # ширина колонки підписів у секції «Покупець»


def _font(bold: bool, size: int):
    """Шрифт із репозиторію (є кирилиця й ₴). Якщо файл раптом відсутній — системні запасні, щоб сервер не впав при старті."""
    name = "LiberationSans-Bold.ttf" if bold else "LiberationSans-Regular.ttf"
    for path in (FONT_BOLD if bold else FONT_REG, Path("/usr/share/fonts/truetype/liberation") / name,
                 Path("/usr/share/fonts/truetype/dejavu") / ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")):
        try:
            return ImageFont.truetype(str(path), size)
        except OSError:
            continue
    return ImageFont.load_default(size)


F = {"title": _font(True, 40), "bar": _font(True, 30), "lab": _font(False, 25), "val": _font(False, 27), "valb": _font(True, 27),
     "item": _font(True, 29), "attr": _font(False, 24), "calc": _font(False, 26), "sum": _font(False, 28),
     "sumb": _font(True, 28), "tot": _font(True, 40), "mark": _font(True, 52)}


def fmt(v) -> str:
    """2646 -> «2 646.00» (нерозривний пробіл у тисячах), завжди 2 знаки."""
    q = money(v)
    whole, frac = f"{q:.2f}".split(".")
    sign = "-" if whole.startswith("-") else ""
    whole = whole.lstrip("-")
    groups = []
    while whole:
        groups.insert(0, whole[-3:]); whole = whole[:-3]
    return f"{sign}{chr(160).join(groups)}.{frac}"


def _wrap(text: str, font, maxw: int) -> list:
    """Перенос по словах; надто довге слово (адреса без пробілів тощо) ріжеться по символах, нічого не обрізається."""
    out = []
    for para in str(text).split("\n"):
        line = ""
        for word in para.split():
            cand = f"{line} {word}".strip()
            if font.getlength(cand) <= maxw:
                line = cand
                continue
            if line:
                out.append(line); line = ""
            while font.getlength(word) > maxw:
                cut = len(word)
                while cut > 1 and font.getlength(word[:cut]) > maxw:
                    cut -= 1
                out.append(word[:cut]); word = word[cut:]
            line = word
        out.append(line)
    return out or [""]


def _kyiv(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        from zoneinfo import ZoneInfo
        return dt.astimezone(ZoneInfo("Europe/Kyiv"))
    except Exception:                       # немає tzdata в системі: показуємо UTC, а не падаємо
        return dt.astimezone(timezone.utc)


def _unit_text(qty: int, unit) -> str:
    return f"{qty} шт × {fmt(unit)} грн"


def build_receipt_data(order: dict, shop: dict | None = None) -> dict:
    """Готує дані чека з документа замовлення (значення вже мають бути Decimal, див. database.load)."""
    shop = shop or {}
    c = order.get("customer") or {}
    d = c.get("delivery") or {}
    created = order.get("created_at")
    when = _kyiv(created).strftime("%d.%m.%Y %H:%M") if isinstance(created, datetime) else ""
    pay = order.get("payment") or {}
    rows = [("Номер замовлення", str(order.get("number") or "")), ("Дата та час", when), ("ПІБ", c.get("name")),
            ("Телефон", c.get("phone"))]
    if d:
        rows.append(("Спосіб отримання", "Нова пошта (відділення)" if d.get("carrier", "nova_poshta") == "nova_poshta" else "Доставка"))
        city = ", ".join(x for x in (d.get("city"), d.get("area")) if x)
        addr = ", ".join(x for x in (city, d.get("warehouse")) if x)
        rows.append(("Адреса доставки", addr))
    rows.append(("Спосіб оплати", pay.get("label")))
    rows = [(k, str(v).strip()) for k, v in rows if v not in (None, "") and str(v).strip()]       # порожні поля не показуємо

    items = []
    for it in order.get("items") or []:
        attrs = [(a[0], a[1]) for a in (it.get("attrs") or []) if len(a) == 2 and a[1] not in (None, "")]
        if not it.get("attrs") and it.get("nicotine_mg"):
            attrs.append(("Міцність", f"{it['nicotine_mg']} мг"))
        items.append({"title": it.get("title") or it.get("display_name") or it.get("name") or "Товар", "attrs": attrs,
                      "qty": int(it["qty"]), "unit_price": D(it["unit_price"]), "discount": D(it.get("discount") or 0)})
    t = order_totals(items, order.get("discount") or 0, order.get("extra") or 0)
    for it, ln in zip(items, t["lines"]):
        it["gross"], it["net"], it["disc"] = ln["gross"], ln["net"], ln["discount"]
    return {"title": shop.get("receipt_title") or "Bob Smoke | OPT", "rows": rows, "items": items, "totals": t}


def _logo(size: int) -> Image.Image:
    path = Path(os.environ.get("LOGO_PATH") or ASSETS / "logo.png")
    if path.is_file():
        try:
            im = Image.open(path).convert("RGBA")
            im.thumbnail((size, size), Image.LANCZOS)
            box = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            box.paste(im, ((size - im.width) // 2, (size - im.height) // 2), im)
            return box
        except Exception:
            pass
    s = size * 4                                         # малюємо у 4x і зменшуємо: гладкі краї
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    dr.rounded_rectangle((0, 0, s - 1, s - 1), radius=s // 4, fill=TOP_STRIP)
    f = _font(True, int(s * 0.62))
    dr.text((s / 2, s / 2), "B", font=f, fill=ACCENT, anchor="mm")
    dr.ellipse((s * 0.70, s * 0.66, s * 0.82, s * 0.78), fill=ACCENT)
    return im.resize((size, size), Image.LANCZOS)


def _paint(img: Image.Image, data: dict) -> int:
    """Малює чек і повертає потрібну висоту. Викликається двічі: на «чорновому» полотні для виміру і на справжньому."""
    dr = ImageDraw.Draw(img)
    dr.rectangle((0, 0, W, 10), fill=TOP_STRIP)                      # тонка темна смуга
    y = 10 + 34
    logo = _logo(96)
    img.paste(logo, (PAD, y), logo)
    dr.text((PAD + 96 + 28, y + 48), data["title"], font=F["title"], fill=INK, anchor="lm")
    y += 96 + 34

    def bar(text):
        nonlocal y
        dr.rectangle((0, y, W, y + 64), fill=BAR)
        dr.text((PAD, y + 32), text, font=F["bar"], fill=WHITE, anchor="lm")
        y += 64

    bar("Покупець")
    y += 8
    vw = W - PAD - (PAD + LABEL_W)
    for i, (label, value) in enumerate(data["rows"]):
        lines = _wrap(value, F["val"], vw)
        y += 16
        dr.text((PAD, y + 3), label, font=F["lab"], fill=MUTED)
        for ln in lines:
            dr.text((PAD + LABEL_W, y), ln, font=F["valb"] if label == "Номер замовлення" else F["val"], fill=INK)
            y += 37
        y += 12
        if i < len(data["rows"]) - 1:
            dr.line((PAD, y, W - PAD, y), fill=LINE, width=2)
    y += 22

    bar("Список товарів")
    items = data["items"]
    for i, it in enumerate(items):
        y += 22
        for ln in _wrap(it["title"], F["item"], W - 2 * PAD):
            dr.text((PAD, y), ln, font=F["item"], fill=INK); y += 38
        for label, value in it["attrs"]:
            for ln in _wrap(f"{label}: {value}", F["attr"], W - 2 * PAD):
                dr.text((PAD, y + 2), ln, font=F["attr"], fill=MUTED); y += 33
        y += 12
        left = _unit_text(it["qty"], it["unit_price"])
        dr.text((PAD, y + 4), left, font=F["calc"], fill=INK)
        net = f"{fmt(it['net'])} грн"
        nw = F["sumb"].getlength(net)
        dr.text((W - PAD, y + 2), net, font=F["sumb"], fill=INK, anchor="ra")
        if it["disc"] > 0:                                           # знижка на позицію: перекреслена сума до знижки
            gross = f"{fmt(it['gross'])} грн"
            gx = W - PAD - nw - 22
            dr.text((gx, y + 5), gross, font=F["attr"], fill=MUTED, anchor="ra")
            gw = F["attr"].getlength(gross)
            dr.line((gx - gw, y + 20, gx, y + 20), fill=MUTED, width=2)
        y += 44
        if it["disc"] > 0:
            dr.text((W - PAD, y - 4), f"знижка −{fmt(it['disc'])} грн", font=F["attr"], fill=MUTED, anchor="ra")
            y += 32
        y += 14
        if i < len(items) - 1:
            dr.line((PAD, y, W - PAD, y), fill=LINE, width=2)

    t = data["totals"]
    y += 8
    dr.line((0, y, W, y), fill=LINE, width=2)
    for label, val in (("Сума замовлення:", t["subtotal"]), ("Знижка до замовлення:", t["discount"])):
        y += 20
        dr.text((PAD, y), label, font=F["sum"], fill=MUTED)
        dr.text((W - PAD, y), f"{fmt(val)} грн", font=F["sumb"], fill=INK, anchor="ra")
        y += 38 + 18
        dr.line((PAD, y, W - PAD, y), fill=LINE, width=2)
    y += 1
    dr.rectangle((0, y, W, y + 104), fill=BAR)                      # «Загальна сума»: колір, білий текст, більший шрифт
    dr.text((PAD, y + 52), "Загальна сума:", font=F["tot"], fill=WHITE, anchor="lm")
    dr.text((W - PAD, y + 52), f"{fmt(t['total'])} грн", font=F["tot"], fill=WHITE, anchor="rm")
    y += 104
    return y


def render_receipt(order: dict, shop: dict | None = None) -> bytes:
    """PNG-байти чека. Висота залежить від кількості позицій, переносів назв і адреси."""
    data = build_receipt_data(order, shop)
    height = _paint(Image.new("RGB", (W, 40), WHITE), data)        # перший прохід: лише вимір
    img = Image.new("RGB", (W, height), WHITE)
    _paint(img, data)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()
