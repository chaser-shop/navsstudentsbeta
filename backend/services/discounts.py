"""Знижки за сумою замовлення (опт). Чиста логіка: рівні -> відсоток -> сума знижки.

Рівень діє, коли сума товарів У ЗАМОВЛЕННІ (до знижки) не менша за поріг «від».
Рівні задає адмін у dashboard (db.settings.discount_tiers); поки не задано — DEFAULT_TIERS.
"""
from decimal import Decimal

from .pricing import D, money

DEFAULT_TIERS = [{"from": 10000, "percent": 2}, {"from": 20000, "percent": 3}, {"from": 30000, "percent": 4},
                 {"from": 40000, "percent": 5}, {"from": 50000, "percent": 6}, {"from": 70000, "percent": 8},
                 {"from": 90000, "percent": 10}]
DISCOUNT_ORDER_TYPES = {"wholesale"}          # у роздробі знижок за сумою немає


def normalize_tiers(raw) -> list:
    """Список {from, percent} -> відсортований, без дублікатів порогу. ValueError, якщо дані некоректні."""
    if not isinstance(raw, list) or len(raw) > 30:
        raise ValueError("Знижки: очікується список рівнів (до 30)")
    out = {}
    for t in raw:
        try:
            frm, pct = D(str(t["from"]).replace(",", ".")), D(str(t["percent"]).replace(",", "."))
        except Exception:
            raise ValueError("Знижки: поріг і відсоток мають бути числами")
        if not (frm.is_finite() and pct.is_finite()) or frm <= 0 or frm > 100_000_000:
            raise ValueError("Знижки: поріг (від, грн) має бути більшим за 0")
        if not 0 < pct <= 100:
            raise ValueError("Знижки: відсоток має бути від 0 до 100")
        out[frm] = pct
    return [{"from": int(k) if k == k.to_integral_value() else float(k),
             "percent": int(v) if v == v.to_integral_value() else float(v)} for k, v in sorted(out.items())]


def tier_for(subtotal, tiers: list) -> dict | None:
    """Найвищий рівень, поріг якого досягнуто."""
    best = None
    for t in tiers or []:
        if D(subtotal) >= D(str(t["from"])) and (best is None or D(str(t["from"])) > D(str(best["from"]))):
            best = t
    return best


def next_tier(subtotal, tiers: list) -> dict | None:
    """Найближчий рівень, якого ще не досягнуто (для підказки «додайте ще на …»)."""
    higher = [t for t in tiers or [] if D(str(t["from"])) > D(subtotal)]
    return min(higher, key=lambda t: D(str(t["from"]))) if higher else None


def discount_for(subtotal, tiers: list) -> tuple[Decimal, Decimal]:
    """-> (відсоток, сума знижки в грн, округлення до копійок)."""
    t = tier_for(subtotal, tiers)
    if not t:
        return Decimal("0"), Decimal("0.00")
    pct = D(str(t["percent"]))
    return pct, money(D(subtotal) * pct / 100)
