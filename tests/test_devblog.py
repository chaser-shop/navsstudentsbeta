"""Dev-blog: сповіщення адміністраторам про зміни в каталозі."""
from datetime import datetime, timezone
from decimal import Decimal

from backend.services import devblog as dv

NOW = datetime(2026, 10, 22, 18, 30, tzinfo=timezone.utc)


def _p(**kw):
    base = {"name": "Mango Ice", "brand": "Elf Bar", "product_line": "Elf Liq 10ml", "status": "in_stock",
            "final_price": Decimal("450.00"), "images": [], "hot": False}
    base.update(kw)
    return base


# ---------- чисті функції ----------
def test_diff_shows_only_real_changes():
    old, new = _p(), _p(final_price=Decimal("480"), status="unavailable")
    labels = {l: (a, b) for l, a, b in dv.diff_product(old, new)}
    assert set(labels) == {"Ціна", "Статус"}
    assert labels["Ціна"] == ("450 ₴", "480 ₴")
    assert "Немає в наявності" in labels["Статус"][1]


def test_decimal_formatting_is_not_a_change():
    assert dv.diff_product(_p(final_price=Decimal("450.00")), _p(final_price=Decimal("450"))) == []
    assert dv.change_entry(_p(), _p(updated_at=1, markup=Decimal("5"))) is None     # службові поля не рахуються


def test_price_format():
    assert dv._price(Decimal("1250")) == "1\u202f250 ₴"
    assert dv._price(Decimal("99.5")) == "99.50 ₴"
    assert dv._price(None) == "—"


def test_render_sections_and_escaping():
    added = [dv.snapshot(_p(name="<b>Hack</b> & Co"))]
    removed = [dv.snapshot(_p(name="Old Pod", status="unavailable"))]
    changed = [dv.change_entry(_p(), _p(final_price=Decimal("480")))]
    t = dv.render(added, removed, changed, source="Зміна товару", actor="admin", now=NOW)
    assert "DEV-BLOG" in t and "➕ <b>Додано · 1</b>" in t and "➖ <b>Прибрано · 1</b>" in t and "✏️ <b>Змінено · 1</b>" in t
    assert "&lt;b&gt;Hack&lt;/b&gt; &amp; Co" in t                     # користувацький текст екранується
    assert "<s>450 ₴</s> → <b>480 ₴</b>" in t
    assert "admin" in t and "22.10.2026" in t


def test_empty_sections_are_omitted():
    t = dv.render([], [], [dv.change_entry(_p(), _p(hot=True))], now=NOW)
    assert "Додано" not in t and "Прибрано" not in t and "Змінено" in t


def test_long_message_fits_telegram_limit_and_tags_balance():
    many = [dv.snapshot(_p(name=f"Flavor number {i} " * 3)) for i in range(400)]
    t = dv.render(many, many, [dv.change_entry(_p(), _p(final_price=Decimal(i + 500))) for i in range(300)], now=NOW)
    assert len(t) <= 4096
    for tag in ("b", "i", "s", "code"):
        assert t.count(f"<{tag}>") == t.count(f"</{tag}>")
    assert "та ще" in t


def test_publish_noop_without_changes():
    assert dv.publish() is None


# ---------- інтеграція з маршрутами ----------
def _client(monkeypatch):
    import pytest
    pytest.importorskip("fastapi"); pytest.importorskip("httpx"); pytest.importorskip("mongomock")
    import mongomock
    from fastapi.testclient import TestClient
    from backend.auth.security import current_admin
    from backend.database import get_db
    monkeypatch.setenv("JWT_SECRET", "x" * 40)
    monkeypatch.setenv("BOT_TOKEN", "1:T")
    monkeypatch.setenv("BOT_ALLOWED_IDS", "7,8")
    from backend.main import app
    db = mongomock.MongoClient().db
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[current_admin] = lambda: "admin"
    sent = []
    monkeypatch.setattr("backend.services.telegram_api.tg_call",
                        lambda method, payload=None, **kw: sent.append((method, payload)) or {"ok": True})
    # notify_operators має default-аргумент call=tg_call, зафіксований при імпорті: підміняємо його напряму
    from backend.services import telegram_api as tga
    monkeypatch.setattr(tga.notify_operators, "__defaults__", (lambda m, p=None, **kw: sent.append((m, p)) or {"ok": True}, None))
    return TestClient(app), db, app, sent


def test_create_update_delete_send_messages(monkeypatch):
    c, db, app, sent = _client(monkeypatch)
    try:
        body = {"name": "Mango Ice", "brand": "Elf Bar", "category": "liquid", "product_line": "Elf Liq 10ml",
                "volume_ml": 10, "nicotine_mg": 50, "final_price": "450", "status": "in_stock"}
        r = c.post("/api/products", json=body)
        assert r.status_code == 201, r.text
        pid = r.json()["id"]
        assert len(sent) == 2                                      # по одному повідомленню кожному оператору
        assert all(m == "sendMessage" and p["parse_mode"] == "HTML" for m, p in sent)
        assert "Додано" in sent[0][1]["text"] and "Mango Ice" in sent[0][1]["text"]

        sent.clear()
        assert c.patch(f"/api/products/{pid}", json={"final_price": "480", "status": "unavailable"}).status_code == 200
        t = sent[0][1]["text"]
        assert "Змінено" in t and "450 ₴" in t and "480 ₴" in t and "Немає в наявності" in t

        sent.clear()
        assert c.patch(f"/api/products/{pid}", json={"final_price": "480"}).status_code == 200
        assert sent == []                                          # нічого не змінилось — тиші в чаті

        assert c.delete(f"/api/products/{pid}?confirm=true").status_code == 200
        assert "Прибрано" in sent[0][1]["text"] and "Mango Ice" in sent[0][1]["text"]
    finally:
        app.dependency_overrides.clear()
