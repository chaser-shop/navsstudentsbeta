"""Чат менеджера з покупцями (dashboard) і чек замовлення. Потребують: pip install -r requirements-dev.txt."""
import time
from decimal import Decimal

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
pytest.importorskip("mongomock")
import mongomock  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.database import get_db, to_db  # noqa: E402
from backend.auth.security import current_admin  # noqa: E402
from backend.services import orders as svc  # noqa: E402
from bot import shop_bot  # noqa: E402


class Rec:
    def __init__(self, ok=True):
        self.calls, self.ok = [], ok

    def __call__(self, method, payload=None, **kw):
        self.calls.append((method, payload))
        return {"ok": self.ok, "result": {"message_id": 100 + len(self.calls)}, "description": "Forbidden: bot was blocked by the user"}


@pytest.fixture()
def env(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "x" * 40)
    monkeypatch.setenv("BOT_TOKEN", "1:T")
    monkeypatch.setenv("BOT_ALLOWED_IDS", "7")
    monkeypatch.setenv("PUBLIC_URL", "https://shop.example.com")
    from backend.main import app
    db = mongomock.MongoClient().db
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[current_admin] = lambda: "admin"
    yield TestClient(app), db, app
    app.dependency_overrides.clear()


def _msg(text=None, uid=42, **kw):
    m = {"message_id": int(time.time() * 1000) % 10**6, "chat": {"id": uid, "type": "private"},
         "from": {"id": uid, "first_name": "Іван", "username": "ivan"}}
    if text is not None:
        m["text"] = text
    m.update(kw)
    return {"message": m}


def test_customer_question_reaches_dashboard_and_is_marked_read_on_open(env):
    c, db, _ = env
    rec = Rec()
    shop_bot.handle_update(_msg("Коли відправите?"), call=rec, db=db)
    shop_bot.handle_update(_msg("І який ТТН?"), call=rec, db=db)
    lst = c.get("/api/chats").json()
    assert lst["unread"] == 2 and lst["chats"][0]["id"] == 42 and lst["chats"][0]["name"] == "Іван" and lst["chats"][0]["last_text"] == "І який ТТН?"
    th = c.get("/api/chats/42").json()
    assert [m["text"] for m in th["messages"] if m["dir"] == "in"] == ["Коли відправите?", "І який ТТН?"]
    assert c.get("/api/chats").json()["unread"] == 0
    ops = [p for m, p in rec.calls if m == "sendMessage" and p["chat_id"] == 7]
    assert ops and "Коли відправите?" in ops[0]["text"]                 # оператор отримує сповіщення в Telegram


def test_customer_gets_ack_once_not_on_every_message(env):
    _, db, _ = env
    rec = Rec()
    for t in ("а", "б", "в"):
        shop_bot.handle_update(_msg(t), call=rec, db=db)
    assert len([1 for m, p in rec.calls if p["chat_id"] == 42]) == 1


def test_commands_still_open_the_shop_and_are_not_logged_as_chat(env):
    _, db, _ = env
    rec = Rec()
    shop_bot.handle_update(_msg("/start"), call=rec, db=db)
    assert any("reply_markup" in p for m, p in rec.calls if p["chat_id"] == 42)
    assert db.messages.count_documents({}) == 0


def test_payment_screenshot_is_stored_and_served_only_inside_its_conversation(env, monkeypatch):
    c, db, _ = env
    shop_bot.handle_update(_msg(photo=[{"file_id": "small"}, {"file_id": "BIG"}], caption="оплатив"), call=Rec(), db=db)
    th = c.get("/api/chats/42").json()
    m = th["messages"][0]
    assert m["photo"] is True and m["text"] == "оплатив"
    from backend.routes import chats
    monkeypatch.setattr(chats, "tg_download", lambda fid: (b"IMG", "image/jpeg") if fid == "BIG" else None)
    r = c.get(f"/api/chats/42/photo/{m['id']}")
    assert r.status_code == 200 and r.content == b"IMG" and r.headers["content-type"] == "image/jpeg"
    assert c.get(f"/api/chats/43/photo/{m['id']}").status_code == 404      # чужий чат: файл не віддається


def test_manager_reply_is_sent_through_bot_and_logged(env, monkeypatch):
    c, db, _ = env
    shop_bot.handle_update(_msg("Привіт"), call=Rec(), db=db)
    from backend.routes import chats
    rec = Rec()
    monkeypatch.setattr(chats, "tg_call", rec)
    assert c.post("/api/chats/42/messages", json={"text": "  Відправимо завтра  "}).status_code == 201
    assert rec.calls == [("sendMessage", {"chat_id": 42, "text": "Відправимо завтра"})]
    last = c.get("/api/chats/42").json()["messages"][-1]
    assert last["dir"] == "out" and last["by"] == "admin" and last["text"] == "Відправимо завтра"
    monkeypatch.setattr(chats, "tg_call", Rec(ok=False))
    bad = c.post("/api/chats/42/messages", json={"text": "ще"})
    assert bad.status_code == 502 and "blocked" in bad.json()["detail"]
    assert db.messages.count_documents({"dir": "out"}) == 1              # недоставлене повідомлення не зберігається як надіслане
    assert c.post("/api/chats/999/messages", json={"text": "x"}).status_code == 404
    assert c.post("/api/chats/42/messages", json={"text": ""}).status_code == 422


def test_chat_and_receipt_routes_require_admin(env):
    c, db, app = env
    app.dependency_overrides.pop(current_admin)
    for path in ("/api/chats", "/api/chats/42", "/api/orders/ORD-1/receipt.png"):
        assert c.get(path).status_code == 401


def test_order_receipt_png_and_resend(env, monkeypatch):
    c, db, _ = env
    pid = str(db.products.insert_one(to_db({"name": "Blueberry", "brand": "ElfLiq", "category": "liquid", "product_line": "ELF LIQ 30ml",
                                            "volume_ml": 30, "status": "in_stock", "final_price": Decimal("250")})).inserted_id)
    o = svc.create_order(db, {"name": "Іван", "phone": "+380671234567", "tg_id": 42,
                              "delivery": {"carrier": "nova_poshta", "city": "Київ", "warehouse": "№1"}},
                         [{"product_id": pid, "qty": 2, "nicotine_mg": 50}], "adm", extra={"payment": svc.payment_info("cod", 100)})
    r = c.get(f"/api/orders/{o['number']}/receipt.png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and r.content.startswith(b"\x89PNG")
    assert c.get("/api/orders/NOPE/receipt.png").status_code == 404
    from backend.routes import orders as orders_route
    sent = []
    monkeypatch.setattr(orders_route, "deliver_order", lambda d, n: sent.append(n) or {"ok": True})
    assert c.post(f"/api/orders/{o['number']}/resend").status_code == 200 and sent == [o["number"]]
