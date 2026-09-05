"""Native-client wake coordination. This module never starts an AI conversation."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
import secrets
import sqlite3
from zoneinfo import ZoneInfo


LOCAL_ZONE = ZoneInfo("Asia/Kuching")
CLIENTS = {"chatgpt", "claude"}
MAX_PER_DAY = 10
MIN_GAP_SECONDS = 3600


class WakePolicy:
    def __init__(self, database: str | Path, clock=None):
        self.database = Path(database).expanduser().resolve()
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.database.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self._connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS settings (
                    client TEXT PRIMARY KEY,
                    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1))
                );
                CREATE TABLE IF NOT EXISTS claims (
                    id TEXT PRIMARY KEY,
                    client TEXT NOT NULL,
                    local_date TEXT NOT NULL,
                    local_slot TEXT NOT NULL,
                    claimed_at REAL NOT NULL,
                    outcome TEXT NOT NULL DEFAULT 'reserved',
                    UNIQUE(client, local_slot)
                );
                CREATE INDEX IF NOT EXISTS claims_by_client_day
                    ON claims(client, local_date);
            """)
        self.database.chmod(0o600)

    @contextmanager
    def _connection(self):
        db = sqlite3.connect(self.database, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    @staticmethod
    def _client(client):
        if client not in CLIENTS:
            raise ValueError("client must be chatgpt or claude")
        return client

    def _now(self):
        now = self.clock()
        if now.tzinfo is None:
            raise ValueError("clock must return a timezone-aware datetime")
        return now.astimezone(LOCAL_ZONE)

    def _status(self, db, client, now):
        row = db.execute("SELECT enabled FROM settings WHERE client = ?", (client,)).fetchone()
        count = db.execute(
            "SELECT COUNT(*) FROM claims WHERE client = ? AND local_date = ?",
            (client, now.date().isoformat()),
        ).fetchone()[0]
        last = db.execute(
            "SELECT MAX(claimed_at) FROM claims WHERE client = ?", (client,)
        ).fetchone()[0]
        enabled = bool(row and row[0])
        start = 9 if now.weekday() >= 5 else 17
        reason = "ready"
        if not enabled:
            reason = "disabled"
        elif not start <= now.hour < 23:
            reason = "quiet_hours"
        elif count >= MAX_PER_DAY:
            reason = "daily_limit"
        elif last is not None and now.timestamp() - last < MIN_GAP_SECONDS:
            reason = "cooldown"
        return {
            "client": client,
            "enabled": enabled,
            "local_time": now.isoformat(timespec="seconds"),
            "time_zone": "Asia/Kuching",
            "feeding_day": (now.date() - date(2025, 4, 6)).days + 1,
            "claims_today": count,
            "max_claims_per_day": MAX_PER_DAY,
            "minimum_gap_minutes": MIN_GAP_SECONDS // 60,
            "wake_window": f"{start:02d}:00-23:00",
            "eligible": reason == "ready",
            "reason": reason,
            "native_task_required": True,
            "delivery_verified": False,
        }

    def status(self, client):
        client = self._client(client)
        with self._connection() as db:
            return self._status(db, client, self._now())

    def set_enabled(self, client, enabled):
        client = self._client(client)
        if type(enabled) is not bool:
            raise ValueError("enabled must be a boolean")
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute(
                    "INSERT INTO settings(client, enabled) VALUES (?, ?) "
                    "ON CONFLICT(client) DO UPDATE SET enabled = excluded.enabled",
                    (client, int(enabled)),
                )
                result = self._status(db, client, self._now())
                db.commit()
                return result
            except BaseException:
                db.rollback()
                raise

    def claim(self, client):
        """Reserve at most one attempt. Retries do not grant another permission."""
        client = self._client(client)
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                now = self._now()
                result = self._status(db, client, now)
                result["allowed"] = False
                if result["eligible"]:
                    claim_id = secrets.token_hex(16)
                    cursor = db.execute(
                        "INSERT OR IGNORE INTO claims "
                        "(id, client, local_date, local_slot, claimed_at) VALUES (?, ?, ?, ?, ?)",
                        (claim_id, client, now.date().isoformat(), now.strftime("%Y-%m-%dT%H"), now.timestamp()),
                    )
                    if cursor.rowcount == 1:
                        result.update(allowed=True, claim_id=claim_id, claims_today=result["claims_today"] + 1)
                    else:
                        result.update(reason="already_reserved", eligible=False)
                db.commit()
                return result
            except BaseException:
                db.rollback()
                raise

    def record_outcome(self, client, claim_id, outcome):
        """Record a client's assertion, never a claim of verified app delivery."""
        client = self._client(client)
        if outcome not in {"generated", "skipped", "failed"}:
            raise ValueError("outcome must be generated, skipped or failed")
        if not isinstance(claim_id, str) or len(claim_id) != 32:
            raise ValueError("invalid claim_id")
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute(
                    "SELECT outcome FROM claims WHERE id = ? AND client = ?", (claim_id, client)
                ).fetchone()
                if not row:
                    raise ValueError("claim not found for this client")
                if row[0] not in {"reserved", outcome}:
                    raise ValueError("claim already has a different outcome")
                db.execute("UPDATE claims SET outcome = ? WHERE id = ? AND client = ?", (outcome, claim_id, client))
                db.commit()
                return {"client": client, "claim_id": claim_id, "client_reported_outcome": outcome, "delivery_verified": False}
            except BaseException:
                db.rollback()
                raise
