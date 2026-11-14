"""Рейтинг запрошувачів: сортування, період, виручка лише з виконаних, видалені запрошувачі."""
from datetime import datetime, timedelta, timezone

from backend.services import referral

NOW = datetime(2026, 10, 25, tzinfo=timezone.utc)


class Coll:
    def __init__(self, docs):
        self.docs = docs

    def find(self, flt=None, proj=None):
        return list(self.docs)


class DB:
    def __init__(self, users, orders=()):
        self.users, self.orders = Coll(list(users)), Coll(list(orders))


def inv(uid, by, days_ago, rewarded=False, name="N"):
    return {"_id": uid, "first_name": name, "referred_by": by, "referred_at": NOW - timedelta(days=days_ago), "referral_rewarded": rewarded}


def order(uid, total, status="done"):
    return {"customer": {"tg_id": uid}, "total": total, "status": status}


def test_ranking_by_invited_then_rewarded_and_totals():
    users = [{"_id": 1, "first_name": "Оля", "username": "olya"}, {"_id": 2, "first_name": "Ігор"},
             inv(10, 1, 1), inv(11, 1, 2, True), inv(12, 2, 3), inv(13, 2, 4, True), inv(14, 2, 5), {"_id": 99}]
    orders = [order(11, 1000), order(13, 500), order(13, 300, "new"), order(99, 7777)]
    out = referral.leaderboard(DB(users, orders), now=NOW)
    rows = out["rows"]
    assert [r["id"] for r in rows] == [2, 1] and [r["rank"] for r in rows] == [1, 2]
    assert rows[0]["invited"] == 3 and rows[0]["rewarded"] == 1 and rows[0]["orders"] == 1 and rows[0]["orders_sum"] == 500
    assert rows[1]["username"] == "olya" and rows[1]["orders_sum"] == 1000
    assert out["summary"] == {"invited": 5, "referrers": 2, "rewarded": 2, "orders": 2, "orders_sum": 1500}
    assert out["recent"][0]["id"] == 10 and out["recent"][0]["referrer"] == "Оля"


def test_period_filter_and_deleted_referrer_kept():
    users = [inv(10, 5, 1), inv(11, 5, 40), inv(12, 6, 2)]              # запрошувачів 5 і 6 уже немає в users
    out = referral.leaderboard(DB(users), days=7, now=NOW)
    assert [(r["id"], r["invited"], r["deleted"]) for r in out["rows"]] == [(5, 1, True), (6, 1, True)] or \
           [(r["id"], r["invited"], r["deleted"]) for r in out["rows"]] == [(6, 1, True), (5, 1, True)]
    assert out["rows"][0]["name"] == "Без імені"
    all_time = referral.leaderboard(DB(users), now=NOW)
    assert all_time["rows"][0]["id"] == 5 and all_time["rows"][0]["invited"] == 2


def test_empty():
    out = referral.leaderboard(DB([{"_id": 1}]), now=NOW)
    assert out["rows"] == [] and out["summary"]["invited"] == 0
