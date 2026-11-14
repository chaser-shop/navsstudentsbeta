"""Бот-вітрина: відповідає на /start кнопкою, що відкриває Mini App. Працює через вебхук (див. routes/telegram.py).

Логіка каталогу й замовлень живе в Mini App та backend API; тут лише вхід у магазин.
"""
import logging

from backend.config import settings
from backend.services import referral, subscription, user_sync
from backend.services.telegram_api import tg_call, webhook_token, notify_operators
from backend.database import get_db

log = logging.getLogger("shop_bot")


def app_url() -> str:
    return f"{settings.public_url}/app/" if settings.public_url else ""


def _open_markup(url: str) -> dict:
    return {"inline_keyboard": [[{"text": "🛍 Відкрити магазин", "web_app": {"url": url}}]]}


def _start_markup(uid, url: str, call=tg_call) -> dict:
    """Якщо потрібна підписка на канал і людина ще не підписана: кнопка «Підписатись» + кнопка входу, яка перевірить підписку знову."""
    ch = settings.required_channel
    link = subscription.channel_link(ch, settings.required_channel_link)
    if ch and link and isinstance(uid, int) and uid not in settings.operator_ids and subscription.check(uid, ch, call=call) is False:
        return {"inline_keyboard": [[{"text": "📢 Підписатись на канал", "url": link}],
                                    [{"text": "✅ Я підписався, відкрити магазин", "web_app": {"url": url}}]]}
    return _open_markup(url)


def _register_user(user: dict, call=tg_call, db=None) -> None:
    """Зберігає нового Telegram-користувача один раз і сповіщає операторів."""
    uid = user.get("id")
    if not isinstance(uid, int) or uid <= 0:
        return
    try:
        if db is None:
            db = get_db()
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        first_name = str(user.get("first_name") or "")[:120]
        last_name = str(user.get("last_name") or "")[:120]
        username = str(user.get("username") or "")[:120]
        result = db.users.update_one(
            {"_id": uid},
            {"$set": {"first_name": first_name, "last_name": last_name,
                      "username": username, "last_seen_at": now},
             "$setOnInsert": {"registered_at": now}},
            upsert=True,
        )
        if result.upserted_id is not None:
            display = " ".join(x for x in (first_name, last_name) if x) or "Без імені"
            handle = f"@{username}" if username else "не вказано"
            notify_operators(
                f"🆕 Новий користувач зареєструвався в боті\n\n"
                f"👤 Ім'я: {display}\n"
                f"🔗 Username: {handle}\n"
                f"🆔 Telegram ID: {uid}\n"
                f"📅 Дата: {now.strftime('%d.%m.%Y %H:%M UTC')}",
                call=call,
            )
    except Exception:
        # Помилка реєстрації не повинна завадити відповіді бота користувачу.
        log.exception("Не вдалося зберегти Telegram-користувача %s", uid)


def _referral_welcome(text: str, user: dict, db=None) -> str:
    """/start ref_<id>: запам'ятовує, хто запросив, і повертає рядок про подарунковий промокод (або порожній)."""
    parts = text.split(maxsplit=1)
    referrer = referral.parse_start(parts[1] if len(parts) > 1 else "")
    uid = user.get("id")
    if not referrer or not isinstance(uid, int):
        return ""
    try:
        gift = referral.attach(db if db is not None else get_db(), uid, referrer)
    except Exception:
        log.exception("Не вдалося зберегти запрошення %s -> %s", referrer, uid)
        return ""
    if not gift:
        return ""
    return (f"\n\n🎁 Ви прийшли за запрошенням друга. Ваш промокод: {gift['code']}\n"
            f"Знижка {gift['percent']:g}% на перше замовлення — введіть його при оформленні.")


_MEDIA_LABELS = {"voice": "🎤 Голосове повідомлення", "video": "🎥 Відео", "video_note": "⭕ Відеоповідомлення",
                 "sticker": "🙂 Стікер", "audio": "🎵 Аудіо", "contact": "👤 Контакт", "location": "📍 Геолокація"}


def _extract(msg: dict):
    """Що саме надіслав покупець -> (текст, kind, media) або None, якщо це службове повідомлення."""
    caption = (msg.get("caption") or "").strip()
    if msg.get("text"):
        return msg["text"].strip(), "text", None
    if msg.get("photo"):
        return caption, "photo", {"type": "photo", "file_id": msg["photo"][-1]["file_id"]}
    doc = msg.get("document")
    if doc:
        if str(doc.get("mime_type", "")).startswith("image/"):
            return caption, "photo", {"type": "photo", "file_id": doc["file_id"]}
        return f"📎 Файл: {doc.get('file_name') or 'без назви'}" + (f"\n{caption}" if caption else ""), "document", None
    for key, label in _MEDIA_LABELS.items():
        if msg.get(key):
            return label + (f"\n{caption}" if caption else ""), "text", None
    return None


def _handle_chat_message(msg: dict, content: tuple, call, db) -> None:
    """Звичайне повідомлення покупця (не команда): зберігається для dashboard, оператор отримує сповіщення."""
    from datetime import datetime, timedelta, timezone
    from backend.services import chat
    user, chat_id = msg.get("from") or {}, msg["chat"]["id"]
    text, kind, media = content
    _register_user(user, call=call, db=db)
    name = " ".join(x for x in (user.get("first_name"), user.get("last_name")) if x) or "Без імені"
    username = str(user.get("username") or "")
    chat.log_message(db, chat_id, "in", text, kind=kind, media=media, tg_message_id=msg.get("message_id"), name=name, username=username)
    handle = f"@{username}" if username else f"id {chat_id}"
    preview = text or {"photo": "📷 Фото"}.get(kind, "")
    for uid in sorted(settings.operator_ids - {chat_id}):
        call("sendMessage", {"chat_id": uid, "text": f"💬 {name} ({handle}):\n{preview[:600]}\n\nВідповісти — у dashboard, вкладка «Чати»."})
    minutes = settings.chat_ack_minutes                # один раз на N хв: покупець бачить, що повідомлення дійшло
    if minutes > 0:
        now = datetime.now(timezone.utc)
        st = db.chats.find_one({"_id": chat_id}) or {}
        last = st.get("last_ack_at")
        if last is not None and last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        if last is None or now - last > timedelta(minutes=minutes):
            call("sendMessage", {"chat_id": chat_id, "text": "✅ Повідомлення передано менеджеру. Відповідь прийде в цей чат."})
            db.chats.update_one({"_id": chat_id}, {"$set": {"last_ack_at": now}})


def _on_member_update(mcm: dict, db=None, call=tg_call) -> None:
    """my_chat_member: у приватному чаті «kicked» = користувач заблокував бота (прибираємо зі списку);
    у каналі чи групі: бота зробили учасником або адміном (повідомляємо операторам ID для REQUIRED_CHANNEL)."""
    chat = mcm.get("chat") or {}
    status = (mcm.get("new_chat_member") or {}).get("status")
    if chat.get("type") in ("channel", "supergroup", "group"):
        if status in ("administrator", "member"):
            notify_operators(f"ℹ️ Бота додано до «{chat.get('title') or 'без назви'}» ({chat.get('type')}).\n"
                             f"🆔 ID: {chat.get('id')}\n\n"
                             f"Щоб підписка на цей канал була обов'язковою, задайте REQUIRED_CHANNEL={chat.get('id')} "
                             f"(бот має бути адміністратором каналу).", call=call)
        return
    if chat.get("type") != "private" or status != "kicked":
        return
    uid = chat.get("id")
    if not isinstance(uid, int) or uid <= 0:
        return
    try:
        if user_sync.remove_user(db if db is not None else get_db(), uid):
            log.info("Користувач %s заблокував бота: видалено зі списку", uid)
    except Exception:
        log.exception("Не вдалося видалити користувача %s", uid)


def handle_update(update: dict, call=tg_call, db=None) -> None:
    if update.get("my_chat_member"):
        _on_member_update(update["my_chat_member"], db, call)
        return
    msg = update.get("message") or {}
    chat = msg.get("chat") or {}
    if chat.get("type") != "private":
        return                                    # кнопка Mini App працює лише в приватному чаті
    content = _extract(msg)
    if not content:
        return
    text = content[0] if content[1] == "text" else ""
    user = msg.get("from") or {}
    is_command = text.startswith("/")
    if not is_command:                            # питання й будь-які повідомлення покупця йдуть у чат із менеджером
        try:
            if db is None:
                db = get_db()
            _handle_chat_message(msg, content, call, db)
        except Exception:
            log.exception("Не вдалося обробити повідомлення покупця %s", chat.get("id"))
        return
    gift = ""
    if text.split()[0].split("@")[0] == "/start":
        _register_user(user, call=call, db=db)
        gift = _referral_welcome(text, user, db)
    url = app_url()
    if not url:
        call("sendMessage", {"chat_id": chat["id"], "text": "Магазин ще налаштовується. Спробуйте пізніше."})
        return
    if text.startswith("/help"):
        body = "Каталог, кошик і оформлення замовлення — у магазині. Доставка Новою поштою. Лише для повнолітніх (18+).\nЗапитання можна просто написати сюди — їх прочитає менеджер."
    else:
        body = "Вітаємо у Bob Smoke! 🦫 Натисніть кнопку нижче, щоб відкрити каталог.\nМагазин призначений лише для повнолітніх (18+)." + gift
    markup = _start_markup(user.get("id"), url, call)
    if len(markup["inline_keyboard"]) > 1:
        body += "\n\n📢 Щоб користуватись магазином, спершу підпишіться на наш канал."
    call("sendMessage", {"chat_id": chat["id"], "text": body, "reply_markup": markup})


def setup_webhook(call=tg_call) -> bool:
    """Реєструє вебхук, кнопку меню й команди. Викликається при старті сервера; помилки не фатальні."""
    url = app_url()
    if not (settings.bot_token and url):
        log.warning("Вебхук не налаштовано: потрібні BOT_TOKEN і PUBLIC_URL (або RENDER_EXTERNAL_URL)")
        return False
    r = call("setWebhook", {"url": f"{settings.public_url}/telegram/webhook", "secret_token": webhook_token(),
                            "allowed_updates": ["message", "my_chat_member"], "max_connections": 20})
    call("setChatMenuButton", {"menu_button": {"type": "web_app", "text": "Магазин", "web_app": {"url": url}}})
    call("setMyCommands", {"commands": [{"command": "start", "description": "Відкрити магазин"},
                                        {"command": "help", "description": "Допомога"}]})
    if not r.get("ok"):
        log.error("setWebhook: %s", r.get("description"))
    return bool(r.get("ok"))
