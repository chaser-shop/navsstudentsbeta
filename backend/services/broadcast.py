"""Розсилка з dashboard усім користувачам бота.

* Текст пишеться у форматі Telegram-HTML (жирний, курсив, підкреслений, закреслений, спойлер, код, цитата, посилання).
  `clean_html` пропускає лише дозволені теги, решту екранує, а неправильне вкладення відхиляє з зрозумілою помилкою.
* Відправка йде у фоновому потоці з обмеженням швидкості (Telegram дозволяє ~30 повідомлень/сек) і повторами при 429.
* Прогрес пишеться в колекцію broadcasts: dashboard показує, скільки доставлено, скільки не вдалося, хто заблокував бота.
* До розсилки можна додати фото та файли (до 10). Байти лежать у колекції broadcast_files; перше надсилання завантажує їх у Telegram,
  далі всім іншим йде той самий file_id (без повторного завантаження). Підпис (caption) у Telegram ≤ 1024 символи: довший текст іде окремим повідомленням.
* Користувачі, які заблокували бота, видаляються зі списку (services/user_sync.py) і не вважаються помилкою розсилки.
  Тим, кому бот просто не може написати (не натискали /start), ставиться позначка users.bot_blocked.
"""
import html
import logging
import re
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

from bson import Binary

from . import user_sync
from .telegram_api import tg_call

log = logging.getLogger("broadcast")

CAPTION_MAX = 1024                  # ліміт Telegram на підпис до фото/файлу
MAX_ATTACH = 10                     # ліміт Telegram на альбом
MAX_ATTACH_TOTAL = 60 * 1024 * 1024
MAX_PLAIN = 4096                    # ліміт Telegram на текст повідомлення (без тегів)
RATE_PER_SEC = 25                   # з запасом під ліміт Telegram (30/сек)
STALE_AFTER = timedelta(seconds=120)  # «running» без оновлень довше за цей час = процес перезапустився

ALLOWED = {"b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "code", "pre", "blockquote", "tg-spoiler", "a"}
_SAFE_HREF = re.compile(r"^(https?://|tg://|mailto:)", re.I)
_BARE_AMP = re.compile(r"&(?!(?:amp|lt|gt|quot|#\d{1,7}|#x[0-9a-fA-F]{1,6});)")


class FormatError(ValueError):
    """Текст не можна надіслати: помилка форматування (показується адміністратору)."""


class _Clean(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.out: list[str] = []
        self.stack: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "br":
            self.out.append("\n")
            return
        if tag not in ALLOWED:                                   # невідомий тег показуємо як звичайний текст
            self.out.append(html.escape(self.get_starttag_text() or "", quote=False))
            return
        if any(t in ("code", "pre") for t in self.stack):
            raise FormatError("Усередині «код» не можна використовувати інше форматування")
        if tag == "blockquote" and "blockquote" in self.stack:
            raise FormatError("Цитата не може бути вкладена в іншу цитату")
        a = dict(attrs)
        if tag == "a":
            href = (a.get("href") or "").strip()
            if not _SAFE_HREF.match(href):
                raise FormatError("Посилання має починатися з https://")
            self.out.append(f'<a href="{html.escape(href, quote=True)}">')
        elif tag == "blockquote":
            self.out.append("<blockquote expandable>" if "expandable" in a else "<blockquote>")
        else:
            self.out.append(f"<{tag}>")
        self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag == "br":
            return
        if tag not in ALLOWED:
            self.out.append(html.escape(f"</{tag}>", quote=False))
            return
        if not self.stack or self.stack[-1] != tag:
            raise FormatError(f"Тег </{tag}> закрито не там: перевірте, чи правильно вкладене форматування")
        self.stack.pop()
        self.out.append(f"</{tag}>")

    def handle_data(self, data):
        self.out.append(html.escape(data, quote=False))

    def handle_entityref(self, name):
        self.out.append(f"&{name};")                              # лише amp/lt/gt/quot: решту & екранує _BARE_AMP

    def handle_charref(self, name):
        self.out.append(f"&#{name};")


def clean_html(raw: str, allow_empty: bool = False) -> str:
    """Перевіряє й нормалізує текст розсилки. Піднімає FormatError, якщо його не можна надіслати."""
    raw = (raw or "").replace("\r\n", "\n").strip()
    if not raw:
        if allow_empty:
            return ""
        raise FormatError("Введіть текст розсилки")
    p = _Clean()
    p.feed(_BARE_AMP.sub("&amp;", raw))
    p.close()
    if p.stack:
        raise FormatError(f"Тег <{p.stack[-1]}> не закрито")
    text = "".join(p.out).strip()
    n = plain_len(text)
    if n == 0:
        raise FormatError("Введіть текст розсилки")
    if n > MAX_PLAIN:
        raise FormatError(f"Текст задовгий: {n} символів, максимум {MAX_PLAIN}")
    return text


def plain_text(clean: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", clean))


def plain_len(clean: str) -> int:
    return len(plain_text(clean))


# ---------- отримувачі ----------
def recipients(db) -> tuple[list[int], set[int]]:
    """(усі Telegram ID користувачів бота, з них ті, що раніше заблокували бота)."""
    ids, flagged = [], set()
    for u in db.users.find({}, {"_id": 1, "bot_blocked": 1}):
        uid = u["_id"]
        if isinstance(uid, int) and uid > 0:
            ids.append(uid)
            if u.get("bot_blocked"):
                flagged.add(uid)
    return ids, flagged


# ---------- стан розсилок ----------
def _now():
    return datetime.now(timezone.utc)


def active(db) -> dict | None:
    """Розсилка, що виконується зараз. Завислі після перезапуску сервера позначаються «interrupted»."""
    for d in db.broadcasts.find({"status": {"$in": ["running", "cancelling"]}}):
        upd = d.get("updated_at") or d.get("created_at")
        if upd is not None and upd.tzinfo is None:
            upd = upd.replace(tzinfo=timezone.utc)
        if upd and _now() - upd > STALE_AFTER:
            db.broadcasts.update_one({"_id": d["_id"]}, {"$set": {"status": "interrupted", "finished_at": _now()}})
            continue
        return d
    return None


def create(db, clean: str, admin: str, total: int, button: bool, attachments: list[dict] | None = None) -> dict:
    now = _now()
    att = attachments or []
    preview = plain_text(clean).replace("\n", " ")[:140] if clean else "(без тексту)"
    doc = {"_id": uuid.uuid4().hex, "text": clean, "preview": preview, "by": admin,
           "button": button, "total": total, "sent": 0, "failed": 0, "blocked": 0, "status": "running",
           "attachments": [a["_id"] for a in att], "attach_count": len(att),
           "error": None, "created_at": now, "updated_at": now, "finished_at": None}
    db.broadcasts.insert_one(dict(doc))
    return doc


# ---------- вкладення ----------
def save_attachment(db, item: dict) -> dict:
    """item з images.prepare_attachment -> збережений документ (ще не привʼязаний до розсилки)."""
    # старі непривʼязані файли (покинуті чернетки) прибираємо при кожному завантаженні
    db.broadcast_files.delete_many({"broadcast": None, "created_at": {"$lt": _now() - timedelta(hours=24)}})
    doc = {"_id": uuid.uuid4().hex, "name": item["name"], "kind": item["kind"], "mime": item["mime"],
           "size": len(item["data"]), "data": Binary(item["data"]), "broadcast": None, "created_at": _now()}
    db.broadcast_files.insert_one(doc)
    return doc


def load_attachments(db, ids: list[str]) -> list[dict]:
    """Файли в порядку, у якому їх додав адміністратор. FormatError, якщо чогось уже нема або забагато."""
    ids = list(dict.fromkeys(ids or []))
    if len(ids) > MAX_ATTACH:
        raise FormatError(f"Забагато файлів: максимум {MAX_ATTACH}")
    docs = {d["_id"]: d for d in db.broadcast_files.find({"_id": {"$in": ids}})}
    out = []
    for i in ids:
        if i not in docs:
            raise FormatError("Один із доданих файлів більше не доступний: додайте його знову")
        out.append(docs[i])
    if sum(d.get("size", 0) for d in out) > MAX_ATTACH_TOTAL:
        raise FormatError("Файли разом завеликі (максимум 60 МБ)")
    return out


def attach_to(db, ids: list[str], bid: str) -> None:
    db.broadcast_files.update_many({"_id": {"$in": ids}}, {"$set": {"broadcast": bid}})


def check_plan(text: str, count: int, button: bool) -> None:
    """Кнопку не можна прикріпити до альбому: вона йде під окремим повідомленням, тож потрібен текст."""
    if not text and not count:
        raise FormatError("Введіть текст розсилки або додайте фото чи файл")
    if button and count > 1 and not text:
        raise FormatError("Кнопка під кількома файлами потребує тексту: додайте текст або приберіть кнопку")


class Media:
    """Вкладення розсилки в памʼяті. Після першого успішного надсилання Telegram віддає file_id, байти більше не потрібні."""

    def __init__(self, docs: list[dict]):
        self.items = [{"name": d["name"], "kind": d["kind"], "mime": d.get("mime") or "application/octet-stream",
                       "data": bytes(d["data"]), "file_id": None} for d in docs]

    def __bool__(self):
        return bool(self.items)

    def release(self):
        if all(i["file_id"] for i in self.items):
            for i in self.items:
                i["data"] = b""


def _field(kind: str) -> tuple[str, str]:
    return ("sendPhoto", "photo") if kind == "photo" else ("sendDocument", "document")


def _file_ids(res: dict) -> list[str]:
    r = res.get("result")
    msgs = r if isinstance(r, list) else [r or {}]
    out = []
    for m in msgs:
        if m.get("photo"):
            out.append(m["photo"][-1].get("file_id"))
        elif m.get("document"):
            out.append(m["document"].get("file_id"))
        else:
            out.append(None)
    return out


def _send_media(call, uid: int, media: Media, idx: list[int], caption: str, markup, sleep) -> dict:
    items = [media.items[i] for i in idx]
    if len(items) == 1:
        it = items[0]
        method, field = _field(it["kind"])
        payload, files = {"chat_id": uid}, None
        if it["file_id"]:
            payload[field] = it["file_id"]
        else:
            files = {field: (it["name"], it["data"], it["mime"])}
        if caption:
            payload.update(caption=caption, parse_mode="HTML")
        if markup:
            payload["reply_markup"] = markup
    else:
        method, payload, files, group = "sendMediaGroup", {"chat_id": uid}, {}, []
        for n, it in enumerate(items):
            e = {"type": it["kind"]}
            if it["file_id"]:
                e["media"] = it["file_id"]
            else:
                e["media"] = f"attach://f{n}"
                files[f"f{n}"] = (it["name"], it["data"], it["mime"])
            if n == 0 and caption:
                e.update(caption=caption, parse_mode="HTML")
            group.append(e)
        payload["media"] = group
        files = files or None
    res = _send_one(call, method, payload, sleep, files)
    if res.get("ok"):
        for it, fid in zip(items, _file_ids(res)):
            if fid and not it["file_id"]:
                it["file_id"] = fid
        media.release()
        res["messages"] = len(items)
    return res


def deliver(call, uid: int, text: str, media: Media | None, markup, sleep=time.sleep) -> dict:
    """Надсилає одному користувачу все, що входить у розсилку. -> відповідь Telegram (ok або перша помилка);
    у успішної є ключ messages — скільки повідомлень пішло (для обмеження швидкості)."""
    if not media:
        payload = {"chat_id": uid, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
        if markup:
            payload["reply_markup"] = markup
        res = _send_one(call, "sendMessage", payload, sleep)
        res["messages"] = 1
        return res
    n = len(media.items)
    caption_fits = bool(text) and plain_len(text) <= CAPTION_MAX
    photos = [i for i, it in enumerate(media.items) if it["kind"] == "photo"]
    docs = [i for i, it in enumerate(media.items) if it["kind"] != "photo"]
    inline_markup = n == 1 and (caption_fits or not text)         # кнопка під самим медіа лише якщо воно одне
    caption = text if caption_fits and (n == 1 and inline_markup or n > 1 and not markup) else ""
    sent = 0
    for g, idx in enumerate([x for x in (photos, docs) if x]):
        res = _send_media(call, uid, media, idx, caption if g == 0 else "", markup if inline_markup else None, sleep)
        if not res.get("ok"):
            return res
        sent += res.get("messages", 1)
    if text and not caption:                                       # довгий текст або кнопка: окреме повідомлення після медіа
        payload = {"chat_id": uid, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True}
        if markup:
            payload["reply_markup"] = markup
        res = _send_one(call, "sendMessage", payload, sleep)
        if not res.get("ok"):
            return res
        sent += 1
    return {"ok": True, "messages": sent}


def _classify(res: dict) -> str:
    d = (res.get("description") or "").lower()
    if "can't parse entities" in d or "can't find end" in d or "unsupported start tag" in d:
        return "parse"
    if res.get("error_code") == 403 or "blocked" in d or "deactivated" in d or "chat not found" in d:
        return "blocked"
    return "failed"


def _send_one(call, method: str, payload: dict, sleep, files: dict | None = None) -> dict:
    res: dict = {}
    for _ in range(3):                                            # 429: Telegram просить почекати
        res = call(method, payload, files=files) if files else call(method, payload)
        if res.get("ok") or res.get("error_code") != 429:
            break
        sleep(min(30, int((res.get("parameters") or {}).get("retry_after") or 1) + 1))
    return res


def run(db, bid: str, markup: dict | None = None, call=tg_call, sleep=time.sleep, rate: int = RATE_PER_SEC) -> dict:
    """Надсилає розсилку всім користувачам і пише прогрес у broadcasts. Не піднімає винятків."""
    sent = failed = blocked = 0
    status, error = "done", None
    try:
        doc = db.broadcasts.find_one({"_id": bid})
        ids, flagged = recipients(db)
        media = Media(load_attachments(db, doc.get("attachments") or [])) if doc.get("attachments") else None

        def flush(extra=None):
            db.broadcasts.update_one({"_id": bid}, {"$set": {"sent": sent, "failed": failed, "blocked": blocked,
                                                              "updated_at": _now(), **(extra or {})}})

        for n, uid in enumerate(ids):
            if n % 10 == 0 and (db.broadcasts.find_one({"_id": bid}) or {}).get("status") == "cancelling":
                status = "cancelled"
                break
            res = deliver(call, uid, doc["text"], media, markup, sleep)
            if res.get("ok"):
                sent += 1
                if uid in flagged:                                # користувач розблокував бота
                    db.users.update_one({"_id": uid}, {"$unset": {"bot_blocked": "", "bot_blocked_at": ""}})
            else:
                kind = _classify(res)
                if kind == "parse":                               # проблема в самому тексті: далі нема сенсу
                    status, error = "error", f"Telegram не прийняв форматування: {res.get('description')}"
                    break
                if kind == "blocked":
                    blocked += 1
                    if user_sync.is_gone(res):                        # заблокував бота / видалив акаунт: прибираємо зі списку
                        user_sync.remove_user(db, uid)
                    else:                                             # напр. не натискав /start: лишаємо, лише позначаємо
                        db.users.update_one({"_id": uid}, {"$set": {"bot_blocked": True, "bot_blocked_at": _now()}})
                else:
                    failed += 1
                    log.warning("Розсилка %s: %s -> %s", bid, uid, res.get("description"))
            if n % 10 == 9:
                flush()
            sleep(res.get("messages", 1) / rate)
        flush({"status": status, "error": error, "finished_at": _now()})
    except FormatError as e:                                      # файли зникли між створенням і стартом
        status, error = "error", str(e)
        db.broadcasts.update_one({"_id": bid}, {"$set": {"sent": sent, "failed": failed, "blocked": blocked,
                                                          "status": status, "error": error, "finished_at": _now()}})
    except Exception as e:                                        # потік не має падати мовчки
        log.exception("Розсилка %s зупинилась", bid)
        status, error = "error", f"Внутрішня помилка: {e}"
        try:
            db.broadcasts.update_one({"_id": bid}, {"$set": {"sent": sent, "failed": failed, "blocked": blocked,
                                                              "status": status, "error": error, "finished_at": _now()}})
        except Exception:
            pass
    try:                                                          # файли після розсилки не зберігаємо
        db.broadcast_files.delete_many({"broadcast": bid})
    except Exception:
        log.warning("Не вдалося видалити файли розсилки %s", bid)
    return {"sent": sent, "failed": failed, "blocked": blocked, "status": status, "error": error}


def start(db, bid: str, markup: dict | None = None) -> threading.Thread:
    t = threading.Thread(target=run, args=(db, bid, markup), daemon=True, name=f"broadcast-{bid[:6]}")
    t.start()
    return t
