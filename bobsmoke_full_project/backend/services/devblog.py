"""Dev-blog: охайні сповіщення адміністраторам у Telegram про зміни в каталозі.

Що приходить у чат (BOT_ALLOWED_IDS):
  ➕ Додано   — нові товари;
  ➖ Прибрано — видалені товари / лінійки;
  ✏️ Змінено  — що саме змінилось (було → стало): ціна, статус, назва, фото тощо.

Модуль складається з чистих функцій (порівняння й оформлення, без БД та мережі — легко тестуються)
і однієї точки відправки `publish`, яка не ламає основну дію, якщо Telegram недоступний.
"""
import html
import logging
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from .pricing import CATEGORY_LABELS, D, money

log = logging.getLogger("devblog")

STATUS_LABELS = {"in_stock": "В наявності", "expected": "Очікується", "unavailable": "Немає в наявності"}
STATUS_ICONS = {"in_stock": "✅", "expected": "⏳", "unavailable": "⛔"}

LINE = "▔" * 16
MAX_LEN = 3900                  # ліміт Telegram — 4096; лишаємо запас під теги
PER_SECTION = 15                # скільки позицій показувати в одному розділі


# ---------- форматування значень ----------
def _price(v) -> str:
    if v in (None, ""):
        return "—"
    try:
        q = money(D(v))
    except (InvalidOperation, ValueError, ArithmeticError):
        return str(v)
    s = f"{q:,.2f}".replace(",", "\u202f")
    return (s[:-3] if s.endswith(".00") else s) + " ₴"


def _status(v) -> str:
    return f"{STATUS_ICONS.get(v, '')} {STATUS_LABELS.get(v, v or '—')}".strip()


def _plain(v) -> str:
    return "—" if v in (None, "") else str(v)


def _ml(v) -> str:
    return "—" if v in (None, "") else f"{v} мл"


def _mg(v) -> str:
    return "—" if v in (None, "") else f"{v} мг"


def _yesno(v) -> str:
    return "🔥 так" if v else "ні"


def _count(v) -> str:
    return f"{len(v or [])} шт"


def _category(v) -> str:
    return CATEGORY_LABELS.get(v, v or "—")


# поле в БД -> (підпис, форматер). Службові поля (markup, dedupe_key, updated_at …) не відстежуються.
TRACKED = {
    "name": ("Назва", _plain),
    "brand": ("Бренд", _plain),
    "product_line": ("Лінійка", _plain),
    "model": ("Модель", _plain),
    "variant": ("Варіант", _plain),
    "category": ("Категорія", _category),
    "status": ("Статус", _status),
    "final_price": ("Ціна", _price),
    "retail_markup": ("Роздрібна націнка", _price),
    "volume_ml": ("Обʼєм", _ml),
    "nicotine_mg": ("Нікотин", _mg),
    "pack_size": ("Фасування", _plain),
    "sku": ("Артикул", _plain),
    "hot": ("Хіт", _yesno),
    "images": ("Фото", _count),
}


def _norm(field: str, v):
    """Приводить значення до порівнюваного вигляду (Decimal('450.00') == 450, [] == None тощо)."""
    if field == "images":
        return list(v or [])
    if field == "hot":
        return bool(v)
    if field in ("final_price", "retail_markup") and v not in (None, ""):
        try:
            return money(D(v))
        except (InvalidOperation, ValueError, ArithmeticError):
            return v
    return None if v == "" else v


# ---------- побудова записів ----------
def snapshot(p: dict, archived: bool = False) -> dict:
    """Короткий опис товару для розділів «Додано» / «Прибрано». archived=True — фото збережено в архіві."""
    facts = []
    if p.get("final_price") is not None:
        facts.append(_price(p["final_price"]))
    if p.get("status"):
        facts.append(_status(p["status"]))
    if p.get("images"):
        facts.append("📷 фото збережено" if archived else "📷 з фото")
    return {"name": p.get("name") or "Без назви", "brand": p.get("brand") or "", "line": p.get("product_line") or "",
            "facts": facts}


def diff_product(old: dict, new: dict) -> list[tuple]:
    """[(підпис, було, стало)] лише для полів, які справді змінились."""
    out = []
    for field, (label, fmt) in TRACKED.items():
        a, b = _norm(field, old.get(field)), _norm(field, new.get(field))
        if a != b:
            out.append((label, fmt(old.get(field)), fmt(new.get(field))))
    return out


def change_entry(old: dict, new: dict, note: str = "") -> dict | None:
    """Запис для розділу «Змінено» або None, якщо відстежувані поля не змінились."""
    diffs = diff_product(old, new)
    if not diffs:
        return None
    return {"name": new.get("name") or old.get("name") or "Без назви", "brand": new.get("brand") or "",
            "line": new.get("product_line") or "", "diffs": diffs, "note": note}


# ---------- оформлення ----------
def _e(s) -> str:
    return html.escape(str(s), quote=False)


def _title(e: dict) -> str:
    sub = " · ".join(x for x in (e.get("brand"), e.get("line")) if x)
    return f"<b>{_e(e['name'])}</b>" + (f"\n    <i>{_e(sub)}</i>" if sub else "")


def _block_added(e: dict) -> str:
    extra = list(e.get("facts") or []) + ([e["note"]] if e.get("note") else [])
    return f"▫️ {_title(e)}" + (f"\n    {_e(' · '.join(extra))}" if extra else "")


def _block_changed(e: dict) -> str:
    rows = [f"    ┕ {_e(l)}: <s>{_e(a)}</s> → <b>{_e(b)}</b>" for l, a, b in e.get("diffs", [])]
    if e.get("note"):
        rows.append(f"    ┕ <i>{_e(e['note'])}</i>")
    return f"▫️ {_title(e)}" + ("\n" + "\n".join(rows) if rows else "")


def _section(icon: str, caption: str, items: list, block, cap: int) -> str:
    if not items:
        return ""
    shown = [block(i) for i in items[:cap]]
    rest = len(items) - cap
    if rest > 0:
        shown.append(f"<i>…та ще {rest}</i>")
    return f"{icon} <b>{caption} · {len(items)}</b>\n" + "\n".join(shown)


def _kyiv(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    try:
        from zoneinfo import ZoneInfo
        return dt.astimezone(ZoneInfo("Europe/Kyiv"))
    except Exception:                       # немає tzdata: показуємо UTC, а не падаємо
        return dt.astimezone(timezone.utc)


def render(added: list, removed: list, changed: list, *, source: str = "", actor: str = "",
           now: datetime | None = None) -> str:
    """HTML-текст для sendMessage (parse_mode=HTML). Завжди вкладається в ліміт Telegram."""
    when = _kyiv(now or datetime.now(timezone.utc)).strftime("%d.%m.%Y · %H:%M")
    head = "🛠 <b>DEV-BLOG</b>  ·  Каталог" + (f"\n<i>{_e(source)}</i>" if source else "")
    summary = " · ".join(x for x in (f"➕ {len(added)}" if added else "", f"➖ {len(removed)}" if removed else "",
                                      f"✏️ {len(changed)}" if changed else "") if x)
    foot = (f"👤 {_e(actor)} · " if actor else "") + f"🕒 {when}"
    cap = PER_SECTION
    while True:
        parts = [_section("➕", "Додано", added, _block_added, cap),
                 _section("➖", "Прибрано", removed, _block_added, cap),
                 _section("✏️", "Змінено", changed, _block_changed, cap)]
        text = f"{head}\n{LINE}\n\n" + "\n\n".join(p for p in parts if p) + f"\n\n{LINE}\n{foot}\n<code>{summary}</code>"
        if len(text) <= MAX_LEN or cap <= 1:
            return text[:4090] if len(text) > 4090 else text      # крайній випадок: сотні довгих назв
        cap = max(1, cap // 2)


# ---------- відправка ----------
def publish(added=None, removed=None, changed=None, *, source: str = "", actor: str = "", bg=None) -> str | None:
    """Складає й надсилає повідомлення операторам. Нічого не робить, якщо змін немає.
    bg — fastapi BackgroundTasks: відправка йде після відповіді клієнту, тож панель не чекає на Telegram.
    Помилки лише логуються: зміна в каталозі вже збережена й не має падати через сповіщення."""
    added, removed, changed = list(added or []), list(removed or []), list(changed or [])
    if not (added or removed or changed):
        return None
    try:
        from .telegram_api import notify_operators
        text = render(added, removed, changed, source=source, actor=actor)
        if bg is not None:
            bg.add_task(notify_operators, text, parse_mode="HTML")
        else:
            notify_operators(text, parse_mode="HTML")
        return text
    except Exception:
        log.exception("Не вдалося надіслати dev-blog")
        return None
