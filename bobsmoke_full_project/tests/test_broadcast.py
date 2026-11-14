"""Розсилка: перевірка форматування та цикл відправки. Чисті тести (проста імітація БД і Telegram)."""
from datetime import datetime, timedelta, timezone

import pytest

from backend.services import broadcast as bc


# ---------- форматування ----------
def test_allowed_formatting_passes():
    t = bc.clean_html("<b>Жирний</b> і <i>курсив</i>, <u>під</u> <s>закр</s> <tg-spoiler>секрет</tg-spoiler> <code>x=1</code>")
    assert t == "<b>Жирний</b> і <i>курсив</i>, <u>під</u> <s>закр</s> <tg-spoiler>секрет</tg-spoiler> <code>x=1</code>"


def test_nesting_of_text_styles_is_ok():
    assert bc.clean_html("<b><i>разом</i></b>") == "<b><i>разом</i></b>"


def test_link_and_quote():
    t = bc.clean_html('<a href="https://t.me/BobSmoke_bot">магазин</a>\n<blockquote>18+</blockquote>')
    assert '<a href="https://t.me/BobSmoke_bot">магазин</a>' in t and "<blockquote>18+</blockquote>" in t


def test_dangerous_link_rejected():
    with pytest.raises(bc.FormatError):
        bc.clean_html('<a href="javascript:alert(1)">клік</a>')


def test_unknown_tags_and_symbols_become_plain_text():
    t = bc.clean_html("Ціна < 500 & знижка > 5%, <script>x</script> <3")
    assert "<script>" not in t and "&lt;script&gt;" in t
    assert "&lt; 500 &amp; знижка &gt; 5%" in t
    assert bc.plain_text(t).startswith("Ціна < 500 & знижка > 5%")


def test_existing_entities_not_double_escaped():
    assert bc.clean_html("A &amp; B &lt;3") == "A &amp; B &lt;3"
    assert bc.clean_html("AT&T") == "AT&amp;T"


def test_broken_nesting_and_unclosed_tags_rejected():
    for bad in ("<b>текст", "<b><i>текст</b></i>", "</b>текст", "<b>a</b></i>x"):
        with pytest.raises(bc.FormatError):
            bc.clean_html(bad)


def test_code_cannot_contain_formatting_and_quote_cannot_nest():
    with pytest.raises(bc.FormatError):
        bc.clean_html("<code><b>x</b></code>")
    with pytest.raises(bc.FormatError):
        bc.clean_html("<blockquote><blockquote>x</blockquote></blockquote>")


def test_empty_and_too_long():
    for bad in ("", "   ", "<b></b>"):
        with pytest.raises(bc.FormatError):
            bc.clean_html(bad)
    with pytest.raises(bc.FormatError):
        bc.clean_html("а" * 4097)
    assert bc.plain_len(bc.clean_html("<b>" + "а" * 4096 + "</b>")) == 4096      # теги в ліміт не рахуються


def test_br_becomes_newline():
    assert bc.clean_html("a<br>b") == "a\nb"


# ---------- імітація БД ----------
class Coll:
    def __init__(self, docs=None):
        self.d = {x["_id"]: dict(x) for x in (docs or [])}

    def find(self, flt=None, proj=None):
        flt = flt or {}
        out = []
        for v in self.d.values():
            ok = True
            for k, c in flt.items():
                if isinstance(c, dict) and "$in" in c:
                    ok &= v.get(k) in c["$in"]
                else:
                    ok &= v.get(k) == c
            if ok:
                out.append(dict(v))
        return out

    def find_one(self, flt):
        r = self.find(flt)
        return r[0] if r else None

    def insert_one(self, doc):
        self.d[doc["_id"]] = dict(doc)

    def delete_one(self, flt):
        v = self.find_one(flt)
        if v:
            self.d.pop(v["_id"], None)
        return type("R", (), {"deleted_count": 1 if v else 0})

    def delete_many(self, flt):
        for v in self.find(flt):
            self.d.pop(v["_id"], None)

    def update_many(self, flt, upd):
        for v in self.find(flt):
            self.d[v["_id"]].update(upd.get("$set", {}))

    def update_one(self, flt, upd, upsert=False):
        v = self.find_one(flt)
        if not v:
            return type("R", (), {"modified_count": 0})
        tgt = self.d[v["_id"]]
        tgt.update(upd.get("$set", {}))
        for k in upd.get("$unset", {}):
            tgt.pop(k, None)
        return type("R", (), {"modified_count": 1})


class DB:
    def __init__(self, users):
        self.users = Coll(users)
        self.broadcasts = Coll()
        self.broadcast_files = Coll()
        self.carts = Coll()


def _setup(users, text="<b>Привіт</b>"):
    db = DB(users)
    doc = bc.create(db, text, "admin", len(users), False)
    return db, doc["_id"]


class Tg:
    """Імітація Telegram: словник {chat_id: відповідь або список відповідей}."""
    def __init__(self, script=None):
        self.calls, self.script = [], script or {}

    def __call__(self, method, payload=None, **kw):
        self.calls.append(payload)
        r = self.script.get(payload["chat_id"], {"ok": True})
        if isinstance(r, list):
            r = r.pop(0)
        return r


def _users(*ids):
    return [{"_id": i, "first_name": f"u{i}"} for i in ids]


def test_sends_to_everyone_with_html_mode():
    db, bid = _setup(_users(1, 2, 3))
    tg = Tg()
    out = bc.run(db, bid, call=tg, sleep=lambda s: None)
    assert out == {"sent": 3, "failed": 0, "blocked": 0, "status": "done", "error": None}
    assert [c["chat_id"] for c in tg.calls] == [1, 2, 3]
    assert all(c["parse_mode"] == "HTML" and c["text"] == "<b>Привіт</b>" for c in tg.calls)
    d = db.broadcasts.find_one({"_id": bid})
    assert d["status"] == "done" and d["sent"] == 3 and d["finished_at"]


def test_blocked_users_are_deleted_not_failed():
    db, bid = _setup(_users(1, 2))
    db.carts.insert_one({"_id": 1, "items": []})
    tg = Tg({1: {"ok": False, "error_code": 403, "description": "Forbidden: bot was blocked by the user"}})
    out = bc.run(db, bid, call=tg, sleep=lambda s: None)
    assert out["sent"] == 1 and out["blocked"] == 1 and out["failed"] == 0
    assert db.users.find_one({"_id": 1}) is None and db.carts.find_one({"_id": 1}) is None    # видалено разом із кошиком
    assert db.users.find_one({"_id": 2})


def test_user_who_never_started_bot_is_kept_but_flagged():
    db, bid = _setup(_users(1))
    tg = Tg({1: {"ok": False, "error_code": 403, "description": "Forbidden: bot can't initiate conversation with a user"}})
    out = bc.run(db, bid, call=tg, sleep=lambda s: None)
    assert out["blocked"] == 1 and db.users.find_one({"_id": 1})["bot_blocked"] is True


def test_other_errors_counted_as_failed_and_run_continues():
    db, bid = _setup(_users(1, 2))
    tg = Tg({1: {"ok": False, "error_code": 400, "description": "Bad Request: something"}})
    out = bc.run(db, bid, call=tg, sleep=lambda s: None)
    assert out["failed"] == 1 and out["sent"] == 1 and out["status"] == "done"


def test_rate_limit_is_retried_after_waiting():
    db, bid = _setup(_users(1))
    waits = []
    tg = Tg({1: [{"ok": False, "error_code": 429, "parameters": {"retry_after": 3}}, {"ok": True}]})
    out = bc.run(db, bid, call=tg, sleep=waits.append)
    assert out["sent"] == 1 and len(tg.calls) == 2 and 4 in waits


def test_parse_error_stops_whole_broadcast():
    db, bid = _setup(_users(1, 2, 3))
    bad = {"ok": False, "error_code": 400, "description": "Bad Request: can't parse entities: Unsupported start tag"}
    tg = Tg({1: bad, 2: bad, 3: bad})
    out = bc.run(db, bid, call=tg, sleep=lambda s: None)
    assert out["status"] == "error" and "форматування" in out["error"] and len(tg.calls) == 1
    assert db.users.find_one({"_id": 1}).get("bot_blocked") is None


def test_cancel_stops_sending():
    db, bid = _setup(_users(*range(1, 31)))
    db.broadcasts.update_one({"_id": bid}, {"$set": {"status": "cancelling"}})
    tg = Tg()
    out = bc.run(db, bid, call=tg, sleep=lambda s: None)
    assert out["status"] == "cancelled" and len(tg.calls) == 0


def test_button_markup_is_attached():
    db, bid = _setup(_users(1))
    tg = Tg()
    bc.run(db, bid, markup={"inline_keyboard": [[{"text": "x"}]]}, call=tg, sleep=lambda s: None)
    assert tg.calls[0]["reply_markup"]["inline_keyboard"][0][0]["text"] == "x"


def test_invalid_user_ids_are_skipped():
    db, bid = _setup([{"_id": 5}, {"_id": "abc"}, {"_id": -3}, {"_id": 0}])
    tg = Tg()
    bc.run(db, bid, call=tg, sleep=lambda s: None)
    assert [c["chat_id"] for c in tg.calls] == [5]


def test_stale_running_broadcast_is_marked_interrupted():
    db, bid = _setup(_users(1))
    old = datetime.now(timezone.utc) - timedelta(minutes=10)
    db.broadcasts.update_one({"_id": bid}, {"$set": {"updated_at": old}})
    assert bc.active(db) is None
    assert db.broadcasts.find_one({"_id": bid})["status"] == "interrupted"


def test_fresh_running_broadcast_blocks_new_one():
    db, bid = _setup(_users(1))
    assert bc.active(db)["_id"] == bid


# ---------- фото та файли ----------
def _file(db, name, kind="photo", data=b"x" * 10):
    d = {"_id": name, "name": name, "kind": kind, "mime": "image/jpeg" if kind == "photo" else "application/pdf",
         "size": len(data), "data": data, "broadcast": None}
    db.broadcast_files.insert_one(d)
    return d


class TgFiles:
    """Імітація Telegram з файлами: віддає file_id для кожного завантаженого вкладення."""
    def __init__(self):
        self.calls = []

    def __call__(self, method, payload=None, files=None, **kw):
        self.calls.append((method, payload, files))
        if method == "sendPhoto":
            return {"ok": True, "result": {"photo": [{"file_id": "p-small"}, {"file_id": "PH1"}]}}
        if method == "sendDocument":
            return {"ok": True, "result": {"document": {"file_id": "DOC1"}}}
        if method == "sendMediaGroup":
            return {"ok": True, "result": [{"photo": [{"file_id": f"G{i}"}]} if m["type"] == "photo" else {"document": {"file_id": f"G{i}"}}
                                           for i, m in enumerate(payload["media"])]}
        return {"ok": True}


def _run_with(files, text, users=(1, 2, 3), markup=None):
    db = DB(_users(*users))
    docs = [_file(db, *f) for f in files]
    doc = bc.create(db, bc.clean_html(text, allow_empty=True), "admin", len(users), bool(markup), docs)
    bc.attach_to(db, [d["_id"] for d in docs], doc["_id"])
    tg = TgFiles()
    out = bc.run(db, doc["_id"], markup=markup, call=tg, sleep=lambda s: None)
    return db, tg, out


def test_single_photo_with_caption_uploads_once_then_reuses_file_id():
    db, tg, out = _run_with([("a.jpg",)], "<b>Привіт</b>")
    assert out["sent"] == 3 and out["status"] == "done"
    assert [c[0] for c in tg.calls] == ["sendPhoto"] * 3
    assert tg.calls[0][2] is not None and "photo" not in tg.calls[0][1]          # перший раз — байти
    assert all(c[2] is None and c[1]["photo"] == "PH1" for c in tg.calls[1:])      # далі — лише file_id
    assert all(c[1]["caption"] == "<b>Привіт</b>" and c[1]["parse_mode"] == "HTML" for c in tg.calls)
    assert db.broadcast_files.find() == []                                         # файли видалено після розсилки


def test_photo_only_without_text_and_button_under_media():
    mk = {"inline_keyboard": [[{"text": "x"}]]}
    _, tg, out = _run_with([("a.jpg",)], "", users=(1,), markup=mk)
    assert out["sent"] == 1 and len(tg.calls) == 1
    assert "caption" not in tg.calls[0][1] and tg.calls[0][1]["reply_markup"] == mk


def test_long_text_goes_separately_after_media_with_button():
    mk = {"inline_keyboard": [[{"text": "x"}]]}
    long = "а" * 1025
    _, tg, out = _run_with([("a.jpg",)], long, users=(1,), markup=mk)
    assert [c[0] for c in tg.calls] == ["sendPhoto", "sendMessage"]
    assert "caption" not in tg.calls[0][1] and "reply_markup" not in tg.calls[0][1]
    assert tg.calls[1][1]["text"] == long and tg.calls[1][1]["reply_markup"] == mk


def test_album_of_photos_with_caption_on_first_item():
    _, tg, out = _run_with([("a.jpg",), ("b.jpg",)], "Текст", users=(1, 2))
    assert [c[0] for c in tg.calls] == ["sendMediaGroup"] * 2
    first = tg.calls[0][1]["media"]
    assert first[0]["caption"] == "Текст" and "caption" not in first[1] and first[0]["media"].startswith("attach://")
    assert set(tg.calls[0][2]) == {"f0", "f1"}
    assert [m["media"] for m in tg.calls[1][1]["media"]] == ["G0", "G1"] and tg.calls[1][2] is None


def test_album_with_button_sends_text_message_with_button():
    mk = {"inline_keyboard": [[{"text": "x"}]]}
    _, tg, _ = _run_with([("a.jpg",), ("b.jpg",)], "Текст", users=(1,), markup=mk)
    assert [c[0] for c in tg.calls] == ["sendMediaGroup", "sendMessage"]
    assert "caption" not in tg.calls[0][1]["media"][0] and tg.calls[1][1]["reply_markup"] == mk


def test_photo_and_document_are_sent_in_separate_groups():
    _, tg, _ = _run_with([("a.jpg",), ("f.pdf", "document")], "Текст", users=(1,))
    assert [c[0] for c in tg.calls] == ["sendPhoto", "sendDocument"]
    assert tg.calls[0][1]["caption"] == "Текст" and "caption" not in tg.calls[1][1]


def test_media_blocked_user_is_flagged():
    db = DB(_users(1, 2))
    d = _file(db, "a.jpg")
    doc = bc.create(db, "t", "admin", 2, False, [d])
    bc.attach_to(db, ["a.jpg"], doc["_id"])
    base = TgFiles()

    def tg(method, payload=None, files=None, **kw):
        if payload["chat_id"] == 1:
            return {"ok": False, "error_code": 403, "description": "Forbidden: bot was blocked by the user"}
        return base(method, payload, files)
    out = bc.run(db, doc["_id"], call=tg, sleep=lambda s: None)
    assert out["blocked"] == 1 and out["sent"] == 1


def test_plan_validation():
    with pytest.raises(bc.FormatError):
        bc.check_plan("", 0, False)
    with pytest.raises(bc.FormatError):
        bc.check_plan("", 2, True)
    bc.check_plan("", 1, True)
    bc.check_plan("", 2, False)
    bc.check_plan("т", 3, True)


def test_missing_attachment_and_limit():
    db = DB([])
    with pytest.raises(bc.FormatError):
        bc.load_attachments(db, ["nope"])
    with pytest.raises(bc.FormatError):
        bc.load_attachments(db, [str(i) for i in range(11)])


def test_prepare_attachment_photo_and_document():
    import io
    from PIL import Image
    from backend.services.images import prepare_attachment
    buf = io.BytesIO(); Image.new("RGB", (3000, 1500), "red").save(buf, "PNG")
    p = prepare_attachment(buf.getvalue(), "знімок.png")
    assert p["kind"] == "photo" and p["name"] == "знімок.jpg" and p["mime"] == "image/jpeg"
    assert max(Image.open(io.BytesIO(p["data"])).size) == 2560
    d = prepare_attachment(b"%PDF-1.4 test", "../../прайс 2026.pdf")
    assert d["kind"] == "document" and d["name"] == "прайс 2026.pdf" and d["mime"] == "application/pdf" and d["data"] == b"%PDF-1.4 test"
    buf = io.BytesIO(); Image.new("RGB", (5000, 100), "red").save(buf, "PNG")
    assert prepare_attachment(buf.getvalue(), "wide.png")["kind"] == "document"      # співвідношення > 20:1
    with pytest.raises(Exception):
        prepare_attachment(b"", "x")
