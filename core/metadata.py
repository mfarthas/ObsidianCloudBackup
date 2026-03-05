import sqlite3
import logging
from pathlib import Path
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


def get_connection(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(db_path: Path) -> None:
    with get_connection(db_path) as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending'
            );

            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_id INTEGER NOT NULL,
                path TEXT NOT NULL,
                blob_hash TEXT NOT NULL,
                FOREIGN KEY (snapshot_id) REFERENCES snapshots(id)
            );

            CREATE TABLE IF NOT EXISTS blobs (
                hash TEXT PRIMARY KEY,
                size INTEGER NOT NULL,
                uploaded_at TEXT NOT NULL
            );
        """)
    logger.info(f"Database initialized at {db_path}")


def create_snapshot(conn: sqlite3.Connection) -> int:
    cursor = conn.execute(
        "INSERT INTO snapshots (created_at, status) VALUES (?, ?)",
        (datetime.now(timezone.utc).isoformat(), "pending")
    )
    snapshot_id = cursor.lastrowid
    logger.info(f"Created pending snapshot {snapshot_id}")
    return snapshot_id


def finalize_snapshot(conn: sqlite3.Connection, snapshot_id: int) -> None:
    conn.execute(
        "UPDATE snapshots SET status = 'complete' WHERE id = ?",
        (snapshot_id,)
    )
    logger.info(f"Snapshot {snapshot_id} marked complete")


def insert_file(conn: sqlite3.Connection, snapshot_id: int, path: str, blob_hash: str) -> None:
    conn.execute(
        "INSERT INTO files (snapshot_id, path, blob_hash) VALUES (?, ?, ?)",
        (snapshot_id, path, blob_hash)
    )


def blob_exists(conn: sqlite3.Connection, blob_hash: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM blobs WHERE hash = ?", (blob_hash,)
    ).fetchone()
    return row is not None


def insert_blob(conn: sqlite3.Connection, blob_hash: str, size: int) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO blobs (hash, size, uploaded_at) VALUES (?, ?, ?)",
        (blob_hash, size, datetime.now(timezone.utc).isoformat())
    )


def list_snapshots(conn: sqlite3.Connection, include_all: bool = False) -> list[sqlite3.Row]:
    if include_all:
        return conn.execute("SELECT * FROM snapshots ORDER BY created_at DESC").fetchall()
    return conn.execute(
        "SELECT * FROM snapshots WHERE status = 'complete' ORDER BY created_at DESC"
    ).fetchall()


def mark_failed_pending_snapshots(conn: sqlite3.Connection) -> None:
    result = conn.execute(
        "UPDATE snapshots SET status = 'failed' WHERE status = 'pending'"
    )
    if result.rowcount > 0:
        logger.warning(f"Marked {result.rowcount} interrupted snapshot(s) as failed — previous run likely crashed")