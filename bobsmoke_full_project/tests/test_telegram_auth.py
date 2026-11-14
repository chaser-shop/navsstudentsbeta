import json
import time

from backend.services.telegram_auth import InitDataError, sign_init_data, validate_init_data

TOKEN = "123456:TEST-TOKEN"


def _fields(uid=42, age=0):
    return {"auth_date": str(int(time.time()) - age), "query_id": "AAH",
            "user": json.dumps({"id": uid, "first_name": "Іван", "username": "ivan"}, ensure_ascii=False)}


def test_valid_init_data_returns_user():
    r = validate_init_data(sign_init_data(_fields(), TOKEN), TOKEN)
    assert r["user"]["id"] == 42 and r["user"]["username"] == "ivan"


def _rejects(raw, token=TOKEN, **kw):
    try:
        validate_init_data(raw, token, **kw)
    except InitDataError:
        return True
    return False


def test_tampered_data_is_rejected():
    raw = sign_init_data(_fields(uid=42), TOKEN)
    forged = raw.replace("%22id%22%3A+42", "%22id%22%3A+1")
    assert forged != raw and _rejects(forged)


def test_wrong_bot_token_is_rejected():
    assert _rejects(sign_init_data(_fields(), TOKEN), token="999:OTHER")


def test_expired_and_missing_data_are_rejected():
    assert _rejects(sign_init_data(_fields(age=90000), TOKEN), max_age=86400)
    assert _rejects("") and _rejects("hash=abc") and _rejects("user=%7B%7D", token="")


def test_user_without_id_is_rejected():
    f = {"auth_date": str(int(time.time())), "user": json.dumps({"first_name": "x"})}
    assert _rejects(sign_init_data(f, TOKEN))
