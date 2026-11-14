"""Каталог для Mini App: плоскі документи MongoDB -> групи з варіантами (смак / колір / опір).

Чиста логіка без доступу до БД. У публічну відповідь НЕ потрапляють: purchase_price, markup, internal,
dedupe_key, sku, деталі compliance (лише булеве `blocked`).
Ціну рахує й перевіряє сервер при створенні замовлення (services.orders), тут вона лише для показу.
"""
import hashlib
import re
from decimal import Decimal

CATEGORY_META = [
    # id, заголовок, підпис, відтінок для ілюстрацій
    ("pod", "Под-системи", "Пристрої та стартові набори", 160),
    ("liquid", "Рідини", "Рідини для вейпів", 285),
    ("cartridge", "Картриджі", "Для сумісних пристроїв", 30),
    ("booster", "Підсилювачі", "Добавки", 200),
]
# Міцності нікотину (мг), які покупець може обрати для будь-якої рідини. Власна міцність товару теж лишається доступною.
LIQUID_STRENGTHS = (50, 65)
_OHM = re.compile(r"\(?\s*(\d+(?:[.,]\d+)?)\s*(?:ohm|om|Ω)\s*\)?", re.I)


def _num(v):
    if v is None:
        return None
    v = float(v) if isinstance(v, Decimal) else v
    return int(v) if float(v).is_integer() else v


def _price(v):
    if v is None:
        return None
    d = Decimal(str(v))
    return int(d) if d == d.to_integral_value() else float(d)


def liquid_strengths(own=None) -> list:
    """Доступні міцності для рідини: 50 і 65 + власна міцність товару (напр. 70 мг у HYPE Hard)."""
    s = set(LIQUID_STRENGTHS)
    n = _num(own) if own else None
    if isinstance(n, int):
        s.add(n)
    return sorted(s)


def _gid(*parts) -> str:
    return hashlib.sha1("|".join(str(p or "").lower() for p in parts).encode("utf-8")).hexdigest()[:10]


def _image_name(p: dict):
    for im in p.get("images") or []:
        if isinstance(im, str) and im:
            return im.replace("\\", "/").rsplit("/", 1)[-1]
    return None


def group_key(p: dict):
    """-> (group_id, group_name, variant_label)"""
    cat, brand, name = p.get("category"), p.get("brand") or "", p.get("name") or ""
    if cat == "liquid" and p.get("product_line"):
        return _gid(cat, brand, p["product_line"]), p["product_line"], name
    if cat == "pod" and p.get("model"):
        gname = f"{brand} {p['model']}".strip()
        return _gid(cat, brand, p["model"]), gname, p.get("variant") or name
    if cat == "cartridge":
        m = _OHM.search(name)
        if m:
            base = re.sub(r"\s+", " ", _OHM.sub(" ", name, count=1)).strip()
            base = re.sub(r"(\d)\s*шт", r"\1 шт", base)
            return _gid(cat, brand, base), base, m.group(1).replace(",", ".") + " Ω"
    return _gid(cat, brand, name, str(p.get("_id"))), name, name


def _variant(p: dict, show_blocked: bool):
    blocked = False
    price = p.get("final_price")
    in_stock = p.get("status") == "in_stock"
    v = {
        "id": str(p["_id"]),
        "label": "",
        "image": f"/img/{_image_name(p)}" if _image_name(p) else None,
        "price": _price(price),
        "rm": _price(p.get("retail_markup")),          # власна роздрібна націнка товару (None = загальна)
        "inStock": in_stock,
        "expected": p.get("status") == "expected",
        "blocked": blocked,
        "hot": bool(p.get("hot")),
        "purchasable": bool(in_stock and not blocked and price is not None),
    }
    if p.get("category") == "liquid":
        n = _num(p.get("nicotine_mg"))
        v["nicotine"] = n if isinstance(n, int) and n > 0 else LIQUID_STRENGTHS[0]   # міцність за замовчуванням для цього смаку
    return v


def _description(g: dict) -> str:
    cat = g["category"]
    if cat == "pod":
        return f"Под-система {g['name']}. Доступна в {len(g['variants'])} варіантах кольору."
    if cat == "liquid":
        return f"{g['name']}. Обирайте смак зі списку нижче."
    if cat == "cartridge":
        return f"Змінні картриджі {g['name']}."
    return g["name"]


def build_catalog(docs: list, show_blocked: bool = True) -> dict:
    groups: dict[str, dict] = {}
    order: list[str] = []
    for p in docs:
        if p.get("status") not in ("in_stock", "expected"):
            continue                                  # «Немає в наявності» у вітрину не потрапляє
        v = _variant(p, show_blocked)
        if v["blocked"] and not show_blocked:
            continue
        gid, gname, vlabel = group_key(p)
        v["label"] = vlabel
        g = groups.get(gid)
        if g is None:
            attrs = {"Бренд": p.get("brand") or "—"}
            if p.get("model"):
                attrs["Модель"] = p["model"]
            if p.get("volume_ml"):
                attrs["Об’єм"] = f"{_num(p['volume_ml'])} мл"
            if p.get("nicotine_mg"):
                attrs["Нікотин"] = f"{_num(p['nicotine_mg'])} мг"
            if p.get("pack_size"):
                attrs["В пачці"] = f"{_num(p['pack_size'])} шт"
            g = groups[gid] = {"id": gid, "name": gname, "category": p.get("category") or "other",
                               "brand": p.get("brand") or "", "image": None, "attributes": attrs,
                               "isNew": False, "isPopular": False, "isHot": False, "variants": []}
            order.append(gid)
        g["image"] = g["image"] or _image_name(p)
        g["variants"].append(v)

    products = []
    for gid in order:
        g = groups[gid]
        g["variants"].sort(key=lambda x: (not x["inStock"], not x["hot"], x["label"].lower()))
        g["isHot"] = any(x["hot"] for x in g["variants"])
        vs = g["variants"]
        if g["category"] == "liquid":
            g["strengths"] = sorted({m for x in vs for m in liquid_strengths(x.get("nicotine"))})
        if len(vs) > 1:
            g["attributes"]["Варіантів"] = str(len(vs))
        prices = [x["price"] for x in vs if x["price"] is not None]
        buyable = [x["price"] for x in vs if x["purchasable"] and x["price"] is not None]
        g["price"] = min(buyable or prices or [0])
        g["purchasable"] = any(x["purchasable"] for x in vs)
        g["expected"] = all(x["expected"] for x in vs)
        g["blocked"] = all(x["blocked"] for x in vs)
        g["description"] = _description(g)
        if g["image"]:
            g["image"] = f"/img/{g['image']}"            # Mini App віддає /img/<файл> з того ж домену
        products.append(g)

    present = {p["category"] for p in products}
    cats = [{"id": i, "title": t, "sub": s, "hue": h} for i, t, s, h in CATEGORY_META if i in present]
    return {"categories": cats, "products": products}
