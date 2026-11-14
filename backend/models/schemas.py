from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from ..services.validators import normalize_phone

Category = Literal["liquid", "pod", "cartridge", "booster"]


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class ProductIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    brand: str = Field(min_length=1, max_length=80)
    category: Category | None = None
    product_line: str | None = None
    custom_line: str | None = Field(None, max_length=200)   # лінійка для групових цін (будь-яка категорія)
    model: str | None = None
    variant: str | None = None
    volume_ml: float | None = Field(None, ge=0)
    nicotine_mg: float | None = Field(None, ge=0)
    purchase_price: str | None = Field(None, pattern=r"^\d{1,7}(\.\d{1,2})?$")
    final_price: str | None = Field(None, pattern=r"^\d{1,7}(\.\d{1,2})?$")   # ціна продажу (замість закупівельної)
    status: Literal["in_stock", "expected", "unavailable"] = "in_stock"
    images: list[str] = Field(default=[], max_length=10)
    hot: bool = False
    retail_markup: str | None = Field(None, pattern=r"^\d{1,7}(\.\d{1,2})?$")   # націнка цього товару в роздробі, грн (None = загальна з налаштувань)
    sheet_source: str | None = Field(None, max_length=120)   # розділ Excel, з якого товар додано кнопкою «Додати» (тоді наявність звіряється з таблицею)

    @model_validator(mode="after")
    def _need_price(self):
        if self.purchase_price is None and self.final_price is None:
            raise ValueError("Вкажіть ціну")
        if self.purchase_price is not None and self.final_price is not None:
            raise ValueError("Вкажіть лише одну ціну: закупівельну або продажу")
        return self


class ProductPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    brand: str | None = Field(None, min_length=1, max_length=80)
    category: Category | None = None
    product_line: str | None = Field(None, max_length=200)
    custom_line: str | None = Field(None, max_length=200)
    model: str | None = Field(None, max_length=120)
    variant: str | None = Field(None, max_length=120)
    volume_ml: float | None = Field(None, ge=0)
    nicotine_mg: float | None = Field(None, ge=0)
    purchase_price: str | None = Field(None, pattern=r"^\d{1,7}(\.\d{1,2})?$")
    final_price: str | None = Field(None, pattern=r"^\d{1,7}(\.\d{1,2})?$")
    status: Literal["in_stock", "expected", "unavailable"] | None = None
    images: list[str] | None = Field(None, max_length=10)
    hot: bool | None = None
    retail_markup: str | None = Field(None, pattern=r"^\d{1,7}(\.\d{1,2})?$")


class PriceOp(BaseModel):
    mode: Literal["set", "shift", "percent"]
    value: str = Field(pattern=r"^-?\d{1,7}(\.\d{1,2})?$")


class LinePriceIn(BaseModel):
    line_key: str = Field(min_length=2, max_length=40)
    wholesale: PriceOp | None = None
    retail: PriceOp | None = None
    reset_retail: bool = False
    dry_run: bool = False

    @model_validator(mode="after")
    def _any(self):
        if not (self.wholesale or self.retail or self.reset_retail):
            raise ValueError("Вкажіть нову ціну опту або роздробу")
        return self


class LineAssignIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)
    line: str | None = Field(None, max_length=200)


class MarkupsIn(BaseModel):
    markups: dict[Category, str]


class PromoCodeIn(BaseModel):
    """Новий промокод (адмін). code порожній — згенерується; max_uses порожній — без ліміту; expires — остання дата дії."""
    code: str | None = Field(None, max_length=32)
    percent: str = Field(pattern=r"^\d{1,3}([.,]\d{1,2})?$")
    max_uses: int | None = Field(None, ge=1, le=1_000_000)
    expires: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class PromoActiveIn(BaseModel):
    active: bool


class PromoCheckIn(BaseModel):
    code: str = Field(min_length=1, max_length=40)


class OrderItemIn(BaseModel):
    product_id: str
    qty: int = Field(ge=1, le=1000)


class Delivery(BaseModel):
    carrier: Literal["nova_poshta"] = "nova_poshta"
    city: str = Field(min_length=1, max_length=120)
    area: str = Field(default="", max_length=120)
    warehouse: str = Field(min_length=1, max_length=250)
    city_ref: str = Field(default="", max_length=64)
    warehouse_ref: str = Field(default="", max_length=64)


class OrderIn(BaseModel):
    customer_name: str = Field(min_length=1, max_length=120)
    contact: str = Field(default="", max_length=120)
    phone: str | None = None
    delivery: Delivery | None = None

    @field_validator("phone")
    @classmethod
    def _phone(cls, v):
        return None if not v else normalize_phone(v)
    items: list[OrderItemIn] = Field(min_length=1)


class StatusIn(BaseModel):
    status: str
    reason: str = Field(default="", max_length=500)    # коментар / причина відхилення
    notify: bool = True                                 # надіслати покупцю повідомлення в Telegram


class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


class ShopItem(BaseModel):
    product_id: str = Field(min_length=1, max_length=40)
    qty: int = Field(ge=1, le=99)
    nicotine_mg: int | None = Field(None, ge=1, le=200)     # обрана міцність (лише для рідин); перевіряє сервер


class CartSyncIn(BaseModel):
    items: list[ShopItem] = Field(default=[], max_length=100)


class ShopOrderIn(BaseModel):
    """Замовлення з Mini App. Ціни тут НЕ приймаються: їх бере сервер із БД."""
    first_name: str = Field(min_length=1, max_length=60)
    last_name: str = Field(min_length=1, max_length=60)
    phone: str
    delivery: Delivery
    items: list[ShopItem] = Field(min_length=1, max_length=100)
    order_type: Literal["wholesale", "retail"] = "wholesale"   # опт / роздріб (роздріб: націнка на позиції, окремий мінімум)
    payment_method: Literal["cod", "prepaid"] = "cod"   # cod — накладений платіж (передоплата), prepaid — повна оплата на карту
    promo_code: str | None = Field(None, max_length=40)    # промокод (необов'язково); знижку рахує сервер
    prepay_accepted: bool = False          # застаріле поле (галочка): більше не вимагається, вибір способу оплати = згода

    @field_validator("first_name", "last_name")
    @classmethod
    def _strip(cls, v):
        v = " ".join(v.split())
        if not v:
            raise ValueError("Порожнє значення")
        return v

    @field_validator("phone")
    @classmethod
    def _phone(cls, v):
        return normalize_phone(v)
