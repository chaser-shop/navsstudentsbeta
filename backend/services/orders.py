import re
"""Облік замовлень. Ціни беруться з БД у момент створення й фіксуються в замовленні."""
from datetime import datetime, timezone
from decimal import Decimal

from ..database import load, to_db
from .catalog import liquid_strengths
from .discounts import DISCOUNT_ORDER_TYPES, discount_for
from .pricing import D, money, order_totals
from .promo import amount as promo_amount

STATUSES = ["new", "confirmed", "packing", "shipped", "done", "rejected", "in_progress", "cancelled"]   # in_progress/cancelled — старі
STATUS_LABELS = {"new": "Нове", "confirmed": "Підтверджене", "packing": "Збирається", "shipped": "Відправлене",
                 "done": "Виконане", "rejected": "Відхилене", "in_progress": "У процесі", "cancelled": "Скасоване"}
ACTIVE_STATUSES = ["new", "confirmed", "packing", "shipped", "in_progress"]


def customer_message(number: str, status: str, reason: str = "") -> str | None:
    """Текст повідомлення покупцю в Telegram при зміні статусу (None = не сповіщати)."""
    reason = (reason or "").strip()
    tail = f"\n\nКоментар: {reason}" if reason else ""
    texts = {
        "confirmed": f"✅ Ваше замовлення {number} підтверджено.",
        "packing": f"📦 Ваше замовлення {number} збирається.",
        "shipped": f"🚚 Ваше замовлення {number} відправлено.",
        "done": f"🎉 Замовлення {number} виконано. Дякуємо, що обрали нас!",
        "rejected": f"❌ Ваше замовлення {number} відхилено." + (f"\n\nПричина: {reason}" if reason else ""),
        "cancelled": f"❌ Ваше замовлення {number} скасовано." + (f"\n\nПричина: {reason}" if reason else ""),
    }
    msg = texts.get(status)
    if msg and status not in ("rejected", "cancelled"):
        msg += tail
    return msg


ORDER_TYPES = {"wholesale": "Опт", "retail": "Роздріб"}
RETAIL_EXEMPT = {"cartridge"}          # картриджі в роздробі без націнки

PAYMENT_LABELS = {"cod": "Накладений платіж", "prepaid": "Повна оплата на карту"}


def payment_info(method: str, prepay) -> dict:
    """Спосіб оплати для замовлення. cod = накладений платіж із передоплатою, prepaid = повна оплата на карту."""
    if method == "prepaid":
        return {"method": "prepaid", "label": PAYMENT_LABELS["prepaid"]}
    if not prepay:                       # передоплату вимкнено: чистий накладений платіж
        return {"method": "cod", "label": PAYMENT_LABELS["cod"]}
    amount = Decimal(str(prepay))
    return {"method": "cod", "prepay_amount": money(amount),
            "label": f"{PAYMENT_LABELS['cod']} (передоплата {amount:g} грн)"}


class OrderError(ValueError):
    pass


def order_profit(lines: list, discount=0) -> Decimal | None:
    """Чистий прибуток із замовлення = Σ (ціна продажу − закупівельна) × к-сть − знижка.
    None, якщо в якоїсь позиції невідома закупівельна ціна (тоді прибуток не показуємо, щоб не збрехати)."""
    if any(i.get("profit") is None for i in lines):
        return None
    return money(sum((Decimal(str(i["profit"])) for i in lines), Decimal("0")) - Decimal(str(discount or 0)))


def next_number(db) -> str:
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    c = db.counters.find_one_and_update({"_id": f"order-{today}"}, {"$inc": {"seq": 1}},
                                        upsert=True, return_document=True)
    return f"ORD-{today}-{c['seq']:04d}"


def _num(v) -> str:
    return format(Decimal(str(v)).normalize(), "f")


def full_name(p: dict) -> str:
    """Повна назва позиції: бренд + лінійка + назва + обʼєм, напр. «Chaser Мята 30 мл»."""
    brand = str(p.get("brand") or "").strip()
    name = str(p.get("name") or "").strip()
    vol = ""
    if p.get("category") == "liquid" and p.get("volume_ml"):
        vol = f"{_num(p['volume_ml'])} мл"
    line = ""
    if p.get("category") == "liquid" and p.get("product_line"):
        line = str(p["product_line"])
        if brand:
            line = re.sub(re.escape(brand), " ", line, flags=re.I)
        line = re.sub(r"\b\d+(?:[.,]\d+)?\s*(?:мл|ml)\b", " ", line, flags=re.I)   # обʼєм додаємо окремо
        line = re.sub(r"\s+", " ", line).strip(" -–—·")
    parts = [brand, line, name]
    if brand and name.lower().startswith(brand.lower()):
        parts = [line, name]
    out = " ".join(x for x in parts if x)
    if vol and vol.lower() not in out.lower():
        out += " " + vol
    return re.sub(r"\s+", " ", out).strip()


def title_and_attrs(p: dict, mg=None) -> tuple[str, list]:
    """Заголовок позиції та характеристики (смак, об'єм, колір ...) для чека. Фіксуються в замовленні."""
    cat, brand, name = p.get("category"), str(p.get("brand") or "").strip(), str(p.get("name") or "").strip()
    attrs: list = []
    vol = p.get("volume_ml")
    if cat == "liquid":
        line = str(p.get("product_line") or "")
        if brand:
            line = re.sub(re.escape(brand), " ", line, flags=re.I)
        line = re.sub(r"\b\d+(?:[.,]\d+)?\s*(?:мл|ml|mg|мг)\b", " ", line, flags=re.I)
        title = re.sub(r"\s+", " ", f"{brand} {line}").strip(" -–—·") or brand or name
        attrs.append(["Смак", name])
        if vol:
            attrs.append(["Об'єм", f"{_num(vol)} мл"])
        strength = mg if mg is not None else p.get("nicotine_mg")
        if strength:
            attrs.append(["Міцність", f"{_num(strength)} мг"])
    elif cat == "pod":
        model = str(p.get("model") or "").strip()
        title = f"{brand} {model}".strip() if model else name
        if p.get("variant"):
            attrs.append(["Колір", str(p["variant"])])
    elif cat == "cartridge":
        title = name
        if p.get("pack_size"):
            attrs.append(["В упаковці", f"{_num(p['pack_size'])} шт"])
    else:
        title = name
        if vol:
            attrs.append(["Об'єм", f"{_num(vol)} мл"])
    return title, [a for a in attrs if a[1]]


def fill_display_names(db, orders: list) -> None:
    """Для старих замовлень без display_name — підтягує повну назву з каталогу."""
    from bson import ObjectId
    ids = {i["product_id"] for o in orders for i in o.get("items", []) if not i.get("display_name") and i.get("product_id")}
    if not ids:
        return
    oids = []
    for x in ids:
        try:
            oids.append(ObjectId(x))
        except Exception:
            pass
    prods = {str(p["_id"]): load(p) for p in db.products.find({"_id": {"$in": oids}})}
    for o in orders:
        for i in o.get("items", []):
            if not i.get("display_name"):
                p = prods.get(str(i.get("product_id")))
                i["display_name"] = full_name(p) if p else i.get("name")


def create_order(db, customer: dict, items: list, admin: str, min_total=None, extra: dict | None = None,
                 discount=0, order_type: str = "wholesale", retail_markup=0, discount_tiers=None, promo: dict | None = None) -> dict:
    """promo = {code, percent}: уже перевірений і «використаний» промокод (services/promo.py). Додається до знижки за сумою."""
    if order_type not in ORDER_TYPES:
        raise OrderError("Невідомий тип замовлення")
    if not items:
        raise OrderError("Замовлення порожнє")
    merged: dict = {}
    for it in items:                       # однакові товари зливаємо в одну позицію
        qty = int(it["qty"])
        if qty < 1 or qty > 1000:
            raise OrderError("Кількість має бути від 1 до 1000")
        key = (it["product_id"], it.get("nicotine_mg"))      # одна й та сама рідина з різною міцністю — різні позиції
        merged[key] = merged.get(key, 0) + qty
    from bson import ObjectId
    lines, total = [], Decimal("0")
    for (pid, mg), qty in merged.items():
        try:
            p = db.products.find_one({"_id": ObjectId(pid)})
        except Exception:
            p = None
        if not p:
            raise OrderError(f"Товар {pid} не знайдено")
        p = load(p)
        if p.get("status") != "in_stock":
            raise OrderError(f"«{p['name']}» зараз не в наявності")
        if p.get("final_price") is None:
            raise OrderError(f"«{p['name']}» не має кінцевої ціни (невідома категорія)")
        if mg is not None:
            if p.get("category") != "liquid":
                raise OrderError(f"Для «{p['name']}» міцність нікотину не обирається")
            if int(mg) not in liquid_strengths(p.get("nicotine_mg")):
                raise OrderError(f"Для «{p['name']}» міцність {mg} мг недоступна")
        price = money(p["final_price"])            # ціна ВІД СЕРВЕРА, не від клієнта
        if order_type == "retail":
            own = p.get("retail_markup")                                  # націнка конкретного товару має пріоритет
            add = Decimal(str(own)) if own is not None else (Decimal("0") if p.get("category") in RETAIL_EXEMPT else Decimal(str(retail_markup or 0)))
            price = money(price + add)                                    # роздріб: +націнка на кожну одиницю
        total += price * qty
        cost = money(p["purchase_price"]) if p.get("purchase_price") is not None else None   # закупівля фіксується разом із ціною
        title, attrs = title_and_attrs(p, mg)
        line = {"product_id": pid, "name": p["name"], "display_name": full_name(p), "brand": p["brand"],
                "title": title, "attrs": attrs, "category": p.get("category"),
                "qty": qty, "unit_price": price, "discount": Decimal("0.00"), "line_total": money(price * qty)}
        if cost is not None:
            line["purchase_price"] = cost
            line["profit"] = money((price - cost) * qty)
        if mg is not None:
            line["nicotine_mg"] = int(mg)
            line["display_name"] += f" {int(mg)} мг"
        lines.append(line)
    if min_total and total < Decimal(str(min_total)):
        short = Decimal(str(min_total)) - total
        raise OrderError(f"Мінімальна сума замовлення — {min_total} грн. Додайте товарів ще на {short:g} грн.")
    auto_pct = Decimal("0")
    if discount_tiers and order_type in DISCOUNT_ORDER_TYPES:      # знижка за сумою замовлення (опт): від суми товарів до знижки
        auto_pct, auto_amount = discount_for(total, discount_tiers)
        discount = money(Decimal(str(discount or 0)) + auto_amount)
    promo_info = None
    if promo:                                          # промокод: % від суми товарів, разом зі знижкою не більше суми замовлення
        cut = min(promo_amount(total, promo["percent"]), max(money(total) - money(discount or 0), Decimal("0.00")))
        discount = money(D(discount or 0) + cut)
        promo_info = {"code": promo["code"], "percent": D(str(promo["percent"])), "amount": cut}
    t = order_totals(lines, discount)                   # сума = товари − знижка; доставка Новою поштою не додається
    profit = order_profit(lines, t["discount"])
    doc = {"number": next_number(db), "customer": customer, "items": lines, "subtotal": t["subtotal"],
           "discount": t["discount"], "discount_percent": auto_pct, "total": t["total"], "profit": profit, "order_type": order_type, "currency": "UAH", "status": "new", "notes": [], "created_by": admin,
           "created_at": datetime.now(timezone.utc), "updated_at": datetime.now(timezone.utc)}
    if promo_info:
        doc["promo"] = promo_info
    if extra:
        doc.update(extra)
    res = db.orders.insert_one(to_db(doc))
    doc["_id"] = res.inserted_id
    return doc


def set_status(db, number: str, status: str, reason: str = "", admin: str = ""):
    if status not in STATUSES:
        raise OrderError("Невідомий статус")
    now = datetime.now(timezone.utc)
    reason = (reason or "").strip()[:500]
    return db.orders.find_one_and_update(
        {"number": number},
        {"$set": {"status": status, "status_reason": reason, "updated_at": now},
         "$push": {"history": {"status": status, "reason": reason, "by": admin, "at": now}}},
        return_document=True)


def add_note(db, number: str, text: str, admin: str):
    note = {"text": text.strip(), "by": admin, "at": datetime.now(timezone.utc)}
    if not note["text"]:
        raise OrderError("Порожня примітка")
    return db.orders.find_one_and_update({"number": number}, {"$push": {"notes": note}}, return_document=True)
