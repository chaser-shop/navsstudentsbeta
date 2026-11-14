from backend import config
from backend.services import telegram_api
from bot import shop_bot


def _setup(monkeypatch):
    monkeypatch.setenv("BOT_TOKEN", "1:T")
    monkeypatch.setenv("PUBLIC_URL", "https://shop.example.com/")
    monkeypatch.setenv("WEBHOOK_SECRET", "s3cret")
    monkeypatch.setenv("BOT_ALLOWED_IDS", "7, 8")


class Rec:
    def __init__(self):
        self.calls = []
    def __call__(self, method, payload=None, **kw):
        self.calls.append((method, payload))
        return {"ok": True}


class _MP:
    def __enter__(self):
        import pytest
        self.mp = pytest.MonkeyPatch()
        _setup(self.mp)
        return self.mp
    def __exit__(self, *a):
        self.mp.undo()


def test_start_sends_web_app_button():
    with _MP():
        rec = Rec()
        shop_bot.handle_update({"message": {"chat": {"id": 5, "type": "private"}, "from": {"id": 5, "first_name": "Test"}, "text": "/start"}}, call=rec, db=FakeDB())
        method, p = next(c for c in rec.calls if c[0] == "sendMessage" and c[1].get("chat_id") == 5)
        btn = p["reply_markup"]["inline_keyboard"][0][0]
        assert btn["web_app"]["url"] == "https://shop.example.com/app/" and "18+" in p["text"]


class FakeResult:
    def __init__(self, upserted_id): self.upserted_id = upserted_id
class FakeUsers:
    def __init__(self): self.rows = {}
    def update_one(self, query, update, upsert=False):
        uid = query["_id"]
        is_new = uid not in self.rows
        if is_new: self.rows[uid] = dict(update.get("$setOnInsert", {}))
        self.rows[uid].update(update.get("$set", {}))
        return FakeResult(uid if is_new else None)
class FakeDB:
    def __init__(self): self.users = FakeUsers()


def test_new_start_registers_user_and_notifies_admin_once():
    with _MP():
        rec, db = Rec(), FakeDB()
        update = {"message": {"chat": {"id": 42, "type": "private"}, "from": {"id": 42, "first_name": "Іван", "username": "ivan"}, "text": "/start"}}
        shop_bot.handle_update(update, call=rec, db=db)
        shop_bot.handle_update(update, call=rec, db=db)
        assert 42 in db.users.rows
        alerts = [p for m, p in rec.calls if m == "sendMessage" and p.get("chat_id") in (7, 8) and "Новий користувач" in p.get("text", "")]
        assert len(alerts) == 2
        assert all("42" in p["text"] and "@ivan" in p["text"] for p in alerts)


def test_groups_and_non_text_updates_are_ignored():
    with _MP():
        rec = Rec()
        shop_bot.handle_update({"message": {"chat": {"id": -1, "type": "group"}, "text": "/start"}}, call=rec, db=FakeDB())
        shop_bot.handle_update({"message": {"chat": {"id": 5, "type": "private"}}}, call=rec, db=FakeDB())
        shop_bot.handle_update({"callback_query": {}}, call=rec, db=FakeDB())
        assert rec.calls == []


def test_setup_webhook_registers_secret_and_menu():
    with _MP():
        rec = Rec()
        assert shop_bot.setup_webhook(call=rec) is True
        names = [c[0] for c in rec.calls]
        assert names == ["setWebhook", "setChatMenuButton", "setMyCommands"]
        hook = rec.calls[0][1]
        assert hook["url"] == "https://shop.example.com/telegram/webhook" and hook["secret_token"] == telegram_api.webhook_token()
        assert len(hook["secret_token"]) == 64 and set(hook["secret_token"]) <= set("0123456789abcdef")


def test_setup_webhook_skips_without_config(monkeypatch):
    monkeypatch.delenv("BOT_TOKEN", raising=False)
    monkeypatch.delenv("PUBLIC_URL", raising=False)
    monkeypatch.delenv("RENDER_EXTERNAL_URL", raising=False)
    rec = Rec()
    assert shop_bot.setup_webhook(call=rec) is False and rec.calls == []


def test_operators_are_notified():
    with _MP():
        rec = Rec()
        telegram_api.notify_operators("hi", call=rec)
        assert [c[1]["chat_id"] for c in rec.calls] == [7, 8]
