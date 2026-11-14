from backend.services import subscription as sub


def fake(status=None, ok=True, desc=""):
    calls = []
    def call(method, payload):
        calls.append(payload)
        return {"ok": ok, "description": desc, "result": {"status": status}} if ok else {"ok": False, "description": desc}
    call.calls = calls
    return call


def test_member_statuses_pass_and_left_is_blocked():
    sub._ok.clear()
    assert sub.check(1, "@ch", fake("member")) is True
    assert sub.check(2, "@ch", fake("left")) is False
    assert sub.check(3, "@ch", fake("kicked")) is False


def test_positive_result_is_cached_and_negative_is_rechecked():
    sub._ok.clear()
    f = fake("member"); sub.check(5, "@ch", f); sub.check(5, "@ch", f)
    assert len(f.calls) == 1
    g = fake("left"); sub.check(6, "@ch", g); sub.check(6, "@ch", g)
    assert len(g.calls) == 2


def test_misconfigured_bot_does_not_lock_everyone_out_and_link_is_built():
    sub._ok.clear()
    assert sub.check(7, "@ch", fake(ok=False, desc="Bad Request: chat not found")) is None
    assert sub.check(8, "@ch", fake(ok=False, desc="Bad Request: user not found")) is False
    assert sub.channel_link("@bobsmoke_opt") == "https://t.me/bobsmoke_opt"


def test_private_channel_uses_numeric_id_and_invite_link():
    sub._ok.clear()
    assert sub.chat_ref("-1001234567890") == -1001234567890
    assert sub.chat_ref("@bobsmoke_opt") == "@bobsmoke_opt"
    assert sub.chat_ref("https://t.me/+zoZLEBdZ24MwNDM6") is None       # за запрошенням канал не визначити
    f = fake("member")
    assert sub.check(9, "-1001234567890", f) is True and f.calls[0]["chat_id"] == -1001234567890
    g = fake("member")
    assert sub.check(10, "https://t.me/+zoZLEBdZ24MwNDM6", g) is None and not g.calls   # fail-open, без запиту
    link = "https://t.me/+zoZLEBdZ24MwNDM6"
    assert sub.channel_link("-1001234567890", link) == link
    assert sub.channel_link("@bobsmoke_opt") == "https://t.me/bobsmoke_opt"
    assert sub.channel_link("-1001234567890") == ""
    assert sub.label("-1001234567890") == "" and sub.label("@ch") == "@ch"


def test_default_channel_is_bobsmoke_opt(monkeypatch):
    from backend.config import settings
    monkeypatch.delenv("REQUIRED_CHANNEL", raising=False)
    monkeypatch.delenv("REQUIRED_CHANNEL_LINK", raising=False)
    assert settings.required_channel == "@bobsmoke_opt"
    assert settings.required_channel_link == "https://t.me/bobsmoke_opt"
    monkeypatch.setenv("REQUIRED_CHANNEL", "")
    assert settings.required_channel == "@bobsmoke_opt"          # порожнє значення не вимикає перевірку
    monkeypatch.setenv("REQUIRED_CHANNEL", "off")
    assert settings.required_channel == ""                       # вимикається лише явно
