"""Видалення користувачів, що заблокували бота: sweep, my_chat_member, стан перевірки."""
from backend.services import user_sync as us
from bot import shop_bot
from tests.test_broadcast import DB, _users

BLOCK = {"ok": False, "error_code": 403, "description": "Forbidden: bot was blocked by the user"}
NOSTART = {"ok": False, "error_code": 403, "description": "Forbidden: bot can't initiate conversation with a user"}


class Tg:
    def __init__(self, script):
        self.script, self.calls = script, []

    def __call__(self, method, payload=None, **kw):
        self.calls.append((method, payload))
        r = self.script.get(payload["chat_id"], {"ok": True})
        return r.pop(0) if isinstance(r, list) else r


def test_is_gone_only_for_block_or_deactivated():
    assert us.is_gone(BLOCK)
    assert us.is_gone({"ok": False, "error_code": 403, "description": "Forbidden: user is deactivated"})
    assert not us.is_gone(NOSTART)
    assert not us.is_gone({"ok": False, "error_code": 400, "description": "Bad Request: chat not found"})
    assert not us.is_gone({"ok": True})


def test_sweep_removes_blocked_keeps_the_rest():
    db = DB(_users(1, 2, 3, 4) + [{"_id": 5, "bot_blocked": True}])
    db.carts.insert_one({"_id": 2, "items": [1]})
    tg = Tg({2: BLOCK, 3: NOSTART, 4: {"ok": False, "error_code": 500, "description": "oops"}})
    out = us.sweep(db, call=tg, sleep=lambda s: None)
    assert out == {"checked": 5, "removed": 1, "errors": 2}
    assert sorted(u["_id"] for u in db.users.find({})) == [1, 3, 4, 5]
    assert db.carts.find_one({"_id": 2}) is None
    assert "bot_blocked" not in db.users.find_one({"_id": 5})               # бота розблокували: позначку знято
    assert all(c[0] == "sendChatAction" and c[1]["action"] == "typing" for c in tg.calls)


def test_sweep_retries_after_rate_limit():
    db = DB(_users(1))
    waits = []
    tg = Tg({1: [{"ok": False, "error_code": 429, "parameters": {"retry_after": 2}}, BLOCK]})
    out = us.sweep(db, call=tg, sleep=waits.append)
    assert out["removed"] == 1 and 3 in waits and len(tg.calls) == 2


def test_my_chat_member_kicked_removes_user_immediately():
    db = DB(_users(10, 11))
    kicked = {"my_chat_member": {"chat": {"id": 10, "type": "private"}, "new_chat_member": {"status": "kicked"}}}
    shop_bot.handle_update(kicked, db=db)
    assert db.users.find_one({"_id": 10}) is None and db.users.find_one({"_id": 11})


def test_my_chat_member_other_cases_are_ignored():
    db = DB(_users(10))
    shop_bot.handle_update({"my_chat_member": {"chat": {"id": 10, "type": "private"}, "new_chat_member": {"status": "member"}}}, db=db)
    shop_bot.handle_update({"my_chat_member": {"chat": {"id": -5, "type": "group"}, "new_chat_member": {"status": "kicked"}}}, db=db)
    assert db.users.find_one({"_id": 10})


def test_webhook_subscribes_to_my_chat_member():
    from tests.test_shop_bot import Rec, _MP
    with _MP():
        rec = Rec()
        shop_bot.setup_webhook(call=rec)
        assert "my_chat_member" in rec.calls[0][1]["allowed_updates"]


def test_start_shows_subscribe_button_until_subscribed(monkeypatch):
    from backend.config import settings
    from backend.services import subscription as sub
    monkeypatch.setenv("REQUIRED_CHANNEL", "-1001")
    monkeypatch.setenv("REQUIRED_CHANNEL_LINK", "https://t.me/+abc")
    monkeypatch.setenv("BOT_ALLOWED_IDS", "999")
    sub._ok.clear()

    def tg(status):
        return lambda m, p=None, **k: {"ok": True, "result": {"status": status}}
    mk = shop_bot._start_markup(5, "https://x/app/", tg("left"))
    assert mk["inline_keyboard"][0][0]["url"] == "https://t.me/+abc" and "web_app" in mk["inline_keyboard"][1][0]
    sub._ok.clear()
    assert len(shop_bot._start_markup(5, "https://x/app/", tg("member"))["inline_keyboard"]) == 1
    assert len(shop_bot._start_markup(999, "https://x/app/", tg("left"))["inline_keyboard"]) == 1      # оператор


def test_bot_added_to_channel_notifies_operators_with_id(monkeypatch):
    monkeypatch.setenv("BOT_ALLOWED_IDS", "999")
    sent = []
    shop_bot._on_member_update({"chat": {"id": -1009, "type": "channel", "title": "Новини"}, "new_chat_member": {"status": "administrator"}},
                               call=lambda m, p=None, **k: sent.append(p) or {"ok": True})
    assert sent and sent[0]["chat_id"] == 999 and "REQUIRED_CHANNEL=-1009" in sent[0]["text"]
