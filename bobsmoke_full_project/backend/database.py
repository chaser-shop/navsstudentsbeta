"""Єдине підключення до MongoDB + конвертація грошових значень (Decimal128)."""
from datetime import datetime
from decimal import Decimal

import certifi
from bson import ObjectId
from bson.decimal128 import Decimal128
from pymongo import ASCENDING, MongoClient

from .config import settings

_client: MongoClient | None = None


def get_db():
    global _client
    if not settings.mongodb_uri:
        raise RuntimeError("MONGODB_URI не задано (див. .env.example)")
    if _client is None:
        _client = MongoClient(settings.mongodb_uri, serverSelectionTimeoutMS=8000, tz_aware=True,
                              tlsCAFile=certifi.where())
    return _client[settings.mongodb_database]


def ensure_indexes(db) -> None:
    db.products.create_index([("dedupe_key", ASCENDING)], unique=True)
    db.products.create_index([("category", ASCENDING), ("brand", ASCENDING)])
    db.products.create_index([("name", ASCENDING)])
    db.products.create_index([("final_price", ASCENDING)])
    db.orders.create_index([("number", ASCENDING)], unique=True)
    db.orders.create_index([("status", ASCENDING), ("created_at", ASCENDING)])
    db.orders.create_index([("customer.tg_id", ASCENDING), ("created_at", ASCENDING)])
    db.products.create_index([("status", ASCENDING)])
    db.messages.create_index([("tg_id", ASCENDING), ("at", ASCENDING)])
    db.chats.create_index([("last_at", ASCENDING)])
    db.users.create_index([("referred_by", ASCENDING)])
    db.promo_codes.create_index([("owner_tg_id", ASCENDING)])
    db.admins.create_index([("username", ASCENDING)], unique=True)
    db.audit_log.create_index([("at", ASCENDING)])
    db.broadcast_files.create_index([("broadcast", ASCENDING), ("created_at", ASCENDING)])
    db.sync_sessions.create_index([("created_at", ASCENDING)], expireAfterSeconds=7 * 86400)   # непідтверджені зміни з Excel зникають за тиждень


def to_db(o):
    """Decimal -> Decimal128 (рекурсивно) для запису."""
    if isinstance(o, Decimal):
        return Decimal128(o)
    if isinstance(o, dict):
        return {k: to_db(v) for k, v in o.items()}
    if isinstance(o, list):
        return [to_db(v) for v in o]
    return o


def load(o):
    """Decimal128 -> Decimal (рекурсивно) для розрахунків."""
    if isinstance(o, Decimal128):
        return o.to_decimal()
    if isinstance(o, dict):
        return {k: load(v) for k, v in o.items()}
    if isinstance(o, list):
        return [load(v) for v in o]
    return o


def public(o):
    """Готує документ до JSON: гроші -> рядки, ObjectId -> str, дати -> ISO."""
    o = load(o)
    if isinstance(o, Decimal):
        return format(o, "f")
    if isinstance(o, ObjectId):
        return str(o)
    if isinstance(o, datetime):
        return o.isoformat()
    if isinstance(o, dict):
        return {("id" if k == "_id" else k): public(v) for k, v in o.items()}
    if isinstance(o, list):
        return [public(v) for v in o]
    return o
