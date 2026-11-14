"""Звірка наявності з Excel-файлом постачальника, який адміністратор завантажує в dashboard. Чиста логіка: xlsx -> рядки -> план.

Без доступу до БД і мережі (їх підключає routes/sync.py), тому все тестується локально.
Нічого не змінюється автоматично: план лише пропонує зміни, кожну підтверджує або відхиляє адміністратор.

Як читається таблиця:
  * рядок, у якому в колонці B є «МРЦ …», — заголовок лінійки; текст колонки A стає product_line;
  * рядок з назвою в A і статусом у B («В наявності» / «Немає в наявності» / «Очікується…») — товар;
  * решта (назви розділів, шапка, права частина зі знижками) ігнорується.

Що пропонує план:
  * товар є в БД і статус у таблиці інший -> змінити статус (прибув / закінчився);
  * товар з імпорту зник із таблиці -> «немає в наявності»;
  * товару немає в БД, а в таблиці він «в наявності» -> «новий товар»: назва, лінійка, ціна (адмін може їх виправити);
  * «Немає в наявності» для товару, якого ніколи не було в БД, ігнорується (таких у таблиці сотні).
Якщо файл виглядає підозріло (мало збігів, масове зникнення) — додається попередження, але рішення за адміністратором.
"""
import io
import re
from decimal import Decimal, InvalidOperation

from .compliance import classify
from .importer import normalize
from .pricing import purchase_from_final, reprice

STATUS_LABELS = {"in_stock": "В наявності", "expected": "Очікується на прибуття", "unavailable": "Немає в наявності"}
ACTIVE = ("in_stock", "expected")
_RANK = {"in_stock": 3, "expected": 2, "unavailable": 1, "unknown": 0}
_MRC = re.compile(r"м\s*р\s*ц|\bmrc\b", re.I)
_ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\ufeff\u00a0"), " ")
_GENERIC = {"new", "нове", "новинка"}


class SheetError(Exception):
    """Таблицю не вдалося отримати або прочитати."""


# ---------- нормалізація ----------
def clean(v) -> str:
    return re.sub(r"\s+", " ", str(v if v is not None else "").translate(_ZERO_WIDTH)).strip()


def norm_name(v) -> str:
    """Ключ для зіставлення. Повторює чистку першого імпорту: пробіли, «0.4om» -> «0.4 ohm»."""
    return re.sub(r"(\d)\s*om\b", r"\1 ohm", clean(v), flags=re.I).casefold()


def classify_status(text) -> str | None:
    t = clean(text).casefold()
    if not t or t in ("наявність", "наявність товару"):     # порожньо або шапка колонки
        return None
    if t.startswith("немає") or "відсутн" in t:
        return "unavailable"
    if t.startswith("очіку"):
        return "expected"
    if t.startswith("в наявн"):
        return "in_stock"
    return "unknown"


def parse_price(v) -> Decimal | None:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return Decimal(str(v)) if v >= 0 else None
    m = re.search(r"\d+(?:[.,]\d+)?", clean(v).replace(" ", ""))
    try:
        return Decimal(m.group(0).replace(",", ".")) if m else None
    except InvalidOperation:
        return None


def _sig(text) -> tuple:
    """(обʼєм мл, нікотин мг) із назви лінійки."""
    t = clean(text).casefold()
    v, n = re.search(r"(\d{1,3})\s*(?:ml|мл)\b", t), re.search(r"(\d{2,3})\s*mg\b", t)
    return (int(v.group(1)) if v else None, int(n.group(1)) if n else None)


def _tokens(text) -> set:
    toks = re.findall(r"[a-zа-яіїєґ0-9']+", clean(text).casefold())
    return {t for t in toks if t not in _GENERIC and not re.fullmatch(r"\d+(?:ml|мл|mg)", t)}


# ---------- читання таблиці ----------
def parse_workbook(data: bytes) -> list[dict]:
    from openpyxl import load_workbook
    try:
        wb = load_workbook(io.BytesIO(data), data_only=True, read_only=True)   # read_only: картинки всередині файлу не вантажаться в памʼять
    except Exception as e:
        raise SheetError(f"Файл не схожий на xlsx: {e}")
    rows = []
    for ws in wb.worksheets:
        line = None
        for idx, row in enumerate(ws.iter_rows(min_col=1, max_col=3, values_only=True), start=1):
            a, b, c = (list(row) + [None] * 3)[:3]
            name, btxt = clean(a), clean(b)
            if not name or not btxt:
                continue
            if _MRC.search(btxt):
                line = name
                continue
            st = classify_status(btxt)
            if st is None:
                continue
            rows.append({"tab": ws.title, "row": idx, "line": line, "name": name, "status": st,
                         "status_text": btxt, "price": parse_price(c)})
    if not rows:
        raise SheetError("У таблиці не знайдено жодного товару: структура могла змінитися")
    return rows


# ---------- зіставлення з БД ----------
def is_managed(doc: dict) -> bool:
    """Товари, які звіряються з таблицею: усі, крім доданих вручну через «Додати товар» (internal.manual).
    Мітка source_sheet не обовʼязкова: у базі можуть бути товари з іншого імпорту."""
    return not (doc.get("internal") or {}).get("manual")


def _brand_for(tab: str, line: str, known: dict, canon: dict) -> str | None:
    if norm_name(line) in known:
        return known[norm_name(line)]
    cands = [clean(x) for x in tab.split("|") if clean(x)]
    cands = [canon.get(c.casefold(), c) for c in cands]
    if len(cands) == 1:
        return cands[0]
    compact = re.sub(r"[\s\-_]", "", clean(line).casefold())
    for c in cands:
        if re.sub(r"[\s\-_]", "", c.casefold()) in compact:
            return c
    return None


def _guess_brand(r: dict, canon: dict) -> str | None:
    """Бренд для ручного додавання: перше (або перші два) слова назви, якщо такий бренд уже є в каталозі."""
    words = clean(r["name"]).split(" ")
    for n in (2, 1):
        cand = " ".join(words[:n]).casefold()
        if cand and cand in canon:
            return canon[cand]
    return words[0] if words and words[0] else None


def _guess_category(r: dict) -> str | None:
    t = f"{r['tab']} {r['line'] or ''} {r['name']}".casefold()
    if "підсилювач" in t:
        return "booster"
    if "cartridge" in t or "картридж" in t or "картрідж" in t:
        return "cartridge"
    return "pod" if r["tab"].casefold().startswith("девайс") else "liquid"


def _build_new(r: dict, docs: list, markups: dict, known: dict, canon: dict, line_photos: dict):
    """-> (doc, info) або (None, причина). Автододаються лише рідини й підсилювачі з зрозумілою лінійкою."""
    if r["price"] is None:
        return None, "не вказано ціну"
    line, name = r["line"] or "", r["name"]
    if r["tab"].casefold().startswith("девайс"):
        return None, "девайс/картридж: додайте вручну (потрібні модель, колір, ціна в USDT)"
    brand = _brand_for(r["tab"], line, known, canon)
    if not brand:
        return None, "не вдалося визначити бренд"
    booster = "підсилювач" in f"{line} {name}".casefold()
    vol, nic = _sig(line)
    if not booster and vol is None:
        return None, "не вдалося визначити обʼєм"
    raw = {"name": name, "brand": brand, "category": "booster" if booster else "liquid",
           "product_line": line or None, "volume_ml": None if booster else vol,
           "nicotine_mg": None if booster else (nic or 50),     # без вказаної міцності — 50 мг (рішення з Етапу 1)
           "purchase_price_uah": str(r["price"]), "status": r["status"],
           "internal": {"source_sheet": r["tab"], "source_row": r["row"], "added_by": "excel"}}
    try:
        doc = normalize(raw, markups)
    except ValueError as e:
        return None, str(e)
    new_line = norm_name(line) not in known
    photo = line_photos.get(norm_name(line))
    if photo:                                   # новий смак у вже відомій лінійці: фото лінійки підтягується саме
        doc["images"], doc["image_scope"] = photo
    doc["needs_content"] = not photo
    info = {"brand": brand, "line": line, "name": name, "price": doc.get("final_price"),
            "new_line": new_line, "has_photo": bool(photo)}
    return doc, info


def line_index(docs: list) -> dict:
    """{ключ лінійки: {line, brand, volume_ml, nicotine_mg, images, image_scope}} за товарами з БД."""
    idx = {}
    for d in docs:
        pl = d.get("product_line")
        if not pl or not d.get("brand"):
            continue
        e = idx.setdefault(norm_name(pl), {"line": pl, "brand": d["brand"], "volume_ml": d.get("volume_ml"),
                                           "nicotine_mg": d.get("nicotine_mg"), "images": [], "image_scope": None})
        if not e["images"] and d.get("images"):
            e["images"], e["image_scope"] = d["images"], d.get("image_scope") or "line"
    return idx


def finalize_new(doc: dict, markups: dict, *, line=None, final=None, index: dict | None = None) -> dict:
    """Готує документ нового товару до запису з урахуванням правок адміністратора.

    line  — лінійка, яку обрав адмін (None = як запропонувала таблиця);
    final — ціна продажу, яку ввів адмін (None = розрахункова); закупівельна рахується від неї, як у «Редагувати».
    Піднімає ValueError, якщо ціну неможливо застосувати.
    """
    d = dict(doc)
    index = index or {}
    if line is not None and clean(line) != (d.get("product_line") or ""):
        line = clean(line)
        d["product_line"] = line or None
        known = index.get(norm_name(line)) if line else None
        liquid = d.get("category") == "liquid"
        if known:
            d["brand"] = known["brand"]
            if liquid:
                d["volume_ml"] = known["volume_ml"] or d.get("volume_ml")
                d["nicotine_mg"] = known["nicotine_mg"] or d.get("nicotine_mg")
            d["images"], d["image_scope"] = list(known["images"]), (known["image_scope"] if known["images"] else None)
        else:
            vol, nic = _sig(line)
            if liquid:
                d["volume_ml"] = vol or d.get("volume_ml")
                d["nicotine_mg"] = nic or d.get("nicotine_mg")
            d["images"], d["image_scope"] = [], None
        d["needs_content"] = not d["images"]
    if final is not None:
        d["purchase_price"] = purchase_from_final(final, d.get("category"), markups)
        d["usdt"] = None
    d.update(reprice(d, markups))
    d["dedupe_key"] = f"{d['brand']}|{d.get('product_line') or ''}|{d['name'].lower()}"
    d["compliance"] = classify(d.get("category"), d.get("volume_ml"), d.get("nicotine_mg"), d["name"])
    return d


def plan_sync(rows: list, docs: list, markups: dict, *, max_drop: float = 0.35, min_cover: float = 0.5) -> dict:
    managed = [d for d in docs if is_managed(d)]
    by_key, by_name = {}, {}
    for d in managed:
        by_name.setdefault(norm_name(d["name"]), []).append(d)
        if d.get("product_line"):
            by_key.setdefault((norm_name(d["product_line"]), norm_name(d["name"])), []).append(d)

    merged = {}                                 # той самий товар двічі в таблиці: перемагає «краща» наявність
    for r in rows:
        k = (norm_name(r["line"] or ""), norm_name(r["name"]))
        if k not in merged or _RANK[r["status"]] > _RANK[merged[k]["status"]]:
            merged[k] = r

    def find(r):
        hit = by_key.get((norm_name(r["line"] or ""), norm_name(r["name"])))
        if hit:
            return hit[0]
        pool = by_name.get(norm_name(r["name"]), [])
        nol = [d for d in pool if not d.get("product_line")]
        if len(nol) == 1:                       # под-системи й картриджі: лише за назвою
            return nol[0]
        wl = [d for d in pool if d.get("product_line")]
        if len(wl) == 1:                        # лінійку могли трохи перейменувати: той самий обʼєм/міцність і схожа назва
            a, b = _tokens(wl[0]["product_line"]), _tokens(r["line"])
            if _sig(wl[0]["product_line"]) == _sig(r["line"]) and a and b and len(a & b) / len(a | b) >= 0.6:
                return wl[0]
        return None

    matched, unmatched = {}, []
    for r in merged.values():
        d = find(r)
        if d is None:
            unmatched.append(r)
        elif d["_id"] not in matched or _RANK[r["status"]] > _RANK[matched[d["_id"]][1]["status"]]:
            matched[d["_id"]] = (d, r)

    def upd(d, to, why):
        return {"id": d["_id"], "name": d["name"], "brand": d.get("brand"),
                "line": d.get("product_line") or d.get("model"), "from": d.get("status"), "to": to, "why": why}

    updates, unknown = [], []
    for d in managed:
        hit = matched.get(d["_id"])
        if hit is None:
            if d.get("status") in ACTIVE:
                updates.append(upd(d, "unavailable", "зник із таблиці"))
            continue
        st = hit[1]["status"]
        if st == "unknown":
            unknown.append({"name": d["name"], "text": hit[1]["status_text"]})
        elif st != d.get("status"):
            updates.append(upd(d, st, "у таблиці: " + STATUS_LABELS[st].lower()))

    # ---- нові позиції ----
    known = {norm_name(d["product_line"]): d["brand"] for d in docs if d.get("product_line") and d.get("brand")}
    canon = {d["brand"].casefold(): d["brand"] for d in docs if d.get("brand")}
    line_photos = {}
    for d in docs:
        if d.get("product_line") and d.get("images"):
            line_photos.setdefault(norm_name(d["product_line"]), (d["images"], d.get("image_scope") or "line"))
    have = {d["dedupe_key"] for d in docs if d.get("dedupe_key")}
    inserts, new_info, manual, ignored, already = [], [], [], 0, 0
    for r in unmatched:
        if r["status"] == "unavailable":
            ignored += 1
        elif r["status"] == "unknown":
            continue                            # службові рядки без статусу (0, службові написи): не товар
        else:
            doc, info = _build_new(r, docs, markups, known, canon, line_photos)
            if doc is not None and doc["dedupe_key"] in have:       # такий товар уже є в каталозі: не «новий»
                already += 1
                continue
            if doc is None:
                manual.append({"tab": r["tab"], "line": r["line"] or "", "name": r["name"], "why": info,
                               # те, що кнопка «Додати» підставляє у форму: назва, ціна й статус з таблиці + підказки
                               "price": str(r["price"]) if r["price"] is not None else None, "status": r["status"],
                               "brand": _guess_brand(r, canon), "category": _guess_category(r)})
            else:
                inserts.append(doc)
                new_info.append({**info, "tab": r["tab"]})

    # ---- попередження (рішення все одно за адміністратором) ----
    warnings = []
    active_now = sum(1 for d in managed if d.get("status") in ACTIVE)
    drops = [u for u in updates if u["to"] == "unavailable" and u["from"] in ACTIVE]
    if managed and len(matched) < min_cover * len(managed):
        warnings.append(f"Збігів лише {len(matched)} із {len(managed)} товарів у базі: схоже, це не повний прайс або "
                        f"змінилась структура таблиці. Уважно перевірте позиції «зник із таблиці».")
    elif len(drops) > max(15, max_drop * active_now):
        warnings.append(f"Одночасно закінчується {len(drops)} із {active_now} позицій в наявності. Перевірте, чи це правильний файл.")
    if unknown:
        ex = ", ".join(f"«{u['name']}» ({u['text']})" for u in unknown[:3])
        warnings.append(f"Рядків із незрозумілим статусом: {len(unknown)} — їх пропущено (напр. {ex}).")

    report = {"sheet_rows": len(rows), "managed": len(managed), "matched": len(matched),
              "to_unavailable": sum(1 for u in updates if u["to"] == "unavailable"),
              "to_in_stock": sum(1 for u in updates if u["to"] == "in_stock"),
              "to_expected": sum(1 for u in updates if u["to"] == "expected"),
              "new": len(inserts), "manual": len(manual), "unknown_status": len(unknown),
              "ignored_unavailable_new": ignored, "already_in_catalog": already}
    return {"updates": updates, "inserts": inserts, "new_info": new_info, "manual": manual,
            "unknown": unknown, "warnings": warnings, "report": report}
