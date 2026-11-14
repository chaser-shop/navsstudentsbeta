"""Лінійки товарів: групова зміна цін опт + роздріб. Чиста логіка, без БД.

Лінійка товару = власна (custom_line, задає адмін) → лінійка з прайсу (product_line) → група з магазину
(модель под-системи, картриджі однієї моделі, або сам товар). Тож кожен товар належить до якоїсь лінійки.
Опт = final_price; роздріб = опт + retail_markup товару (або загальна націнка; картриджі за замовчуванням без націнки).
"""
import hashlib
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from .catalog import group_key
from .pricing import D, money, purchase_from_final, reprice

EXEMPT = frozenset({"cartridge"})


class LineError(ValueError):
    pass


def _clean(s) -> str:
    return " ".join(str(s or "").split())


def _h(*parts) -> str:
    return hashlib.sha1("|".join(str(x).casefold() for x in parts).encode("utf-8")).hexdigest()[:10]


def line_of(p: dict) -> tuple[str, str]:
    """-> (ключ, назва лінійки)."""
    custom = _clean(p.get("custom_line"))
    if custom:
        return "c" + _h(custom), custom
    pl = _clean(p.get("product_line"))
    if pl:
        return "p" + _h(p.get("category"), p.get("brand"), pl), pl
    gid, gname, _ = group_key(p)
    return "g" + gid, gname


def retail_price(p: dict, general, exempt=EXEMPT):
    if p.get("final_price") is None:
        return None
    own = p.get("retail_markup")
    add = D(own) if own is not None else (D(0) if p.get("category") in exempt else D(general))
    return money(D(p["final_price"]) + add)


def fmt(v) -> str | None:
    if v is None:
        return None
    s = format(money(v), "f")
    return s[:-3] if s.endswith(".00") else s


def apply_op(current: Decimal, op: dict) -> Decimal:
    """set — задати ціну; shift — змінити на ± грн; percent — змінити на ± % (до цілої гривні)."""
    try:
        v = D(op.get("value"))
    except (InvalidOperation, ValueError):
        raise LineError("Некоректне число")
    mode = op.get("mode")
    if mode == "set":
        r = v
    elif mode == "shift":
        r = D(current) + v
    elif mode == "percent":
        r = (D(current) * (D(100) + v) / D(100)).quantize(Decimal("1"), ROUND_HALF_UP)
    else:
        raise LineError("Невідомий режим зміни ціни")
    r = money(r)
    if r < 0:
        raise LineError("Ціна не може бути від’ємною")
    return r


def summarize(docs: list, general, exempt=EXEMPT) -> list:
    """Усі лінійки з діапазонами оптової та роздрібної ціни й складом."""
    acc: dict = {}
    for p in docs:
        key, name = line_of(p)
        e = acc.setdefault(key, {"key": key, "name": name, "count": 0, "in_stock": 0, "cats": {}, "brands": set(), "w": [], "r": [], "items": [], "image": None})
        e["count"] += 1
        e["in_stock"] += p.get("status") == "in_stock"
        e["cats"][p.get("category") or ""] = e["cats"].get(p.get("category") or "", 0) + 1
        if p.get("brand"):
            e["brands"].add(p["brand"])
        r = retail_price(p, general, exempt)
        if p.get("final_price") is not None:
            e["w"].append(money(p["final_price"]))
            e["r"].append(r)
        if not e["image"]:
            im = next((x for x in (p.get("images") or []) if isinstance(x, str) and x), None)
            e["image"] = im.replace("\\", "/").rsplit("/", 1)[-1] if im else None
        e["items"].append({"id": str(p["_id"]), "name": p.get("name"), "status": p.get("status"),
                           "wholesale": fmt(p.get("final_price")), "retail": fmt(r)})
    out = []
    for e in acc.values():
        rng = lambda xs: {"min": fmt(min(xs)), "max": fmt(max(xs))} if xs else {"min": None, "max": None}
        out.append({"key": e["key"], "name": e["name"], "count": e["count"], "in_stock": e["in_stock"],
                    "category": max(e["cats"], key=e["cats"].get), "brands": sorted(e["brands"]), "image": e["image"],
                    "wholesale": rng(e["w"]), "retail": rng(e["r"]), "items": sorted(e["items"], key=lambda i: str(i["name"]).casefold())})
    return sorted(out, key=lambda x: (x["category"], x["name"].casefold()))


def plan_prices(products: list, wholesale: dict | None, retail: dict | None, reset_retail: bool,
                markups: dict, general, exempt=EXEMPT) -> dict:
    """Рахує нові ціни всіх товарів лінійки. Без правки роздробу він «їде» за оптом (націнка зберігається).
    -> {"changes": [{id, name, old, new, patch}], "errors": [{id, name, reason}], "unchanged": n}"""
    changes, errors, same = [], [], 0
    for p in products:
        pid, name = str(p["_id"]), p.get("name")
        try:
            w, r = p.get("final_price"), retail_price(p, general, exempt)
            if w is None and (wholesale or retail):
                raise LineError("немає оптової ціни")
            nw = apply_op(w, wholesale) if wholesale else (money(w) if w is not None else None)
            if reset_retail:
                new_rm = None
            elif retail:
                nr = apply_op(r, retail)
                if nr < nw:
                    raise LineError(f"роздріб {fmt(nr)} нижчий за опт {fmt(nw)}")
                new_rm = money(nr - nw)
            else:
                new_rm = p.get("retail_markup")
            patch = {}
            if wholesale and nw != money(w):
                try:
                    purchase = purchase_from_final(nw, p.get("category"), markups)
                except ValueError as e:
                    raise LineError(str(e))
                merged = {**p, "purchase_price": purchase, "usdt": None}
                patch.update({"purchase_price": purchase, "usdt": None, **reprice(merged, markups)})
            if (new_rm is None) != (p.get("retail_markup") is None) or (new_rm is not None and money(new_rm) != money(p["retail_markup"])):
                patch["retail_markup"] = None if new_rm is None else money(new_rm)
            nr_final = retail_price({**p, "final_price": nw, "retail_markup": patch.get("retail_markup", p.get("retail_markup"))}, general, exempt)
            if not patch:
                same += 1
                continue
            changes.append({"id": pid, "name": name, "old": {"wholesale": fmt(w), "retail": fmt(r)},
                            "new": {"wholesale": fmt(nw), "retail": fmt(nr_final)}, "patch": patch})
        except LineError as e:
            errors.append({"id": pid, "name": name, "reason": str(e)})
    return {"changes": changes, "errors": errors, "unchanged": same}
