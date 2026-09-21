#!/usr/bin/env python3
"""SendStack test server.

A dependency-free, single-process implementation of the core MVP workflow. It is
designed for immediate functional testing. SQLite and the in-process worker are
deliberate test-environment choices. The selected production target is a Vercel
application backed by managed PostgreSQL and Resend Broadcasts; the readiness API
keeps that target distinct from the currently active local transport.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import hmac
import html
import io
import json
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import parse_qs, quote, unquote, urlparse


ROOT = Path(__file__).resolve().parent.parent
STATIC_ROOT = ROOT / "app" / "static"
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,200}$")

PRODUCTION_TARGET = {
    "platform": "Vercel",
    "database": "Managed PostgreSQL",
    "provider": "Resend Broadcasts",
    "audience_model": "Resend Contacts + Segments",
}

PERMISSION_DEFINITIONS = {
    "overview.view": ("Overview", "View operational totals and campaign reporting"),
    "sending.view": ("Sending setup", "View production-readiness status"),
    "lists.view": ("List reporting", "View list names and audience totals"),
    "lists.manage": ("Manage lists", "Create audience lists"),
    "contacts.view": ("Recipient data", "View contact identities and consent records"),
    "contacts.manage": ("Manage contacts", "Create and import contacts"),
    "campaigns.view": ("Campaign reporting", "View campaigns, content, and totals"),
    "campaigns.manage": ("Manage campaigns", "Create and edit campaign drafts"),
    "campaigns.send": ("Run campaigns", "Test, launch, pause, and resume campaigns"),
    "deliveries.view": ("Delivery records", "View recipient-level message records"),
    "deliveries.feedback": ("Delivery feedback", "Simulate bounce and complaint events"),
    "suppressions.view": ("Suppression data", "View globally suppressed addresses"),
    "suppressions.manage": ("Manage suppressions", "Add manual global suppressions"),
    "audit.view": ("Audit log", "View administrative activity history"),
    "users.view": ("User directory", "View users and built-in roles"),
    "users.manage": ("Manage access", "Create, update, disable, and reset users"),
}

ROLE_DEFINITIONS = {
    "admin": {
        "label": "Administrator",
        "description": "Full system control, including access management, audit history, and safety events.",
        "permissions": tuple(PERMISSION_DEFINITIONS),
    },
    "marketer": {
        "label": "Marketer",
        "description": "Manages audiences, campaigns, controlled sends, and manual suppressions.",
        "permissions": (
            "overview.view",
            "sending.view",
            "lists.view",
            "lists.manage",
            "contacts.view",
            "contacts.manage",
            "campaigns.view",
            "campaigns.manage",
            "campaigns.send",
            "deliveries.view",
            "suppressions.view",
            "suppressions.manage",
        ),
    },
    "analyst": {
        "label": "Analyst",
        "description": "Read-only campaign reporting without recipient-level personal data.",
        "permissions": (
            "overview.view",
            "sending.view",
            "lists.view",
            "campaigns.view",
        ),
    },
}


def permissions_for_role(role: str) -> frozenset[str]:
    definition = ROLE_DEFINITIONS.get(role)
    return frozenset(definition["permissions"] if definition else ())


def role_definitions_payload() -> list[dict[str, Any]]:
    return [
        {
            "id": role_id,
            "label": definition["label"],
            "description": definition["description"],
            "permissions": list(definition["permissions"]),
        }
        for role_id, definition in ROLE_DEFINITIONS.items()
    ]


def permission_definitions_payload() -> list[dict[str, str]]:
    return [
        {"id": permission_id, "label": values[0], "description": values[1]}
        for permission_id, values in PERMISSION_DEFINITIONS.items()
    ]


def required_permission(method: str, path: str) -> str | None:
    exact_routes = {
        ("GET", "/api/summary"): "overview.view",
        ("GET", "/api/production-readiness"): "sending.view",
        ("GET", "/api/lists"): "lists.view",
        ("POST", "/api/lists"): "lists.manage",
        ("GET", "/api/contacts"): "contacts.view",
        ("POST", "/api/contacts"): "contacts.manage",
        ("POST", "/api/contacts/import"): "contacts.manage",
        ("GET", "/api/suppressions"): "suppressions.view",
        ("POST", "/api/suppressions"): "suppressions.manage",
        ("GET", "/api/campaigns"): "campaigns.view",
        ("POST", "/api/campaigns"): "campaigns.manage",
        ("GET", "/api/messages"): "deliveries.view",
        ("GET", "/api/audit"): "audit.view",
        ("GET", "/api/users"): "users.view",
        ("POST", "/api/users"): "users.manage",
    }
    permission = exact_routes.get((method, path))
    if permission:
        return permission
    if re.fullmatch(r"/api/campaigns/[^/]+", path):
        return "campaigns.view" if method == "GET" else "campaigns.manage" if method == "PATCH" else None
    if re.fullmatch(r"/api/campaigns/[^/]+/(launch|pause|resume|test-send)", path):
        return "campaigns.send" if method == "POST" else None
    if re.fullmatch(r"/api/messages/[^/]+", path):
        return "deliveries.view" if method == "GET" else None
    if re.fullmatch(r"/api/messages/[^/]+/event", path):
        return "deliveries.feedback" if method == "POST" else None
    if re.fullmatch(r"/api/users/[^/]+", path):
        return "users.manage" if method == "PATCH" else None
    if re.fullmatch(r"/api/users/[^/]+/reset-password", path):
        return "users.manage" if method == "POST" else None
    return None


def production_readiness(config: "Config") -> dict[str, Any]:
    """Describe the chosen production path without claiming it is connected.

    These checks intentionally reflect implementation state rather than the mere
    presence of credentials. The local build must not appear production-ready
    until the serverless runtime, durable database, provider adapter, and signed
    webhook flow have actually been implemented and verified.
    """

    checks = [
        {
            "id": "local_test_build",
            "label": "Local test build",
            "status": "ready",
            "detail": "Contacts, four campaign formats, sandbox delivery, suppressions, and audit history are available now.",
        },
        {
            "id": "vercel_runtime",
            "label": "Vercel application runtime",
            "status": "migration_required",
            "detail": "Move the persistent Python server to request-scoped API functions while preserving the existing browser workflow.",
        },
        {
            "id": "postgres_database",
            "label": "Managed PostgreSQL",
            "status": "migration_required",
            "detail": "Migrate SQLite data and queue state to a durable database that supports concurrent Vercel functions.",
        },
        {
            "id": "resend_broadcasts",
            "label": "Resend Broadcasts",
            "status": "not_connected",
            "detail": "Map lists to Segments, sync consented Contacts, and submit each campaign as a duplicate-safe broadcast.",
        },
        {
            "id": "domain_authentication",
            "label": "Sending-domain authentication",
            "status": "not_verified",
            "detail": "Verify the sending domain and From address with SPF and DKIM before any live campaign is unlocked.",
        },
        {
            "id": "signed_webhooks",
            "label": "Signed delivery webhooks",
            "status": "not_connected",
            "detail": "Verify Resend webhook signatures and reconcile delivery, bounce, complaint, suppression, and unsubscribe events.",
        },
    ]
    return {
        "status": "migration_required",
        "ready_for_local_testing": True,
        "ready_for_live_sending": False,
        "current": {
            "runtime": "Local persistent Python server",
            "database": "SQLite",
            "transport": "SMTP test mode" if config.delivery_mode == "smtp" else "Local sandbox",
            "daily_safety_cap": config.daily_limit,
        },
        "target": dict(PRODUCTION_TARGET),
        "checks": checks,
        "delivery_path": [
            "Create and review a campaign in SendStack",
            "Snapshot eligible, consented, unsuppressed recipients",
            "Sync the snapshot to a Resend Segment",
            "Create and submit a Resend Broadcast",
            "Reconcile signed webhook events in PostgreSQL",
        ],
        "volume_plan": {
            "goal": "3,000–10,000 emails per day",
            "launch_policy": "Begin with a small consented canary and increase only while bounce and complaint rates remain healthy.",
            "provider_owns_queue": True,
        },
        "live_send_lock": "Live delivery remains locked until the runtime, database, domain, provider, webhook, and suppression flows are verified.",
    }


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def normalize_email(value: str) -> str:
    return value.strip().lower()


def valid_email(value: str) -> bool:
    return bool(EMAIL_RE.match(normalize_email(value)))


def make_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def hash_password(password: str, *, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    iterations = 210_000
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${base64.urlsafe_b64encode(salt).decode()}${base64.urlsafe_b64encode(digest).decode()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations_text, salt_text, digest_text = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = base64.urlsafe_b64decode(salt_text.encode())
        expected = base64.urlsafe_b64decode(digest_text.encode())
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, int(iterations_text)
        )
        return hmac.compare_digest(candidate, expected)
    except (ValueError, TypeError):
        return False


@dataclass(slots=True)
class Config:
    host: str = os.getenv("SENDSTACK_HOST", "127.0.0.1")
    port: int = int(os.getenv("SENDSTACK_PORT", "8080"))
    db_path: str = os.getenv("SENDSTACK_DB_PATH", str(ROOT / "data" / "sendstack.db"))
    public_url: str = os.getenv("SENDSTACK_PUBLIC_URL", "http://localhost:8080").rstrip("/")
    delivery_mode: str = os.getenv("SENDSTACK_DELIVERY_MODE", "sandbox").strip().lower()
    admin_email: str = os.getenv("SENDSTACK_ADMIN_EMAIL", "admin@sendstack.local")
    admin_password: str = os.getenv("SENDSTACK_ADMIN_PASSWORD", "ChangeMe123!")
    cookie_secure: bool = parse_bool(os.getenv("SENDSTACK_COOKIE_SECURE"), False)
    smtp_host: str = os.getenv("SENDSTACK_SMTP_HOST", "")
    smtp_port: int = int(os.getenv("SENDSTACK_SMTP_PORT", "587"))
    smtp_username: str = os.getenv("SENDSTACK_SMTP_USERNAME", "")
    smtp_password: str = os.getenv("SENDSTACK_SMTP_PASSWORD", "")
    smtp_from_email: str = os.getenv("SENDSTACK_SMTP_FROM_EMAIL", "")
    smtp_starttls: bool = parse_bool(os.getenv("SENDSTACK_SMTP_STARTTLS"), True)
    recipient_allowlist: str = os.getenv("SENDSTACK_TEST_RECIPIENT_ALLOWLIST", "")
    per_second_limit: float = float(os.getenv("SENDSTACK_RATE_PER_SECOND", "1"))
    daily_limit: int = int(os.getenv("SENDSTACK_DAILY_LIMIT", "50"))
    external_campaign_cap: int = int(os.getenv("SENDSTACK_EXTERNAL_CAMPAIGN_CAP", "10"))
    session_hours: int = int(os.getenv("SENDSTACK_SESSION_HOURS", "12"))

    def validate(self) -> None:
        if self.delivery_mode not in {"sandbox", "smtp"}:
            raise ValueError("SENDSTACK_DELIVERY_MODE must be 'sandbox' or 'smtp'")
        if self.delivery_mode == "smtp":
            missing = [
                name
                for name, value in (
                    ("SENDSTACK_SMTP_HOST", self.smtp_host),
                    ("SENDSTACK_SMTP_USERNAME", self.smtp_username),
                    ("SENDSTACK_SMTP_PASSWORD", self.smtp_password),
                    ("SENDSTACK_SMTP_FROM_EMAIL", self.smtp_from_email),
                    ("SENDSTACK_TEST_RECIPIENT_ALLOWLIST", self.recipient_allowlist),
                )
                if not value
            ]
            if missing:
                raise ValueError(f"SMTP test mode requires: {', '.join(missing)}")
            if not self.smtp_starttls:
                raise ValueError("SMTP test mode requires SENDSTACK_SMTP_STARTTLS=true")
            if not valid_email(self.smtp_from_email):
                raise ValueError("SENDSTACK_SMTP_FROM_EMAIL must be a valid address")
        if self.per_second_limit <= 0 or self.daily_limit <= 0 or self.external_campaign_cap <= 0:
            raise ValueError("Delivery limits must be greater than zero")


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'marketer', 'analyst')),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suppressed')),
    consent_source TEXT NOT NULL DEFAULT 'manual',
    consent_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS list_contacts (
    list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE IF NOT EXISTS suppressions (
    email TEXT PRIMARY KEY,
    reason TEXT NOT NULL CHECK (reason IN ('unsubscribe', 'hard_bounce', 'complaint', 'manual')),
    source TEXT NOT NULL DEFAULT 'application',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    from_name TEXT NOT NULL,
    from_email TEXT NOT NULL,
    content_mode TEXT NOT NULL DEFAULT 'custom_html' CHECK (
        content_mode IN ('visual', 'rich_text', 'custom_html', 'plain_text')
    ),
    content_json TEXT NOT NULL DEFAULT '{"schema_version":1}',
    html_body TEXT NOT NULL,
    text_body TEXT NOT NULL DEFAULT '',
    list_id TEXT NOT NULL REFERENCES lists(id),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'paused', 'completed')),
    created_by TEXT NOT NULL REFERENCES users(id),
    launched_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_recipients (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL REFERENCES contacts(id),
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (
        status IN ('queued', 'processing', 'sent', 'suppressed', 'failed', 'bounced', 'complained')
    ),
    attempts INTEGER NOT NULL DEFAULT 0,
    message_id TEXT NOT NULL,
    error TEXT,
    queued_at TEXT NOT NULL,
    sent_at TEXT,
    UNIQUE (campaign_id, contact_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    recipient_id TEXT REFERENCES campaign_recipients(id) ON DELETE SET NULL,
    contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    from_email TEXT NOT NULL,
    html_body TEXT NOT NULL,
    text_body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    provider_id TEXT,
    error TEXT,
    unsubscribe_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_users_active_role ON users(active, role);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_work ON campaign_recipients(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_action_created ON audit_events(actor_user_id, action, created_at DESC);
"""


class Database:
    def __init__(self, path: str):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._write_lock = threading.RLock()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=20, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 20000")
        try:
            yield connection
        finally:
            connection.close()

    def initialize(self, config: Config) -> None:
        with self._write_lock, self.connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(SCHEMA)
            self._migrate_schema(connection)
            now = utc_now()
            admin_email = normalize_email(config.admin_email)
            admin = connection.execute(
                "SELECT id FROM users WHERE email = ?", (admin_email,)
            ).fetchone()
            if not admin:
                connection.execute(
                    "INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        make_id("usr"),
                        admin_email,
                        "Test Administrator",
                        "admin",
                        hash_password(config.admin_password),
                        now,
                        now,
                    ),
                )

            default_list = connection.execute(
                "SELECT id FROM lists WHERE name = ?", ("Product updates",)
            ).fetchone()
            if not default_list:
                list_id = make_id("lst")
                connection.execute(
                    "INSERT INTO lists (id, name, description, created_at) VALUES (?, ?, ?, ?)",
                    (list_id, "Product updates", "Safe sample audience for the test environment.", now),
                )
                for index, values in enumerate(
                    [
                        ("alex@example.test", "Alex", "Morgan"),
                        ("jamie@example.test", "Jamie", "Chen"),
                        ("sam@example.test", "Sam", "Patel"),
                    ]
                ):
                    contact_id = make_id("con")
                    connection.execute(
                        """
                        INSERT OR IGNORE INTO contacts
                            (id, email, first_name, last_name, consent_source, consent_at, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (contact_id, values[0], values[1], values[2], "sample_data", now, now, now),
                    )
                    contact = connection.execute(
                        "SELECT id FROM contacts WHERE email = ?", (values[0],)
                    ).fetchone()
                    connection.execute(
                        "INSERT OR IGNORE INTO list_contacts (list_id, contact_id, added_at) VALUES (?, ?, ?)",
                        (list_id, contact["id"], now),
                    )
            connection.execute("PRAGMA optimize")

    @staticmethod
    def _migrate_schema(connection: sqlite3.Connection) -> None:
        """Apply small, restart-safe migrations for existing local test databases."""
        user_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(users)").fetchall()
        }
        if "updated_at" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN updated_at TEXT")
            connection.execute("UPDATE users SET updated_at = created_at WHERE updated_at IS NULL")
        campaign_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(campaigns)").fetchall()
        }
        if "content_mode" not in campaign_columns:
            connection.execute(
                "ALTER TABLE campaigns ADD COLUMN content_mode TEXT NOT NULL DEFAULT 'custom_html'"
            )
        if "content_json" not in campaign_columns:
            connection.execute(
                "ALTER TABLE campaigns ADD COLUMN content_json TEXT NOT NULL DEFAULT '{\"schema_version\":1}'"
            )

    def audit(
        self,
        action: str,
        entity_type: str,
        entity_id: str | None,
        actor_user_id: str | None,
        detail: dict[str, Any] | None = None,
    ) -> None:
        with self._write_lock, self.connect() as connection:
            connection.execute(
                """
                INSERT INTO audit_events
                    (actor_user_id, action, entity_type, entity_id, detail_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (actor_user_id, action, entity_type, entity_id, json.dumps(detail or {}), utc_now()),
            )


class DeliveryAdapter:
    def __init__(self, config: Config):
        self.config = config
        self.allowlist = {
            normalize_email(item)
            for item in config.recipient_allowlist.split(",")
            if item.strip()
        }
        if config.delivery_mode == "smtp" and any(not valid_email(item) for item in self.allowlist):
            raise ValueError("SMTP test allowlist entries must be exact email addresses")

    def recipient_is_allowed(self, recipient: str) -> bool:
        recipient = normalize_email(recipient)
        if self.config.delivery_mode == "sandbox":
            return True
        return recipient in self.allowlist

    def send(
        self,
        *,
        to_email: str,
        subject: str,
        from_name: str,
        from_email: str,
        html_body: str,
        text_body: str,
        message_id: str,
        unsubscribe_url: str,
    ) -> str:
        if not valid_email(to_email) or not valid_email(from_email):
            raise RuntimeError("Sender and recipient must be valid email addresses")
        if any("\r" in value or "\n" in value for value in (to_email, from_email, from_name, subject)):
            raise RuntimeError("Email headers cannot contain line breaks")
        if not self.recipient_is_allowed(to_email):
            raise RuntimeError(
                "Recipient is blocked by the test allowlist. Add it to "
                "SENDSTACK_TEST_RECIPIENT_ALLOWLIST before using SMTP mode."
            )
        if self.config.delivery_mode == "sandbox":
            return f"sandbox:{message_id}"

        message = EmailMessage()
        message["To"] = to_email
        if normalize_email(from_email) != normalize_email(self.config.smtp_from_email):
            raise RuntimeError("Campaign sender must match SENDSTACK_SMTP_FROM_EMAIL in SMTP test mode")
        message["From"] = f"{from_name} <{from_email}>"
        message["Subject"] = subject
        message["Message-ID"] = f"<{message_id}@sendstack.local>"
        message["List-Unsubscribe"] = f"<{unsubscribe_url}>"
        message["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
        message.set_content(text_body or "This message contains an HTML version.")
        message.add_alternative(html_body, subtype="html")

        context = ssl.create_default_context()
        with smtplib.SMTP(
            self.config.smtp_host, self.config.smtp_port, timeout=20
        ) as smtp:
            smtp.ehlo()
            if self.config.smtp_starttls:
                smtp.starttls(context=context)
                smtp.ehlo()
            if self.config.smtp_username:
                smtp.login(self.config.smtp_username, self.config.smtp_password)
            smtp.send_message(message)
        return f"smtp:{message_id}"


class QueueWorker:
    def __init__(self, app: "Application"):
        self.app = app
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self._last_delivery = 0.0

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self.run, name="sendstack-worker", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=3)

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                worked = self.process_one()
                if not worked:
                    self.stop_event.wait(0.25)
            except Exception as exc:  # worker must remain visible and alive in test mode
                print(f"worker error: {exc}", flush=True)
                self.stop_event.wait(0.5)

    def process_one(self) -> bool:
        db = self.app.db
        now = utc_now()
        with db._write_lock, db.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT cr.*, c.first_name, c.last_name, c.status AS contact_status,
                       ca.subject, ca.from_name, ca.from_email, ca.html_body, ca.text_body,
                       ca.status AS campaign_status
                FROM campaign_recipients cr
                JOIN contacts c ON c.id = cr.contact_id
                JOIN campaigns ca ON ca.id = cr.campaign_id
                WHERE cr.status = 'queued' AND ca.status = 'sending'
                ORDER BY cr.queued_at ASC
                LIMIT 1
                """
            ).fetchone()
            if not row:
                connection.execute("COMMIT")
                self._complete_finished_campaigns(connection)
                return False
            changed = connection.execute(
                "UPDATE campaign_recipients SET status = 'processing', attempts = attempts + 1 WHERE id = ? AND status = 'queued'",
                (row["id"],),
            ).rowcount
            connection.execute("COMMIT")
            if changed != 1:
                return True

        with db.connect() as connection:
            suppression = connection.execute(
                "SELECT reason FROM suppressions WHERE email = ?", (row["email"],)
            ).fetchone()
        if row["contact_status"] != "active" or suppression:
            with db._write_lock, db.connect() as connection:
                connection.execute(
                    "UPDATE campaign_recipients SET status = 'suppressed', error = ? WHERE id = ?",
                    (
                        f"Suppressed: {suppression['reason']}" if suppression else "Contact is inactive",
                        row["id"],
                    ),
                )
            return True

        if not self._within_daily_limit():
            time.sleep(0.5)
            with db._write_lock, db.connect() as connection:
                connection.execute(
                    "UPDATE campaign_recipients SET status = 'queued', error = 'Daily delivery limit reached' WHERE id = ?",
                    (row["id"],),
                )
            return False

        interval = 1.0 / self.app.config.per_second_limit
        delay = interval - (time.monotonic() - self._last_delivery)
        if delay > 0:
            self.stop_event.wait(delay)

        unsubscribe_token = secrets.token_urlsafe(32)
        unsubscribe_url = f"{self.app.config.public_url}/u/{quote(unsubscribe_token)}"
        values = {
            "first_name": row["first_name"],
            "last_name": row["last_name"],
            "email": row["email"],
            "unsubscribe_url": unsubscribe_url,
        }
        subject = render_template(row["subject"], values)
        validate_email_content(row["html_body"], row["text_body"])
        html_values = {key: html.escape(value, quote=True) for key, value in values.items()}
        html_body = render_template(row["html_body"], html_values)
        text_body = render_template(row["text_body"], values)
        message_record_id = make_id("msg")

        try:
            provider_id = self.app.delivery.send(
                to_email=row["email"],
                subject=subject,
                from_name=row["from_name"],
                from_email=row["from_email"],
                html_body=html_body,
                text_body=text_body,
                message_id=row["message_id"],
                unsubscribe_url=unsubscribe_url,
            )
            delivered_at = utc_now()
            status = "sandboxed" if self.app.config.delivery_mode == "sandbox" else "submitted"
            with db._write_lock, db.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    """
                    INSERT INTO messages
                        (id, campaign_id, recipient_id, contact_id, to_email, subject, from_email,
                         html_body, text_body, status, provider_id, unsubscribe_token, created_at, delivered_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        message_record_id,
                        row["campaign_id"],
                        row["id"],
                        row["contact_id"],
                        row["email"],
                        subject,
                        row["from_email"],
                        html_body,
                        text_body,
                        status,
                        provider_id,
                        unsubscribe_token,
                        now,
                        delivered_at,
                    ),
                )
                connection.execute(
                    "UPDATE campaign_recipients SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?",
                    (delivered_at, row["id"]),
                )
                connection.execute("COMMIT")
            self._last_delivery = time.monotonic()
        except Exception as exc:
            error = str(exc)[:500]
            # Automatic SMTP retries are intentionally disabled in the test build:
            # a connection can fail after a relay has accepted DATA, making the
            # outcome ambiguous and an automatic retry potentially duplicative.
            terminal = self.app.config.delivery_mode == "smtp" or row["attempts"] + 1 >= 3
            with db._write_lock, db.connect() as connection:
                connection.execute(
                    "UPDATE campaign_recipients SET status = ?, error = ? WHERE id = ?",
                    ("failed" if terminal else "queued", error, row["id"]),
                )
                connection.execute(
                    """
                    INSERT INTO messages
                        (id, campaign_id, recipient_id, contact_id, to_email, subject, from_email,
                         html_body, text_body, status, error, unsubscribe_token, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?)
                    """,
                    (
                        message_record_id,
                        row["campaign_id"],
                        row["id"],
                        row["contact_id"],
                        row["email"],
                        subject,
                        row["from_email"],
                        html_body,
                        text_body,
                        error,
                        unsubscribe_token,
                        now,
                    ),
                )
        return True

    def _within_daily_limit(self) -> bool:
        start = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00+00:00")
        with self.app.db.connect() as connection:
            count = connection.execute(
                "SELECT COUNT(*) FROM messages WHERE delivered_at IS NOT NULL AND delivered_at >= ?",
                (start,),
            ).fetchone()[0]
        return count < self.app.config.daily_limit

    def _complete_finished_campaigns(self, connection: sqlite3.Connection) -> None:
        now = utc_now()
        connection.execute(
            """
            UPDATE campaigns
            SET status = 'completed', completed_at = ?, updated_at = ?
            WHERE status = 'sending'
              AND EXISTS (SELECT 1 FROM campaign_recipients cr WHERE cr.campaign_id = campaigns.id)
              AND NOT EXISTS (
                  SELECT 1 FROM campaign_recipients cr
                  WHERE cr.campaign_id = campaigns.id AND cr.status IN ('queued', 'processing')
              )
            """,
            (now, now),
        )


def render_template(template: str, values: dict[str, str]) -> str:
    result = template
    for key, value in values.items():
        result = result.replace("{{" + key + "}}", value)
    return result


ALLOWED_MERGE_FIELDS = {"first_name", "last_name", "email", "unsubscribe_url"}
UNSAFE_EMAIL_HTML = (
    re.compile(r"<\s*(script|iframe|object|embed|form|input|button|svg|math)\b", re.IGNORECASE),
    re.compile(r"\bon[a-z]+\s*=", re.IGNORECASE),
    re.compile(r"(?:javascript|vbscript|file|data)\s*:", re.IGNORECASE),
    re.compile(r"<\s*meta\b[^>]*http-equiv\s*=\s*['\"]?refresh", re.IGNORECASE),
    re.compile(r"@import\b", re.IGNORECASE),
)


def validate_email_content(html_body: str, text_body: str) -> None:
    """Reject active content while preserving ordinary email-compatible markup."""
    if any(pattern.search(html_body) for pattern in UNSAFE_EMAIL_HTML):
        raise ValueError("Message HTML contains active or unsafe content")
    merge_fields = set(re.findall(r"{{\s*([a-zA-Z0-9_]+)\s*}}", html_body + "\n" + text_body))
    unknown = sorted(merge_fields - ALLOWED_MERGE_FIELDS)
    if unknown:
        raise ValueError(f"Unknown personalization field: {unknown[0]}")
    if "{{unsubscribe_url}}" not in html_body:
        raise ValueError("Every message must include a visible unsubscribe link")
    if "{{unsubscribe_url}}" not in text_body:
        raise ValueError("The plain-text version must include the unsubscribe link")


class Application:
    def __init__(self, config: Config):
        config.validate()
        self.config = config
        self.db = Database(config.db_path)
        self.db.initialize(config)
        self.delivery = DeliveryAdapter(config)
        self.worker = QueueWorker(self)
        self.login_attempts: dict[str, list[float]] = {}
        self.login_lock = threading.Lock()

    def make_server(self) -> ThreadingHTTPServer:
        app = self

        class BoundHandler(RequestHandler):
            application = app

        server = ThreadingHTTPServer((self.config.host, self.config.port), BoundHandler)
        server.daemon_threads = True
        return server


class RequestHandler(BaseHTTPRequestHandler):
    application: Application
    server_version = "SendStackTest/0.1"
    protocol_version = "HTTP/1.1"

    def log_message(self, format_text: str, *args: Any) -> None:
        if os.getenv("SENDSTACK_QUIET", "0") != "1":
            super().log_message(format_text, *args)

    @property
    def db(self) -> Database:
        return self.application.db

    def do_GET(self) -> None:  # noqa: N802
        try:
            self._dispatch("GET")
        except BrokenPipeError:
            return
        except Exception as exc:
            self._handle_unexpected(exc)

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._dispatch("POST")
        except BrokenPipeError:
            return
        except Exception as exc:
            self._handle_unexpected(exc)

    def do_PATCH(self) -> None:  # noqa: N802
        try:
            self._dispatch("PATCH")
        except BrokenPipeError:
            return
        except Exception as exc:
            self._handle_unexpected(exc)

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if method == "GET" and path in {"/", "/index.html"}:
            return self._serve_file(STATIC_ROOT / "index.html", "text/html; charset=utf-8")
        if method == "GET" and path == "/app.js":
            return self._serve_file(STATIC_ROOT / "app.js", "text/javascript; charset=utf-8")
        if method == "GET" and path == "/styles.css":
            return self._serve_file(STATIC_ROOT / "styles.css", "text/css; charset=utf-8")
        if method == "GET" and path == "/favicon.svg":
            return self._serve_file(STATIC_ROOT / "favicon.svg", "image/svg+xml")
        if method == "GET" and path == "/healthz":
            return self._json(HTTPStatus.OK, {"status": "ok", "mode": self.application.config.delivery_mode})

        unsubscribe_match = re.fullmatch(r"/u/([A-Za-z0-9_-]+)", path)
        if unsubscribe_match:
            if method == "GET":
                return self._unsubscribe_page(unsubscribe_match.group(1))
            if method == "POST":
                return self._unsubscribe(unsubscribe_match.group(1))

        if path == "/api/auth/login" and method == "POST":
            return self._login()

        session = self._session()
        if not session:
            return self._json(HTTPStatus.UNAUTHORIZED, {"error": "Authentication required"})

        if method in {"POST", "PATCH"}:
            csrf = self.headers.get("X-CSRF-Token", "")
            if not csrf or not hmac.compare_digest(csrf, session["csrf_token"]):
                return self._json(HTTPStatus.FORBIDDEN, {"error": "Invalid CSRF token"})

        permission = required_permission(method, path)
        if (
            permission is None
            and path.startswith("/api/")
            and path not in {"/api/session", "/api/auth/logout"}
        ):
            return self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
        if permission and permission not in permissions_for_role(session["role"]):
            return self._json(
                HTTPStatus.FORBIDDEN,
                {
                    "error": "You do not have permission to perform this action",
                    "code": "permission_denied",
                    "permission": permission,
                },
            )

        if path == "/api/session" and method == "GET":
            return self._json(
                HTTPStatus.OK,
                {
                    "user": {
                        "id": session["user_id"],
                        "email": session["email"],
                        "name": session["name"],
                        "role": session["role"],
                        "role_label": ROLE_DEFINITIONS[session["role"]]["label"],
                    },
                    "permissions": sorted(permissions_for_role(session["role"])),
                    "csrf_token": session["csrf_token"],
                    "delivery_mode": self.application.config.delivery_mode,
                    "daily_limit": self.application.config.daily_limit,
                    "production_target": dict(PRODUCTION_TARGET),
                    "production_status": "migration_required",
                },
            )
        if path == "/api/auth/logout" and method == "POST":
            return self._logout(session)
        if path == "/api/summary" and method == "GET":
            return self._summary(session)
        if path == "/api/production-readiness" and method == "GET":
            return self._json(
                HTTPStatus.OK, production_readiness(self.application.config)
            )
        if path == "/api/lists" and method == "GET":
            return self._lists()
        if path == "/api/lists" and method == "POST":
            return self._create_list(session)
        if path == "/api/contacts" and method == "GET":
            return self._contacts(query)
        if path == "/api/contacts" and method == "POST":
            return self._create_contact(session)
        if path == "/api/contacts/import" and method == "POST":
            return self._import_contacts(session)
        if path == "/api/suppressions" and method == "GET":
            return self._suppressions()
        if path == "/api/suppressions" and method == "POST":
            return self._create_suppression(session)
        if path == "/api/campaigns" and method == "GET":
            return self._campaigns()
        if path == "/api/campaigns" and method == "POST":
            return self._create_campaign(session)
        if path == "/api/messages" and method == "GET":
            return self._messages(query)
        if path == "/api/audit" and method == "GET":
            return self._audit()
        if path == "/api/users" and method == "GET":
            return self._users(session)
        if path == "/api/users" and method == "POST":
            return self._create_user(session)

        reset_password_match = re.fullmatch(r"/api/users/([^/]+)/reset-password", path)
        if reset_password_match and method == "POST":
            return self._reset_user_password(reset_password_match.group(1), session)

        user_match = re.fullmatch(r"/api/users/([^/]+)", path)
        if user_match and method == "PATCH":
            return self._update_user(user_match.group(1), session)

        campaign_match = re.fullmatch(r"/api/campaigns/([^/]+)", path)
        if campaign_match:
            if method == "GET":
                return self._campaign(campaign_match.group(1))
            if method == "PATCH":
                return self._update_campaign(campaign_match.group(1), session)

        action_match = re.fullmatch(r"/api/campaigns/([^/]+)/(launch|pause|resume|test-send)", path)
        if action_match and method == "POST":
            campaign_id, action = action_match.groups()
            if action == "launch":
                return self._launch_campaign(campaign_id, session)
            if action == "pause":
                return self._campaign_state(campaign_id, "paused", session)
            if action == "resume":
                return self._campaign_state(campaign_id, "sending", session)
            return self._test_send(campaign_id, session)

        message_match = re.fullmatch(r"/api/messages/([^/]+)", path)
        if message_match and method == "GET":
            return self._message(message_match.group(1))

        event_match = re.fullmatch(r"/api/messages/([^/]+)/event", path)
        if event_match and method == "POST":
            return self._message_event(event_match.group(1), session)

        self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})

    def _handle_unexpected(self, exc: Exception) -> None:
        print(f"request error: {exc}", flush=True)
        try:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Unexpected server error"})
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _serve_file(self, path: Path, content_type: str) -> None:
        if not path.exists():
            return self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(data)

    def _json(self, status: int | HTTPStatus, payload: Any, *, cookie: str | None = None) -> None:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.close_connection = True
        self.wfile.write(data)

    def _html(self, status: int | HTTPStatus, markup: str) -> None:
        data = markup.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(data)

    def _body_json(self, max_bytes: int = 6_000_000) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid content length") from exc
        if length <= 0 or length > max_bytes:
            raise ValueError("Request body is empty or too large")
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("Invalid JSON") from exc
        if not isinstance(value, dict):
            raise ValueError("JSON object required")
        return value

    def _session(self) -> sqlite3.Row | None:
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get("sendstack_session")
        if not morsel:
            return None
        token_hash = hashlib.sha256(morsel.value.encode()).hexdigest()
        with self.db.connect() as connection:
            session = connection.execute(
                """
                SELECT s.token_hash, s.csrf_token, s.expires_at,
                       u.id AS user_id, u.email, u.name, u.role
                FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
                """,
                (token_hash, utc_now()),
            ).fetchone()
        return session

    def _login(self) -> None:
        client = self.client_address[0]
        now_time = time.time()
        with self.application.login_lock:
            attempts = [item for item in self.application.login_attempts.get(client, []) if now_time - item < 300]
            if len(attempts) >= 10:
                return self._json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "Too many login attempts. Try again shortly."})
        try:
            body = self._body_json(20_000)
        except ValueError as exc:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        email_address = normalize_email(str(body.get("email", "")))
        password = str(body.get("password", ""))
        with self.db.connect() as connection:
            user = connection.execute(
                "SELECT * FROM users WHERE email = ? AND active = 1", (email_address,)
            ).fetchone()
        if not user or not verify_password(password, user["password_hash"]):
            with self.application.login_lock:
                self.application.login_attempts.setdefault(client, []).append(now_time)
            time.sleep(0.12)
            return self._json(HTTPStatus.UNAUTHORIZED, {"error": "Incorrect email or password"})

        token = secrets.token_urlsafe(36)
        csrf = secrets.token_urlsafe(24)
        created = utc_now()
        expires = (datetime.now(timezone.utc) + timedelta(hours=self.application.config.session_hours)).replace(microsecond=0).isoformat()
        with self.db._write_lock, self.db.connect() as connection:
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (created,))
            connection.execute(
                "INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
                (hashlib.sha256(token.encode()).hexdigest(), user["id"], csrf, expires, created),
            )
        self.db.audit("login", "session", None, user["id"])
        cookie = f"sendstack_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={self.application.config.session_hours * 3600}"
        if self.application.config.cookie_secure:
            cookie += "; Secure"
        self._json(
            HTTPStatus.OK,
            {
                "user": {
                    "id": user["id"],
                    "email": user["email"],
                    "name": user["name"],
                    "role": user["role"],
                    "role_label": ROLE_DEFINITIONS[user["role"]]["label"],
                },
                "permissions": sorted(permissions_for_role(user["role"])),
                "csrf_token": csrf,
                "delivery_mode": self.application.config.delivery_mode,
                "daily_limit": self.application.config.daily_limit,
                "production_target": dict(PRODUCTION_TARGET),
                "production_status": "migration_required",
            },
            cookie=cookie,
        )

    def _logout(self, session: sqlite3.Row) -> None:
        with self.db._write_lock, self.db.connect() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (session["token_hash"],))
        self.db.audit("logout", "session", None, session["user_id"])
        self._json(
            HTTPStatus.OK,
            {"ok": True},
            cookie="sendstack_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        )

    def _summary(self, session: sqlite3.Row) -> None:
        with self.db.connect() as connection:
            counts = {
                "contacts": connection.execute("SELECT COUNT(*) FROM contacts WHERE status = 'active'").fetchone()[0],
                "suppressed": connection.execute("SELECT COUNT(*) FROM suppressions").fetchone()[0],
                "campaigns": connection.execute("SELECT COUNT(*) FROM campaigns").fetchone()[0],
                "queued": connection.execute("SELECT COUNT(*) FROM campaign_recipients WHERE status IN ('queued', 'processing')").fetchone()[0],
                "sent_today": connection.execute(
                    "SELECT COUNT(*) FROM messages WHERE delivered_at >= ?",
                    (datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00+00:00"),),
                ).fetchone()[0],
            }
            recent_campaigns = rows_to_dicts(
                connection.execute(
                    """
                    SELECT ca.id, ca.name, ca.subject, ca.status, ca.created_at,
                           COUNT(cr.id) AS recipients,
                           SUM(CASE WHEN cr.status = 'sent' THEN 1 ELSE 0 END) AS sent,
                           SUM(CASE WHEN cr.status IN ('bounced', 'complained', 'failed') THEN 1 ELSE 0 END) AS issues
                    FROM campaigns ca LEFT JOIN campaign_recipients cr ON cr.campaign_id = ca.id
                    GROUP BY ca.id ORDER BY ca.created_at DESC LIMIT 5
                    """
                ).fetchall()
            )
            recent_messages = []
            if "deliveries.view" in permissions_for_role(session["role"]):
                recent_messages = rows_to_dicts(
                    connection.execute(
                        "SELECT id, to_email, subject, status, created_at FROM messages ORDER BY created_at DESC LIMIT 5"
                    ).fetchall()
                )
        self._json(
            HTTPStatus.OK,
            {
                "counts": counts,
                "daily_limit": self.application.config.daily_limit,
                "delivery_mode": self.application.config.delivery_mode,
                "delivery_records_visible": "deliveries.view"
                in permissions_for_role(session["role"]),
                "production_target": dict(PRODUCTION_TARGET),
                "production_status": "migration_required",
                "recent_campaigns": recent_campaigns,
                "recent_messages": recent_messages,
            },
        )

    def _lists(self) -> None:
        with self.db.connect() as connection:
            rows = connection.execute(
                """
                SELECT l.id, l.name, l.description, l.created_at,
                       COUNT(lc.contact_id) AS contact_count
                FROM lists l LEFT JOIN list_contacts lc ON lc.list_id = l.id
                GROUP BY l.id ORDER BY l.name
                """
            ).fetchall()
        self._json(HTTPStatus.OK, {"lists": rows_to_dicts(rows)})

    def _create_list(self, session: sqlite3.Row) -> None:
        try:
            body = self._body_json()
            name = str(body.get("name", "")).strip()
            if not name or len(name) > 120:
                raise ValueError("List name is required and must be under 120 characters")
            list_id = make_id("lst")
            with self.db._write_lock, self.db.connect() as connection:
                connection.execute(
                    "INSERT INTO lists (id, name, description, created_at) VALUES (?, ?, ?, ?)",
                    (list_id, name, str(body.get("description", ""))[:500], utc_now()),
                )
        except sqlite3.IntegrityError:
            return self._json(HTTPStatus.CONFLICT, {"error": "A list with that name already exists"})
        except ValueError as exc:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        self.db.audit("create", "list", list_id, session["user_id"], {"name": name})
        self._json(HTTPStatus.CREATED, {"id": list_id})

    def _contacts(self, query: dict[str, list[str]]) -> None:
        search = (query.get("q", [""])[0]).strip().lower()
        list_id = (query.get("list_id", [""])[0]).strip()
        sql = """
            SELECT c.id, c.email, c.first_name, c.last_name, c.status,
                   c.consent_source, c.consent_at, c.created_at,
                   GROUP_CONCAT(l.name, ', ') AS lists
            FROM contacts c
            LEFT JOIN list_contacts lc ON lc.contact_id = c.id
            LEFT JOIN lists l ON l.id = lc.list_id
        """
        clauses: list[str] = []
        params: list[Any] = []
        if search:
            clauses.append("(LOWER(c.email) LIKE ? OR LOWER(c.first_name) LIKE ? OR LOWER(c.last_name) LIKE ?)")
            pattern = f"%{search}%"
            params.extend([pattern, pattern, pattern])
        if list_id:
            clauses.append("EXISTS (SELECT 1 FROM list_contacts x WHERE x.contact_id = c.id AND x.list_id = ?)")
            params.append(list_id)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " GROUP BY c.id ORDER BY c.created_at DESC LIMIT 1000"
        with self.db.connect() as connection:
            rows = connection.execute(sql, params).fetchall()
        self._json(HTTPStatus.OK, {"contacts": rows_to_dicts(rows)})

    def _create_contact(self, session: sqlite3.Row) -> None:
        try:
            body = self._body_json()
            email_address = normalize_email(str(body.get("email", "")))
            if not valid_email(email_address):
                raise ValueError("A valid email address is required")
            list_id = str(body.get("list_id", "")).strip()
            if not list_id:
                raise ValueError("Choose a list")
            contact_id = make_id("con")
            now = utc_now()
            with self.db._write_lock, self.db.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    """
                    INSERT INTO contacts
                        (id, email, first_name, last_name, consent_source, consent_at, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        contact_id,
                        email_address,
                        str(body.get("first_name", ""))[:120].strip(),
                        str(body.get("last_name", ""))[:120].strip(),
                        str(body.get("consent_source", "manual"))[:120],
                        now,
                        now,
                        now,
                    ),
                )
                connection.execute(
                    "INSERT INTO list_contacts (list_id, contact_id, added_at) VALUES (?, ?, ?)",
                    (list_id, contact_id, now),
                )
                connection.execute("COMMIT")
        except sqlite3.IntegrityError as exc:
            message = "That email is already in the contact database" if "contacts.email" in str(exc) else "The selected list does not exist"
            return self._json(HTTPStatus.CONFLICT, {"error": message})
        except ValueError as exc:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        self.db.audit("create", "contact", contact_id, session["user_id"], {"email": email_address})
        self._json(HTTPStatus.CREATED, {"id": contact_id})

    def _import_contacts(self, session: sqlite3.Row) -> None:
        try:
            body = self._body_json()
            csv_text = str(body.get("csv_text", ""))
            list_id = str(body.get("list_id", "")).strip()
            if not csv_text or len(csv_text.encode("utf-8")) > 5_000_000:
                raise ValueError("Choose a CSV file smaller than 5 MB")
            if not list_id:
                raise ValueError("Choose a destination list")
            reader = csv.DictReader(io.StringIO(csv_text.lstrip("\ufeff")))
            if not reader.fieldnames:
                raise ValueError("The CSV needs a header row")
            normalized_fields = {field.strip().lower(): field for field in reader.fieldnames if field}
            email_field = next((normalized_fields[key] for key in ("email", "email_address", "email address") if key in normalized_fields), None)
            if not email_field:
                raise ValueError("The CSV must contain an email column")
            first_field = next((normalized_fields[key] for key in ("first_name", "first name", "firstname") if key in normalized_fields), None)
            last_field = next((normalized_fields[key] for key in ("last_name", "last name", "lastname") if key in normalized_fields), None)
            now = utc_now()
            imported = 0
            updated = 0
            duplicates = 0
            invalid = 0
            errors: list[dict[str, Any]] = []
            seen: set[str] = set()
            with self.db._write_lock, self.db.connect() as connection:
                if not connection.execute("SELECT 1 FROM lists WHERE id = ?", (list_id,)).fetchone():
                    raise ValueError("The selected list does not exist")
                connection.execute("BEGIN IMMEDIATE")
                for row_number, row in enumerate(reader, start=2):
                    email_address = normalize_email(str(row.get(email_field, "")))
                    if not valid_email(email_address):
                        invalid += 1
                        if len(errors) < 20:
                            errors.append({"row": row_number, "email": email_address, "reason": "Invalid email"})
                        continue
                    if email_address in seen:
                        duplicates += 1
                        continue
                    seen.add(email_address)
                    existing = connection.execute("SELECT id FROM contacts WHERE email = ?", (email_address,)).fetchone()
                    if existing:
                        contact_id = existing["id"]
                        connection.execute(
                            """
                            UPDATE contacts SET first_name = COALESCE(NULLIF(?, ''), first_name),
                                                last_name = COALESCE(NULLIF(?, ''), last_name), updated_at = ?
                            WHERE id = ?
                            """,
                            (
                                str(row.get(first_field, ""))[:120].strip() if first_field else "",
                                str(row.get(last_field, ""))[:120].strip() if last_field else "",
                                now,
                                contact_id,
                            ),
                        )
                        updated += 1
                    else:
                        contact_id = make_id("con")
                        connection.execute(
                            """
                            INSERT INTO contacts
                                (id, email, first_name, last_name, consent_source, consent_at, created_at, updated_at)
                            VALUES (?, ?, ?, ?, 'csv_import', ?, ?, ?)
                            """,
                            (
                                contact_id,
                                email_address,
                                str(row.get(first_field, ""))[:120].strip() if first_field else "",
                                str(row.get(last_field, ""))[:120].strip() if last_field else "",
                                now,
                                now,
                                now,
                            ),
                        )
                        imported += 1
                    connection.execute(
                        "INSERT OR IGNORE INTO list_contacts (list_id, contact_id, added_at) VALUES (?, ?, ?)",
                        (list_id, contact_id, now),
                    )
                connection.execute("COMMIT")
        except ValueError as exc:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        self.db.audit(
            "import",
            "contacts",
            list_id,
            session["user_id"],
            {"imported": imported, "updated": updated, "duplicates": duplicates, "invalid": invalid},
        )
        self._json(
            HTTPStatus.OK,
            {"imported": imported, "updated": updated, "duplicates": duplicates, "invalid": invalid, "errors": errors},
        )

    def _suppressions(self) -> None:
        with self.db.connect() as connection:
            rows = connection.execute(
                "SELECT email, reason, source, created_at FROM suppressions ORDER BY created_at DESC LIMIT 1000"
            ).fetchall()
        self._json(HTTPStatus.OK, {"suppressions": rows_to_dicts(rows)})

    def _create_suppression(self, session: sqlite3.Row) -> None:
        try:
            body = self._body_json()
            email_address = normalize_email(str(body.get("email", "")))
            reason = str(body.get("reason", "manual"))
            if not valid_email(email_address):
                raise ValueError("A valid email address is required")
            if reason != "manual":
                raise ValueError(
                    "Manual suppressions must use the manual reason; delivery feedback is recorded separately"
                )
            self._apply_suppression(email_address, reason, "manual")
        except ValueError as exc:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        self.db.audit("suppress", "contact", email_address, session["user_id"], {"reason": reason})
        self._json(HTTPStatus.CREATED, {"ok": True})

    def _apply_suppression(self, email_address: str, reason: str, source: str) -> None:
        now = utc_now()
        with self.db._write_lock, self.db.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                INSERT INTO suppressions (email, reason, source, created_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET reason = excluded.reason, source = excluded.source, created_at = excluded.created_at
                """,
                (email_address, reason, source, now),
            )
            connection.execute("UPDATE contacts SET status = 'suppressed', updated_at = ? WHERE email = ?", (now, email_address))
            connection.execute(
                "UPDATE campaign_recipients SET status = 'suppressed', error = ? WHERE email = ? AND status = 'queued'",
                (f"Suppressed: {reason}", email_address),
            )
            connection.execute("COMMIT")

    def _campaigns(self) -> None:
        with self.db.connect() as connection:
            rows = connection.execute(
                """
                SELECT ca.id, ca.name, ca.subject, ca.from_name, ca.from_email, ca.list_id,
                       ca.content_mode, ca.status, ca.launched_at, ca.completed_at, ca.created_at, ca.updated_at,
                       l.name AS list_name,
                       COUNT(cr.id) AS recipients,
                       SUM(CASE WHEN cr.status = 'sent' THEN 1 ELSE 0 END) AS sent,
                       SUM(CASE WHEN cr.status = 'queued' OR cr.status = 'processing' THEN 1 ELSE 0 END) AS queued,
                       SUM(CASE WHEN cr.status = 'suppressed' THEN 1 ELSE 0 END) AS suppressed,
                       SUM(CASE WHEN cr.status = 'failed' THEN 1 ELSE 0 END) AS failed,
                       SUM(CASE WHEN cr.status = 'bounced' THEN 1 ELSE 0 END) AS bounced,
                       SUM(CASE WHEN cr.status = 'complained' THEN 1 ELSE 0 END) AS complained
                FROM campaigns ca JOIN lists l ON l.id = ca.list_id
                LEFT JOIN campaign_recipients cr ON cr.campaign_id = ca.id
                GROUP BY ca.id ORDER BY ca.created_at DESC
                """
            ).fetchall()
        self._json(HTTPStatus.OK, {"campaigns": rows_to_dicts(rows)})

    def _validate_campaign_body(self, body: dict[str, Any]) -> dict[str, str]:
        content_mode = str(body.get("content_mode", "custom_html")).strip()
        if content_mode not in {"visual", "rich_text", "custom_html", "plain_text"}:
            raise ValueError("Choose a supported message format")
        content_data = body.get("content_json", {"schema_version": 1})
        if isinstance(content_data, str):
            try:
                content_data = json.loads(content_data)
            except json.JSONDecodeError as exc:
                raise ValueError("Message editor data is not valid JSON") from exc
        if not isinstance(content_data, dict):
            raise ValueError("Message editor data must be an object")
        if content_data.get("schema_version", 1) != 1:
            raise ValueError("This message editor version is not supported")
        content_json = json.dumps(content_data, separators=(",", ":"), ensure_ascii=False)
        if len(content_json.encode("utf-8")) > 150_000:
            raise ValueError("Message editor data is too large")
        values = {
            "name": str(body.get("name", "")).strip(),
            "subject": str(body.get("subject", "")).strip(),
            "from_name": str(body.get("from_name", "")).strip(),
            "from_email": normalize_email(str(body.get("from_email", ""))),
            "content_mode": content_mode,
            "content_json": content_json,
            "html_body": str(body.get("html_body", "")).strip(),
            "text_body": str(body.get("text_body", "")).strip(),
            "list_id": str(body.get("list_id", "")).strip(),
        }
        if not all(values[key] for key in ("name", "subject", "from_name", "html_body", "text_body", "list_id")):
            raise ValueError("Name, subject, sender, audience, and message content are required")
        if not valid_email(values["from_email"]):
            raise ValueError("A valid sender email is required")
        if len(values["name"]) > 160 or len(values["subject"]) > 250:
            raise ValueError("Campaign name or subject is too long")
        if "\r" in values["subject"] or "\n" in values["subject"] or "\r" in values["from_name"] or "\n" in values["from_name"]:
            raise ValueError("Sender name and subject cannot contain line breaks")
        if self.application.config.delivery_mode == "smtp" and values["from_email"] != normalize_email(self.application.config.smtp_from_email):
            raise ValueError("Sender must match SENDSTACK_SMTP_FROM_EMAIL in SMTP test mode")
        if len(values["html_body"].encode("utf-8")) > 500_000:
            raise ValueError("Message HTML is too large")
        if len(values["text_body"].encode("utf-8")) > 200_000:
            raise ValueError("Plain-text content is too large")
        validate_email_content(values["html_body"], values["text_body"])
        return values

    def _create_campaign(self, session: sqlite3.Row) -> None:
        try:
            values = self._validate_campaign_body(self._body_json())
            campaign_id = make_id("cam")
            now = utc_now()
            with self.db._write_lock, self.db.connect() as connection:
                connection.execute(
                    """
                    INSERT INTO campaigns
                        (id, name, subject, from_name, from_email, content_mode, content_json,
                         html_body, text_body, list_id, created_by, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        campaign_id,
                        values["name"],
                        values["subject"],
                        values["from_name"],
                        values["from_email"],
                        values["content_mode"],
                        values["content_json"],
                        values["html_body"],
                        values["text_body"],
                        values["list_id"],
                        session["user_id"],
                        now,
                        now,
                    ),
                )
        except sqlite3.IntegrityError:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "The selected audience does not exist"})
        except ValueError as exc:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        self.db.audit(
            "create",
            "campaign",
            campaign_id,
            session["user_id"],
            {"name": values["name"], "content_mode": values["content_mode"]},
        )
        self._json(HTTPStatus.CREATED, {"id": campaign_id})

    def _campaign(self, campaign_id: str) -> None:
        with self.db.connect() as connection:
            row = connection.execute(
                "SELECT ca.*, l.name AS list_name FROM campaigns ca JOIN lists l ON l.id = ca.list_id WHERE ca.id = ?",
                (campaign_id,),
            ).fetchone()
            if not row:
                return self._json(HTTPStatus.NOT_FOUND, {"error": "Campaign not found"})
            stats = connection.execute(
                "SELECT status, COUNT(*) AS count FROM campaign_recipients WHERE campaign_id = ? GROUP BY status",
                (campaign_id,),
            ).fetchall()
        payload = dict(row)
        try:
            payload["content_json"] = json.loads(payload["content_json"])
        except (json.JSONDecodeError, TypeError):
            payload["content_json"] = {"schema_version": 1}
        payload["stats"] = {item["status"]: item["count"] for item in stats}
        self._json(HTTPStatus.OK, {"campaign": payload})

    def _update_campaign(self, campaign_id: str, session: sqlite3.Row) -> None:
        try:
            values = self._validate_campaign_body(self._body_json())
            with self.db._write_lock, self.db.connect() as connection:
                current = connection.execute("SELECT status FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
                if not current:
                    return self._json(HTTPStatus.NOT_FOUND, {"error": "Campaign not found"})
                if current["status"] not in {"draft", "paused"}:
                    return self._json(HTTPStatus.CONFLICT, {"error": "Only draft or paused campaigns can be edited"})
                connection.execute(
                    """
                    UPDATE campaigns SET name = ?, subject = ?, from_name = ?, from_email = ?,
                                         content_mode = ?, content_json = ?, html_body = ?,
                                         text_body = ?, list_id = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        values["name"], values["subject"], values["from_name"], values["from_email"],
                        values["content_mode"], values["content_json"], values["html_body"],
                        values["text_body"], values["list_id"], utc_now(), campaign_id,
                    ),
                )
        except sqlite3.IntegrityError:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": "The selected audience does not exist"})
        except ValueError as exc:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        self.db.audit(
            "update",
            "campaign",
            campaign_id,
            session["user_id"],
            {"content_mode": values["content_mode"]},
        )
        self._json(HTTPStatus.OK, {"id": campaign_id})

    def _launch_campaign(self, campaign_id: str, session: sqlite3.Row) -> None:
        now = utc_now()
        with self.db._write_lock, self.db.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            campaign = connection.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
            if not campaign:
                connection.execute("ROLLBACK")
                return self._json(HTTPStatus.NOT_FOUND, {"error": "Campaign not found"})
            if campaign["status"] not in {"draft", "paused"}:
                connection.execute("ROLLBACK")
                return self._json(HTTPStatus.CONFLICT, {"error": "Campaign is already running or complete"})
            candidates = connection.execute(
                """
                SELECT c.id, c.email FROM contacts c
                JOIN list_contacts lc ON lc.contact_id = c.id
                LEFT JOIN suppressions s ON s.email = c.email
                WHERE lc.list_id = ? AND c.status = 'active' AND s.email IS NULL
                ORDER BY c.created_at
                """,
                (campaign["list_id"],),
            ).fetchall()
            if self.application.config.delivery_mode == "smtp":
                if len(candidates) > self.application.config.external_campaign_cap:
                    connection.execute("ROLLBACK")
                    return self._json(
                        HTTPStatus.CONFLICT,
                        {"error": f"SMTP test campaigns are capped at {self.application.config.external_campaign_cap} recipients"},
                    )
                blocked = [contact["email"] for contact in candidates if not self.application.delivery.recipient_is_allowed(contact["email"])]
                if blocked:
                    connection.execute("ROLLBACK")
                    return self._json(
                        HTTPStatus.CONFLICT,
                        {"error": f"{len(blocked)} recipient(s) are outside the exact SMTP test allowlist"},
                    )
            inserted = 0
            for contact in candidates:
                inserted += connection.execute(
                    """
                    INSERT OR IGNORE INTO campaign_recipients
                        (id, campaign_id, contact_id, email, message_id, queued_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (make_id("rcp"), campaign_id, contact["id"], contact["email"], uuid.uuid4().hex, now),
                ).rowcount
            total = connection.execute(
                "SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = ? AND status IN ('queued', 'processing')",
                (campaign_id,),
            ).fetchone()[0]
            if total == 0:
                connection.execute("ROLLBACK")
                return self._json(HTTPStatus.CONFLICT, {"error": "No eligible recipients are available"})
            connection.execute(
                "UPDATE campaigns SET status = 'sending', launched_at = COALESCE(launched_at, ?), completed_at = NULL, updated_at = ? WHERE id = ?",
                (now, now, campaign_id),
            )
            connection.execute("COMMIT")
        self.db.audit("launch", "campaign", campaign_id, session["user_id"], {"new_recipients": inserted})
        self._json(HTTPStatus.OK, {"queued": total, "new_recipients": inserted})

    def _campaign_state(self, campaign_id: str, new_state: str, session: sqlite3.Row) -> None:
        with self.db._write_lock, self.db.connect() as connection:
            current = connection.execute("SELECT status FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
            if not current:
                return self._json(HTTPStatus.NOT_FOUND, {"error": "Campaign not found"})
            valid = (new_state == "paused" and current["status"] == "sending") or (
                new_state == "sending" and current["status"] == "paused"
            )
            if not valid:
                return self._json(HTTPStatus.CONFLICT, {"error": f"Campaign cannot be changed from {current['status']} to {new_state}"})
            connection.execute(
                "UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?",
                (new_state, utc_now(), campaign_id),
            )
        self.db.audit(new_state, "campaign", campaign_id, session["user_id"])
        self._json(HTTPStatus.OK, {"status": new_state})

    def _test_send(self, campaign_id: str, session: sqlite3.Row) -> None:
        try:
            body = self._body_json()
            recipient = normalize_email(str(body.get("email", "")))
            if not valid_email(recipient):
                raise ValueError("Enter a valid test recipient")
            with self.db.connect() as connection:
                campaign = connection.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
            if not campaign:
                return self._json(HTTPStatus.NOT_FOUND, {"error": "Campaign not found"})
            token = secrets.token_urlsafe(32)
            unsubscribe_url = f"{self.application.config.public_url}/u/{token}"
            values = {"first_name": "Test", "last_name": "Recipient", "email": recipient, "unsubscribe_url": unsubscribe_url}
            html_values = {key: html.escape(value, quote=True) for key, value in values.items()}
            validate_email_content(campaign["html_body"], campaign["text_body"])
            message_key = uuid.uuid4().hex
            provider_id = self.application.delivery.send(
                to_email=recipient,
                subject="[TEST] " + render_template(campaign["subject"], values),
                from_name=campaign["from_name"],
                from_email=campaign["from_email"],
                html_body=render_template(campaign["html_body"], html_values),
                text_body=render_template(campaign["text_body"], values),
                message_id=message_key,
                unsubscribe_url=unsubscribe_url,
            )
            message_id = make_id("msg")
            now = utc_now()
            with self.db._write_lock, self.db.connect() as connection:
                connection.execute(
                    """
                    INSERT INTO messages
                        (id, campaign_id, to_email, subject, from_email, html_body, text_body,
                         status, provider_id, unsubscribe_token, created_at, delivered_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        message_id, campaign_id, recipient, "[TEST] " + render_template(campaign["subject"], values),
                        campaign["from_email"], render_template(campaign["html_body"], html_values),
                        render_template(campaign["text_body"], values),
                        "sandboxed" if self.application.config.delivery_mode == "sandbox" else "submitted",
                        provider_id, token, now, now,
                    ),
                )
        except (ValueError, RuntimeError, smtplib.SMTPException, OSError) as exc:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        self.db.audit("test_send", "campaign", campaign_id, session["user_id"], {"recipient": recipient})
        self._json(HTTPStatus.OK, {"id": message_id})

    def _messages(self, query: dict[str, list[str]]) -> None:
        campaign_id = query.get("campaign_id", [""])[0]
        sql = """
            SELECT m.id, m.campaign_id, m.to_email, m.subject, m.from_email, m.status,
                   m.error, m.created_at, m.delivered_at, ca.name AS campaign_name
            FROM messages m LEFT JOIN campaigns ca ON ca.id = m.campaign_id
        """
        params: list[Any] = []
        if campaign_id:
            sql += " WHERE m.campaign_id = ?"
            params.append(campaign_id)
        sql += " ORDER BY m.created_at DESC LIMIT 500"
        with self.db.connect() as connection:
            rows = connection.execute(sql, params).fetchall()
        self._json(HTTPStatus.OK, {"messages": rows_to_dicts(rows)})

    def _message(self, message_id: str) -> None:
        with self.db.connect() as connection:
            row = connection.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
        if not row:
            return self._json(HTTPStatus.NOT_FOUND, {"error": "Message not found"})
        self._json(HTTPStatus.OK, {"message": dict(row)})

    def _message_event(self, message_id: str, session: sqlite3.Row) -> None:
        try:
            event = str(self._body_json().get("event", ""))
            if event not in {"hard_bounce", "complaint"}:
                raise ValueError("Event must be hard_bounce or complaint")
        except ValueError as exc:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        with self.db._write_lock, self.db.connect() as connection:
            message = connection.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
            if not message:
                return self._json(HTTPStatus.NOT_FOUND, {"error": "Message not found"})
            new_status = "bounced" if event == "hard_bounce" else "complained"
            connection.execute("UPDATE messages SET status = ? WHERE id = ?", (new_status, message_id))
            if message["recipient_id"]:
                connection.execute(
                    "UPDATE campaign_recipients SET status = ? WHERE id = ?",
                    (new_status, message["recipient_id"]),
                )
        self._apply_suppression(message["to_email"], event, "simulated_feedback")
        self.db.audit("feedback", "message", message_id, session["user_id"], {"event": event})
        self._json(HTTPStatus.OK, {"status": new_status})

    @staticmethod
    def _validate_user_password(password: str) -> None:
        if len(password) < 12 or len(password) > 256:
            raise ValueError("Password must be between 12 and 256 characters")

    def _user_row(self, user_id: str) -> sqlite3.Row | None:
        with self.db.connect() as connection:
            return connection.execute(
                """
                SELECT u.id, u.email, u.name, u.role, u.active, u.created_at, u.updated_at,
                       MAX(CASE WHEN a.action = 'login' THEN a.created_at END) AS last_login_at
                FROM users u
                LEFT JOIN audit_events a ON a.actor_user_id = u.id
                WHERE u.id = ?
                GROUP BY u.id
                """,
                (user_id,),
            ).fetchone()

    @staticmethod
    def _user_payload(row: sqlite3.Row, current_user_id: str) -> dict[str, Any]:
        return {
            "id": row["id"],
            "email": row["email"],
            "name": row["name"],
            "role": row["role"],
            "role_label": ROLE_DEFINITIONS[row["role"]]["label"],
            "active": bool(row["active"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "last_login_at": row["last_login_at"],
            "is_current_user": row["id"] == current_user_id,
        }

    def _users(self, session: sqlite3.Row) -> None:
        with self.db.connect() as connection:
            rows = connection.execute(
                """
                SELECT u.id, u.email, u.name, u.role, u.active, u.created_at, u.updated_at,
                       MAX(CASE WHEN a.action = 'login' THEN a.created_at END) AS last_login_at
                FROM users u
                LEFT JOIN audit_events a ON a.actor_user_id = u.id
                GROUP BY u.id
                ORDER BY u.active DESC, u.name COLLATE NOCASE, u.email COLLATE NOCASE
                """
            ).fetchall()
        self._json(
            HTTPStatus.OK,
            {
                "users": [self._user_payload(row, session["user_id"]) for row in rows],
                "roles": role_definitions_payload(),
                "permissions": permission_definitions_payload(),
            },
        )

    def _create_user(self, session: sqlite3.Row) -> None:
        try:
            body = self._body_json(50_000)
            unknown = set(body) - {"name", "email", "role", "password"}
            if unknown:
                raise ValueError(f"Unknown user field: {sorted(unknown)[0]}")
            name = str(body.get("name", "")).strip()
            email_address = normalize_email(str(body.get("email", "")))
            role = str(body.get("role", "")).strip()
            password = str(body.get("password", ""))
            if not name or len(name) > 120:
                raise ValueError("Name is required and must be under 120 characters")
            if not valid_email(email_address):
                raise ValueError("A valid email address is required")
            if role not in ROLE_DEFINITIONS:
                raise ValueError("Choose a valid role")
            self._validate_user_password(password)
            user_id = make_id("usr")
            now = utc_now()
            with self.db._write_lock, self.db.connect() as connection:
                connection.execute(
                    """
                    INSERT INTO users
                        (id, email, name, role, password_hash, active, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                    """,
                    (
                        user_id,
                        email_address,
                        name,
                        role,
                        hash_password(password),
                        now,
                        now,
                    ),
                )
        except sqlite3.IntegrityError:
            return self._json(
                HTTPStatus.CONFLICT,
                {"error": "A user with that email already exists", "code": "email_exists"},
            )
        except ValueError as exc:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        self.db.audit(
            "create",
            "user",
            user_id,
            session["user_id"],
            {"email": email_address, "role": role},
        )
        row = self._user_row(user_id)
        self._json(
            HTTPStatus.CREATED,
            {"user": self._user_payload(row, session["user_id"])},
        )

    def _update_user(self, user_id: str, session: sqlite3.Row) -> None:
        try:
            body = self._body_json(50_000)
            allowed = {"name", "email", "role", "active"}
            unknown = set(body) - allowed
            if unknown:
                raise ValueError(f"Unknown user field: {sorted(unknown)[0]}")
            if not body:
                raise ValueError("Provide at least one user field to update")
            if "active" in body and type(body["active"]) is not bool:
                raise ValueError("Active must be true or false")
            now = utc_now()
            changed_fields: list[str] = []
            audit_detail: dict[str, Any] = {}
            with self.db._write_lock, self.db.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                existing = connection.execute(
                    "SELECT id, email, name, role, active FROM users WHERE id = ?",
                    (user_id,),
                ).fetchone()
                if not existing:
                    connection.execute("ROLLBACK")
                    return self._json(HTTPStatus.NOT_FOUND, {"error": "User not found"})
                name = str(body.get("name", existing["name"])).strip()
                email_address = normalize_email(str(body.get("email", existing["email"])))
                role = str(body.get("role", existing["role"])).strip()
                active = bool(body.get("active", bool(existing["active"])))
                if not name or len(name) > 120:
                    raise ValueError("Name is required and must be under 120 characters")
                if not valid_email(email_address):
                    raise ValueError("A valid email address is required")
                if role not in ROLE_DEFINITIONS:
                    raise ValueError("Choose a valid role")
                if user_id == session["user_id"] and (
                    role != existing["role"] or not active
                ):
                    connection.execute("ROLLBACK")
                    return self._json(
                        HTTPStatus.CONFLICT,
                        {
                            "error": "You cannot change your own role or disable your own account",
                            "code": "self_access_change",
                        },
                    )
                removes_active_admin = (
                    bool(existing["active"])
                    and existing["role"] == "admin"
                    and (not active or role != "admin")
                )
                if removes_active_admin:
                    active_admins = connection.execute(
                        "SELECT COUNT(*) FROM users WHERE active = 1 AND role = 'admin'"
                    ).fetchone()[0]
                    if active_admins <= 1:
                        connection.execute("ROLLBACK")
                        return self._json(
                            HTTPStatus.CONFLICT,
                            {
                                "error": "At least one active administrator is required",
                                "code": "last_admin",
                            },
                        )
                new_values = {
                    "name": name,
                    "email": email_address,
                    "role": role,
                    "active": active,
                }
                for field, value in new_values.items():
                    previous = bool(existing[field]) if field == "active" else existing[field]
                    if value != previous:
                        changed_fields.append(field)
                        if field in {"role", "active", "email"}:
                            audit_detail[f"previous_{field}"] = previous
                            audit_detail[field] = value
                connection.execute(
                    """
                    UPDATE users
                    SET name = ?, email = ?, role = ?, active = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (name, email_address, role, int(active), now, user_id),
                )
                if role != existing["role"] or active != bool(existing["active"]):
                    connection.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
                connection.execute("COMMIT")
        except sqlite3.IntegrityError:
            return self._json(
                HTTPStatus.CONFLICT,
                {"error": "A user with that email already exists", "code": "email_exists"},
            )
        except ValueError as exc:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        if changed_fields:
            audit_detail["fields"] = changed_fields
            self.db.audit("update", "user", user_id, session["user_id"], audit_detail)
        row = self._user_row(user_id)
        self._json(
            HTTPStatus.OK,
            {
                "user": self._user_payload(row, session["user_id"]),
                "sessions_revoked": "role" in changed_fields or "active" in changed_fields,
            },
        )

    def _reset_user_password(self, user_id: str, session: sqlite3.Row) -> None:
        try:
            body = self._body_json(20_000)
            if set(body) != {"password"}:
                raise ValueError("Provide only the new password")
            password = str(body.get("password", ""))
            self._validate_user_password(password)
            now = utc_now()
            with self.db._write_lock, self.db.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                user = connection.execute(
                    "SELECT id FROM users WHERE id = ?", (user_id,)
                ).fetchone()
                if not user:
                    connection.execute("ROLLBACK")
                    return self._json(HTTPStatus.NOT_FOUND, {"error": "User not found"})
                connection.execute(
                    "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
                    (hash_password(password), now, user_id),
                )
                connection.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
                connection.execute("COMMIT")
        except ValueError as exc:
            return self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        self.db.audit("reset_password", "user", user_id, session["user_id"])
        self._json(HTTPStatus.OK, {"ok": True, "sessions_revoked": True})

    def _audit(self) -> None:
        with self.db.connect() as connection:
            rows = connection.execute(
                """
                SELECT a.id, a.action, a.entity_type, a.entity_id, a.detail_json, a.created_at,
                       u.name AS actor_name
                FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id
                ORDER BY a.created_at DESC LIMIT 100
                """
            ).fetchall()
        events = []
        for row in rows:
            item = dict(row)
            try:
                item["detail"] = json.loads(item.pop("detail_json"))
            except json.JSONDecodeError:
                item["detail"] = {}
            events.append(item)
        self._json(HTTPStatus.OK, {"events": events})

    def _unsubscribe_page(self, token: str) -> None:
        if not TOKEN_RE.fullmatch(token):
            return self._html(HTTPStatus.NOT_FOUND, simple_page("Invalid link", "This unsubscribe link is not valid."))
        with self.db.connect() as connection:
            message = connection.execute(
                "SELECT to_email FROM messages WHERE unsubscribe_token = ?", (token,)
            ).fetchone()
        if not message:
            return self._html(HTTPStatus.NOT_FOUND, simple_page("Link not found", "This unsubscribe link has expired or is not valid."))
        address = html.escape(message["to_email"])
        markup = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Unsubscribe</title><style>{PUBLIC_PAGE_CSS}</style></head>
        <body><main><div class="mark">S</div><h1>Stop marketing email?</h1><p>Confirm that <strong>{address}</strong> should be added to the global suppression list.</p><form method="post"><button type="submit">Unsubscribe</button></form><p class="small">This test environment records the request immediately.</p></main></body></html>"""
        self._html(HTTPStatus.OK, markup)

    def _unsubscribe(self, token: str) -> None:
        if not TOKEN_RE.fullmatch(token):
            return self._html(HTTPStatus.NOT_FOUND, simple_page("Invalid link", "This unsubscribe link is not valid."))
        with self.db.connect() as connection:
            message = connection.execute(
                "SELECT to_email FROM messages WHERE unsubscribe_token = ?", (token,)
            ).fetchone()
        if not message:
            return self._html(HTTPStatus.NOT_FOUND, simple_page("Link not found", "This unsubscribe link has expired or is not valid."))
        self._apply_suppression(message["to_email"], "unsubscribe", "recipient_link")
        self.db.audit("unsubscribe", "contact", message["to_email"], None)
        self._html(HTTPStatus.OK, simple_page("You’re unsubscribed", "This address has been added to the suppression list."))


def rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(row) for row in rows]


PUBLIC_PAGE_CSS = """
html{font-family:ui-sans-serif,system-ui,sans-serif;background:#07111f;color:#eaf1ff;color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{max-width:520px;background:#101d31;border:1px solid #263854;border-radius:20px;padding:36px;box-shadow:0 24px 70px #0008}.mark{width:44px;height:44px;border-radius:14px;background:#5b7cff;display:grid;place-items:center;font-weight:800}h1{font-size:28px;margin:22px 0 10px}p{color:#adc0dc;line-height:1.6}strong{color:#fff}button{border:0;border-radius:10px;padding:12px 18px;background:#5b7cff;color:#fff;font:inherit;font-weight:700;cursor:pointer}.small{font-size:13px}
"""


def simple_page(title: str, message: str) -> str:
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{html.escape(title)}</title><style>{PUBLIC_PAGE_CSS}</style></head><body><main><div class="mark">S</div><h1>{html.escape(title)}</h1><p>{html.escape(message)}</p></main></body></html>"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the SendStack test application")
    parser.add_argument("--host", help="Override SENDSTACK_HOST")
    parser.add_argument("--port", type=int, help="Override SENDSTACK_PORT")
    parser.add_argument("--db", help="Override SENDSTACK_DB_PATH")
    args = parser.parse_args()

    config = Config()
    if args.host:
        config.host = args.host
    if args.port:
        config.port = args.port
    if args.db:
        config.db_path = args.db
    if config.public_url == "http://localhost:8080" and config.port != 8080:
        config.public_url = f"http://localhost:{config.port}"

    app = Application(config)
    server = app.make_server()
    app.worker.start()
    mode_note = "sandbox inbox" if config.delivery_mode == "sandbox" else "SMTP relay"
    print(f"SendStack is running at http://{config.host}:{server.server_port} ({mode_note})", flush=True)
    if config.admin_password == "ChangeMe123!":
        print("Test login: admin@sendstack.local / ChangeMe123!", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        app.worker.stop()


if __name__ == "__main__":
    main()
