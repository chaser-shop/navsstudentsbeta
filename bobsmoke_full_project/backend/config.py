"""Налаштування з .env / змінних середовища. Секрети в коді не зберігаються."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_env() -> None:
    f = ROOT / ".env"
    if not f.exists():
        return
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()


DEFAULT_REQUIRED_CHANNEL = "@bobsmoke_opt"
DEFAULT_REQUIRED_CHANNEL_LINK = "https://t.me/bobsmoke_opt"

class _Settings:
    @property
    def mongodb_uri(self) -> str:
        return os.environ.get("MONGODB_URI", "")

    @property
    def mongodb_database(self) -> str:
        return os.environ.get("MONGODB_DATABASE", "backoffice")

    @property
    def jwt_secret(self) -> str:
        s = os.environ.get("JWT_SECRET", "")
        if len(s) < 32:
            raise RuntimeError("JWT_SECRET має бути заданий і містити щонайменше 32 символи")
        return s

    @property
    def token_ttl_minutes(self) -> int:
        return int(os.environ.get("TOKEN_TTL_MINUTES", "480"))

    @property
    def images_dir(self) -> Path:
        return Path(os.environ.get("IMAGES_DIR", str(ROOT / "imports" / "images")))


    # --- Telegram Mini App / бот-вітрина ---
    @property
    def bot_token(self) -> str:
        return os.environ.get("BOT_TOKEN", "")

    @property
    def bot_username(self) -> str:
        """Username бота без @ (для реферальних посилань). Не задано — беремо з Telegram (getMe)."""
        return os.environ.get("BOT_USERNAME", "").strip().lstrip("@")

    @property
    def webhook_secret(self) -> str:
        return os.environ.get("WEBHOOK_SECRET", "")

    @property
    def public_url(self) -> str:
        """Публічна HTTPS-адреса сервісу. На Render підставляється автоматично (RENDER_EXTERNAL_URL)."""
        return (os.environ.get("PUBLIC_URL") or os.environ.get("RENDER_EXTERNAL_URL") or "").rstrip("/")

    @property
    def operator_ids(self) -> set[int]:
        """Кому приходять повідомлення про нові замовлення (той самий список, що й BOT_ALLOWED_IDS)."""
        return {int(x) for x in os.environ.get("BOT_ALLOWED_IDS", "").replace(" ", "").split(",") if x.lstrip("-").isdigit()}

    @property
    def miniapp_allowed_ids(self) -> set[int]:
        """Порожньо = магазин відкритий для будь-якого користувача Telegram."""
        return {int(x) for x in os.environ.get("MINIAPP_ALLOWED_IDS", "").replace(" ", "").split(",") if x.lstrip("-").isdigit()}

    @property
    def required_channel(self) -> str:
        """Канал, на який треба підписатись перед входом у магазин: числовий ID (-100…) або @username.
        Для приватного каналу (посилання виду t.me/+…) потрібен саме ID: Telegram не дає перевіряти підписку за запрошенням.
        За замовчуванням — @bobsmoke_opt. Щоб вимкнути перевірку, задайте REQUIRED_CHANNEL=off."""
        v = os.environ.get("REQUIRED_CHANNEL", "").strip() or DEFAULT_REQUIRED_CHANNEL
        return "" if v.lower() in ("off", "none", "0", "false") else v

    @property
    def required_channel_link(self) -> str:
        """Посилання, яке бачить користувач на кнопці «Підписатись» (запрошення в приватний канал або t.me/назва)."""
        return os.environ.get("REQUIRED_CHANNEL_LINK", "").strip() or DEFAULT_REQUIRED_CHANNEL_LINK

    @property
    def miniapp_dev_mode(self) -> bool:
        """Лише для локальної розробки в браузері без Telegram. НІКОЛИ не вмикайте на Render."""
        return os.environ.get("MINIAPP_DEV_MODE", "") == "1"

    @property
    def init_data_ttl(self) -> int:
        return int(os.environ.get("INIT_DATA_TTL_SECONDS", "86400"))

    @property
    def show_blocked(self) -> bool:
        """Застаріле налаштування, збережене для сумісності зі старими .env-файлами."""
        return os.environ.get("SHOW_BLOCKED", "1") != "0"

    @property
    def np_api_key(self) -> str:
        return os.environ.get("NOVA_POSHTA_API_KEY", "")

    @property
    def orders_per_hour(self) -> int:
        return int(os.environ.get("ORDERS_PER_HOUR", "5"))

    @property
    def min_order_total(self) -> int:
        """Мінімальна сума замовлення з Mini App, грн."""
        return int(os.environ.get("MIN_ORDER_TOTAL", "1500"))

    @property
    def min_order_retail(self) -> int:
        """Мінімальна сума роздрібного замовлення з Mini App, грн."""
        return int(os.environ.get("MIN_ORDER_RETAIL", "500"))

    @property
    def retail_markup(self) -> int:
        """Націнка на одиницю товару при роздрібному замовленні (крім картриджів), грн."""
        return int(os.environ.get("RETAIL_MARKUP", "100"))

    @property
    def prepay_enabled(self) -> bool:
        """Чи просити передоплату при накладеному платежі. За замовчуванням ні (PREPAY_ENABLED=1 вмикає назад)."""
        return os.environ.get("PREPAY_ENABLED", "0").strip().lower() in ("1", "true", "yes", "on")

    @property
    def prepay_amount(self) -> int:
        """Можлива передоплата для безпечної доставки, грн (лише для тексту умови)."""
        return int(os.environ.get("PREPAY_AMOUNT", "100"))

    @property
    def user_sync_hours(self) -> float:
        """Як часто перевіряти всіх користувачів і прибирати тих, хто заблокував бота. 0 = вимкнено."""
        return float(os.environ.get("USER_SYNC_HOURS", "24"))

    @property
    def keepalive_seconds(self) -> int:
        """Інтервал самопінгу, щоб Render free не засинав (він засинає після 15 хв без запитів). 0 = вимкнено."""
        return int(os.environ.get("KEEPALIVE_SECONDS", "600"))

    # --- оплата та спілкування з покупцями ---
    @property
    def payment_card_env(self) -> str:
        """Резервний номер картки (основний задає адмін у dashboard → Налаштування)."""
        return os.environ.get("PAYMENT_CARD", "").strip()

    @property
    def manager_username_env(self) -> str:
        return os.environ.get("MANAGER_USERNAME", "@ikwig337").strip()

    @property
    def chat_ack_minutes(self) -> int:
        """Не частіше ніж раз на стільки хвилин бот відповідає покупцю «повідомлення передано менеджеру». 0 = не відповідати."""
        return int(os.environ.get("CHAT_ACK_MINUTES", "30"))


settings = _Settings()
