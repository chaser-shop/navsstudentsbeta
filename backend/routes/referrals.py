"""Вкладка «Реферали» в dashboard: рейтинг тих, хто запросив найбільше людей."""
from datetime import timezone

from fastapi import APIRouter, Depends, Query

from ..auth.security import current_admin
from ..database import get_db
from ..services import referral

router = APIRouter(prefix="/api/referrals", tags=["referrals"])


def _iso(d):
    return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).isoformat() if d else None


@router.get("")
def rating(days: int = Query(0, ge=0, le=3650), db=Depends(get_db), _=Depends(current_admin)):
    """days=0 — за весь час; 7 / 30 — лише запрошення за цей період."""
    out = referral.leaderboard(db, days=days or None)
    for r in out["rows"]:
        r["last_invited_at"] = _iso(r["last_invited_at"])
    for r in out["recent"]:
        r["at"] = _iso(r["at"])
    return out
