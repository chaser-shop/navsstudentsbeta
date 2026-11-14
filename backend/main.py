import logging
import threading
import time
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pymongo.errors import PyMongoError

from bot import shop_bot

from .config import settings
from .database import ensure_indexes, get_db
from .services import user_sync
from .routes import auth, bot, broadcast, chats, imports, lines, media, orders, pricing, products, promo, referrals, settings as settings_routes, shop, stats, sync, telegram, users

ROOT = Path(__file__).resolve().parent.parent
log = logging.getLogger("app")


def _keepalive() -> None:
    """Render free засинає після 15 хв без вхідних запитів (бот «мовчить», перший /start чекає до хвилини).
    Раз на KEEPALIVE_SECONDS звертаємось до власного публічного /health: запит іде через Render, тож інстанс не засинає."""
    url = f"{settings.public_url}/health"
    interval = max(60, settings.keepalive_seconds)
    time.sleep(30)                                  # даємо серверу повністю стартувати
    while True:
        try:
            urllib.request.urlopen(url, timeout=20).read()
        except Exception as e:                      # тимчасові збої не критичні, наступна спроба через інтервал
            log.warning("keepalive: %s", e)
        time.sleep(interval)


@asynccontextmanager
async def lifespan(app):
    try:
        ensure_indexes(get_db())
    except Exception:                 # напр. дублікати dedupe_key у старих даних: магазин усе одно має працювати
        log.exception("Не вдалося створити індекси MongoDB")
    # вебхук реєструємо у фоні, щоб не затримувати старт (Render чекає відкриття порту)
    threading.Thread(target=shop_bot.setup_webhook, daemon=True).start()
    if settings.keepalive_seconds > 0 and settings.public_url.startswith("https://"):
        threading.Thread(target=_keepalive, daemon=True, name="keepalive").start()
    if not settings.required_channel:
        logging.getLogger("subscription").warning("Підписка на канал НЕ перевіряється (REQUIRED_CHANNEL=off)")
    else:
        logging.getLogger("subscription").info(
            "Обов'язкова підписка на %s. Бот має бути АДМІНІСТРАТОРОМ каналу, інакше перевірка пропускається", settings.required_channel)
    if settings.user_sync_hours > 0 and settings.mongodb_uri:
        threading.Thread(target=user_sync.schedule_loop, args=(get_db, settings.user_sync_hours), daemon=True, name="user-sync").start()
    yield


app = FastAPI(title="Back-office", lifespan=lifespan, docs_url=None, redoc_url=None)
app.add_middleware(GZipMiddleware, minimum_size=1024)
for r in (auth, products, lines, media, pricing, imports, sync, orders, settings_routes, bot, broadcast, chats, shop, telegram, users, promo, referrals, stats):
    app.include_router(r.router)


@app.middleware("http")
async def cache_headers(request: Request, call_next):
    resp = await call_next(request)
    p = request.url.path
    if p.startswith(("/app/", "/admin")) or p == "/app":
        resp.headers["Cache-Control"] = "no-cache"            # браузер перевіряє ETag: оновлення видно одразу (в т.ч. в адмін-панелі)
    elif p.startswith("/img/"):
        resp.headers["Cache-Control"] = "public, max-age=604800, immutable"
    elif p.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    return resp


@app.exception_handler(PyMongoError)
async def mongo_error(_: Request, exc: PyMongoError):
    return JSONResponse({"detail": "База даних тимчасово недоступна"}, status_code=503)


@app.get("/health")
def health():
    try:
        get_db().command("ping")
        return {"ok": True}
    except Exception:
        return JSONResponse({"ok": False}, status_code=503)


@app.get("/")
def root():
    return RedirectResponse("/app/" if not (ROOT / "frontend" / "admin").is_dir() else "/admin/")


# /img/<файл> віддає routes/media.py: спершу imports/images, потім фото, завантажені через dashboard (MongoDB)
app.mount("/app", StaticFiles(directory=ROOT / "frontend" / "miniapp", html=True), name="miniapp")
if (ROOT / "frontend" / "admin").is_dir():          # у наданому архіві адмін-панелі немає: без неї API працює
    app.mount("/admin", StaticFiles(directory=ROOT / "frontend" / "admin", html=True), name="admin")
else:
    log.warning("frontend/admin не знайдено: адмін-панель недоступна, API працює")
