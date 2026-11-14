"""Закритий Telegram-бот оператора. Запуск: python -m bot.main"""
import os

from backend import config  # noqa: F401  (завантажує .env до читання змінних)

import telebot
from telebot import types

from backend.services.validators import normalize_phone

from .api import Api, ApiError
from .novaposhta import NovaPoshta, NPError

TOKEN = os.environ.get("BOT_TOKEN", "")
ALLOWED = {int(x) for x in os.environ.get("BOT_ALLOWED_IDS", "").replace(" ", "").split(",") if x.isdigit()}
CATS = [("liquid", "Рідини"), ("pod", "Под-системи"), ("cartridge", "Картриджі"), ("booster", "Підсилювачі")]
PAGE = 8
S: dict = {}   # стан розмови по chat_id (у пам'яті; кошик зберігається в MongoDB через API)

api = Api()
np_client = None
bot = telebot.TeleBot(TOKEN, parse_mode=None) if TOKEN else None


def money(v):
    return "—" if v is None else f"{float(v):g} грн"


def st(cid):
    return S.setdefault(cid, {"state": None, "view": {}, "items": [], "co": {}})


def kb(rows):
    m = types.InlineKeyboardMarkup()
    for r in rows:
        m.row(*[types.InlineKeyboardButton(t, callback_data=d) for t, d in r])
    return m


def main_menu():
    m = types.ReplyKeyboardMarkup(resize_keyboard=True)
    m.row("🛍 Каталог", "🔎 Пошук")
    m.row("🛒 Кошик", "📦 Замовлення")
    return m


def show(cid, text, markup=None, msg=None):
    try:
        if msg:
            bot.edit_message_text(text, cid, msg.message_id, reply_markup=markup)
        else:
            bot.send_message(cid, text, reply_markup=markup)
    except Exception:
        bot.send_message(cid, text, reply_markup=markup)


def guard(fn):
    def w(arg):
        uid = arg.from_user.id
        if uid not in ALLOWED:
            bot.send_message(arg.chat.id if hasattr(arg, "chat") else arg.message.chat.id, "Доступу немає.")
            return
        try:
            fn(arg)
        except (ApiError, NPError) as e:
            bot.send_message(arg.chat.id if hasattr(arg, "chat") else arg.message.chat.id, f"⚠️ {e}")
    return w


# ---------- каталог ----------
def categories(cid, msg=None):
    show(cid, "Оберіть категорію:", kb([[(l, f"c:{k}")] for k, l in CATS]), msg)


def brands(cid, cat, msg=None):
    names = api.call("GET", "/api/brands", params={"category": cat})
    st(cid)["view"] = {"cat": cat, "brands": names}
    rows = [[(b, f"b:{i}")] for i, b in enumerate(names)] + [[("⬅️ Назад", "home")]]
    show(cid, "Оберіть бренд:" if names else "У цій категорії порожньо.", kb(rows), msg)


def product_list(cid, page=1, msg=None):
    v = st(cid)["view"]
    params = {"page": page, "limit": PAGE, "category": v.get("cat", ""), "brand": v.get("brand", ""), "q": v.get("q", "")}
    d = api.call("GET", "/api/products", params=params)
    st(cid)["items"] = d["items"]
    if not d["items"]:
        show(cid, "Нічого не знайдено. Спробуйте інший запит або поверніться до каталогу.", kb([[("🛍 Каталог", "home")]]), msg)
        return
    rows = []
    for i, p in enumerate(d["items"]):
        mark = "⏳ " if p["status"] == "expected" else ""
        rows.append([(f"{mark}{p['name']} · {money(p['final_price'])}"[:60], f"i:{i}")])
    nav = []
    if page > 1:
        nav.append(("◀️", f"p:{page-1}"))
    nav.append((f"{page}/{d['pages']}", "noop"))
    if page < d["pages"]:
        nav.append(("▶️", f"p:{page+1}"))
    rows += [nav, [("⬅️ Назад", "home")]]
    show(cid, f"Знайдено: {d['total']}", kb(rows), msg)


def product_card(cid, idx, msg):
    p = st(cid)["items"][idx]
    d = api.call("GET", f"/api/products/{p['id']}")
    lines = [d["name"], f"{d['brand']} · {d['category_label']}", f"Статус: {d['status_label']}",
             f"Ціна: {money(d['final_price'])}" + (f" · {d['final_price_usdt']} USDT" if d.get("final_price_usdt") else "")]
    if d.get("volume_ml"):
        lines.append(f"Об'єм: {d['volume_ml']:g} мл")
    if d.get("nicotine_mg"):
        lines.append(f"Нікотин: {d['nicotine_mg']:g} мг")
    rows = []
    if d["status"] == "in_stock" and d["final_price"] is not None:
        rows.append([("➕ В кошик", f"a:{idx}")])
    else:
        lines.append("Зараз недоступно для замовлення.")
    rows.append([("⬅️ До списку", f"p:{st(cid)['view'].get('page', 1)}")])
    show(cid, "\n".join(lines), kb(rows), msg)


# ---------- кошик ----------
def cart(cid, msg=None):
    c = api.call("GET", f"/api/bot/cart/{cid}")
    items = c["items"]
    st(cid)["cart"] = items
    if not items:
        show(cid, "Кошик порожній.", kb([[("🛍 Каталог", "home")]]), msg)
        return
    total, rows, txt = 0.0, [], []
    for i, it in enumerate(items):
        line = float(it["unit_price"] or 0) * it["qty"]
        total += line
        txt.append(f"{it.get('display_name') or it['name']}: {it['qty']} × {money(it['unit_price'])} = {money(line)}")
        rows.append([("➖", f"k-{i}"), (f"{it['qty']}", "noop"), ("➕", f"k+{i}"), ("🗑", f"kx{i}")])
    rows.append([("🧹 Очистити", "kc"), ("✅ Оформити", "ko")])
    show(cid, "\n".join(txt) + f"\n\nРазом: {money(total)} (остаточно рахує сервер)", kb(rows), msg)


def save_cart(cid, items):
    api.call("PUT", f"/api/bot/cart/{cid}", json={"items": [{"product_id": i["product_id"], "qty": i["qty"]} for i in items if i["qty"] > 0]})


# ---------- оформлення ----------
def ask(cid, state, text):
    st(cid)["state"] = state
    bot.send_message(cid, text, reply_markup=types.ReplyKeyboardRemove())


def city_results(cid, text):
    global np_client
    np_client = np_client or NovaPoshta(os.environ.get("NOVA_POSHTA_API_KEY", ""))
    res = np_client.search_cities(text)
    if not res:
        bot.send_message(cid, "Місто не знайдено. Введіть назву ще раз:")
        return
    st(cid)["co"]["cities"] = res
    rows = [[(c["present"][:60], f"s:{i}")] for i, c in enumerate(res)]
    st(cid)["state"] = None
    bot.send_message(cid, "Оберіть місто (область вказана поруч):", reply_markup=kb(rows))


def warehouse_list(cid, page=1, find="", msg=None):
    co = st(cid)["co"]
    co["wfind"], co["wpage"] = find, page
    ws = np_client.warehouses(co["city_ref"], find, page, PAGE)
    co["wlist"] = ws
    if not ws:
        show(cid, "Відділень не знайдено. Надішліть номер відділення або інший пошуковий запит:", None, msg)
        st(cid)["state"] = "wfind"
        return
    rows = [[(w["title"][:60], f"w:{i}")] for i, w in enumerate(ws)]
    rows.append([("◀️", f"wp:{page-1}")] * (page > 1) + [("▶️", f"wp:{page+1}")] * (len(ws) == PAGE))
    rows.append([("🔎 Знайти за номером/вулицею", "wf")])
    show(cid, f"Відділення Нової пошти, {co['city']} (стор. {page}):", kb([r for r in rows if r]), msg)


def confirm(cid):
    co = st(cid)["co"]
    items = st(cid).get("cart", [])
    total = sum(float(i["unit_price"] or 0) * i["qty"] for i in items)
    txt = (f"Перевірте замовлення:\n{co['fn']} {co['ln']}\n{co['phone']}\n{co['city']} ({co['area']})\n{co['warehouse']}\n\n"
           + "\n".join(f"{i['name']} × {i['qty']}" for i in items) + f"\n\nОрієнтовно: {money(total)}")
    bot.send_message(cid, txt, reply_markup=kb([[("✅ Створити", "go"), ("✖️ Скасувати", "cancel")]]))


def create_order(cid):
    co, items = st(cid)["co"], st(cid).get("cart", [])
    o = api.call("POST", "/api/orders", json={
        "customer_name": f"{co['fn']} {co['ln']}", "phone": co["phone"],
        "delivery": {"city": co["city"], "area": co["area"], "warehouse": co["warehouse"],
                     "city_ref": co["city_ref"], "warehouse_ref": co["warehouse_ref"]},
        "items": [{"product_id": i["product_id"], "qty": i["qty"]} for i in items]})
    save_cart(cid, [])
    st(cid)["co"] = {}
    bot.send_message(cid, f"✅ Замовлення {o['number']} створено. Сума: {money(o['total'])}.\nДані доставки збережені в адмін-панелі.",
                     reply_markup=main_menu())


def my_orders(cid):
    d = api.call("GET", "/api/orders")
    if not d["items"]:
        bot.send_message(cid, "Замовлень ще немає.")
        return
    bot.send_message(cid, "\n\n".join(
        f"{o['number']} · {o['created_at'][:10]}\n{o['customer']['name']} · {money(o['total'])} · {d['statuses'][o['status']]}"
        for o in d["items"][:5]))


# ---------- обробники ----------
if bot:
    @bot.message_handler(commands=["start"])
    def start(m):
        if m.from_user.id not in ALLOWED:
            bot.send_message(m.chat.id, "Доступу немає.")
            return
        st(m.chat.id)["state"] = None
        bot.send_message(m.chat.id, "Вітаю! Оберіть дію:", reply_markup=main_menu())

    @bot.message_handler(func=lambda m: True)
    @guard
    def text(m):
        cid, t, s = m.chat.id, (m.text or "").strip(), st(m.chat.id)
        if t == "🛍 Каталог":
            s["state"] = None
            return categories(cid)
        if t == "🔎 Пошук":
            return ask(cid, "search", "Введіть назву, бренд або модель:")
        if t == "🛒 Кошик":
            s["state"] = None
            return cart(cid)
        if t == "📦 Замовлення":
            return my_orders(cid)
        state, co = s["state"], s["co"]
        if state == "search":
            s["view"] = {"q": t, "page": 1}
            s["state"] = None
            bot.send_message(cid, "Шукаю…", reply_markup=main_menu())
            return product_list(cid, 1)
        if state == "fn" and t:
            co["fn"] = t[:60]
            return ask(cid, "ln", "Прізвище клієнта:")
        if state == "ln" and t:
            co["ln"] = t[:60]
            return ask(cid, "phone", "Номер телефону (+380XXXXXXXXX або 0XXXXXXXXX):")
        if state == "phone":
            try:
                co["phone"] = normalize_phone(t)
            except ValueError as e:
                return bot.send_message(cid, f"{e}. Спробуйте ще раз:")
            return ask(cid, "city", "Місто доставки:")
        if state == "city":
            return city_results(cid, t)
        if state == "wfind":
            s["state"] = None
            return warehouse_list(cid, 1, t)
        bot.send_message(cid, "Оберіть дію в меню.", reply_markup=main_menu())

    @bot.callback_query_handler(func=lambda c: True)
    @guard
    def cb(c):
        cid, d, msg, s = c.message.chat.id, c.data, c.message, st(c.message.chat.id)
        bot.answer_callback_query(c.id)
        if d == "noop":
            return
        if d == "home":
            return categories(cid, msg)
        if d.startswith("c:"):
            return brands(cid, d[2:], msg)
        if d.startswith("b:"):
            s["view"] = {"cat": s["view"]["cat"], "brand": s["view"]["brands"][int(d[2:])], "page": 1}
            return product_list(cid, 1, msg)
        if d.startswith("p:"):
            s["view"]["page"] = int(d[2:])
            return product_list(cid, s["view"]["page"], msg)
        if d.startswith("i:"):
            return product_card(cid, int(d[2:]), msg)
        if d.startswith("a:"):
            p = s["items"][int(d[2:])]
            cur = api.call("GET", f"/api/bot/cart/{cid}")["items"]
            for it in cur:
                if it["product_id"] == p["id"]:
                    it["qty"] += 1
                    break
            else:
                cur.append({"product_id": p["id"], "qty": 1})
            save_cart(cid, cur)
            return bot.send_message(cid, f"Додано: {p['name']}", reply_markup=kb([[("🛒 Кошик", "cart"), ("⬅️ До списку", f"p:{s['view'].get('page', 1)}")]]))
        if d == "cart":
            return cart(cid)
        if d[:2] in ("k+", "k-", "kx") or d in ("kc", "ko"):
            items = s.get("cart") or api.call("GET", f"/api/bot/cart/{cid}")["items"]
            if d == "kc":
                save_cart(cid, [])
            elif d == "ko":
                if not items:
                    return
                if any(i["blocked"] or i["status"] != "in_stock" or i["unit_price"] is None for i in items):
                    return bot.send_message(cid, "У кошику є недоступні позиції. Видаліть їх і повторіть.")
                s["co"] = {}
                return ask(cid, "fn", "Ім'я клієнта:")
            else:
                i = int(d[2:])
                items[i]["qty"] += {"k+": 1, "k-": -1, "kx": -10**6}[d[:2]]
                items[i]["qty"] = min(items[i]["qty"], 1000)
                save_cart(cid, items)
            return cart(cid, msg)
        co = s["co"]
        if d.startswith("s:"):
            c0 = co["cities"][int(d[2:])]
            co.update(city=c0["city"], area=c0["area"], city_ref=c0["city_ref"])
            return warehouse_list(cid, 1, "", msg)
        if d.startswith("wp:"):
            return warehouse_list(cid, int(d[3:]), co.get("wfind", ""), msg)
        if d == "wf":
            return ask(cid, "wfind", "Введіть номер відділення або частину адреси:")
        if d.startswith("w:"):
            w = co["wlist"][int(d[2:])]
            co.update(warehouse=w["title"], warehouse_ref=w["ref"])
            return confirm(cid)
        if d == "go":
            return create_order(cid)
        if d == "cancel":
            s["co"] = {}
            bot.send_message(cid, "Скасовано.", reply_markup=main_menu())


def run():
    if not TOKEN or not ALLOWED:
        raise SystemExit("Задайте BOT_TOKEN і BOT_ALLOWED_IDS у .env")
    bot.infinity_polling(skip_pending=True)


if __name__ == "__main__":
    run()
