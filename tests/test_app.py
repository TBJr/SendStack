from __future__ import annotations

import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from http.cookies import SimpleCookie
from pathlib import Path

from app.server import Application, Config, DeliveryAdapter, hash_password, verify_password


os.environ["SENDSTACK_QUIET"] = "1"


class RunningApplication:
    def __init__(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config = Config(
            host="127.0.0.1",
            port=0,
            db_path=str(Path(self.temp_dir.name) / "test.db"),
            public_url="http://127.0.0.1",
            delivery_mode="sandbox",
            admin_email="admin@sendstack.local",
            admin_password="test-password",
            per_second_limit=100,
            daily_limit=500,
            external_campaign_cap=10,
        )
        self.app = Application(self.config)
        self.server = self.app.make_server()
        self.config.public_url = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.app.worker.start()
        self.cookie = ""
        self.csrf = ""

    @property
    def port(self) -> int:
        return self.server.server_port

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.app.worker.stop()
        self.thread.join(timeout=3)
        self.temp_dir.cleanup()

    def request(self, method: str, path: str, body=None, *, authenticated: bool = True, csrf: bool = True):
        headers = {}
        payload = None
        if body is not None:
            payload = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(payload))
        if authenticated and self.cookie:
            headers["Cookie"] = self.cookie
        if csrf and method in {"POST", "PATCH"} and self.csrf:
            headers["X-CSRF-Token"] = self.csrf
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        set_cookie = response.getheader("Set-Cookie")
        content_type = response.getheader("Content-Type", "")
        data = json.loads(raw) if "application/json" in content_type else raw.decode()
        connection.close()
        return response.status, data, set_cookie

    def login(
        self,
        email: str = "admin@sendstack.local",
        password: str = "test-password",
    ) -> None:
        self.cookie = ""
        self.csrf = ""
        status, data, header = self.request(
            "POST",
            "/api/auth/login",
            {"email": email, "password": password},
            authenticated=False,
            csrf=False,
        )
        if status != 200:
            raise AssertionError(data)
        cookie = SimpleCookie(header)
        self.cookie = f"sendstack_session={cookie['sendstack_session'].value}"
        self.csrf = data["csrf_token"]


class SendStackIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.running = RunningApplication()

    def tearDown(self) -> None:
        self.running.close()

    def test_authentication_and_csrf(self) -> None:
        status, _, _ = self.running.request("GET", "/api/session", authenticated=False)
        self.assertEqual(status, 401)
        self.running.login()
        status, data, _ = self.running.request("GET", "/api/session")
        self.assertEqual(status, 200)
        self.assertEqual(data["user"]["role"], "admin")
        self.assertEqual(data["user"]["role_label"], "Administrator")
        self.assertIn("users.manage", data["permissions"])
        self.assertIn("campaigns.send", data["permissions"])
        self.assertEqual(data["production_target"]["platform"], "Vercel")
        self.assertEqual(data["production_target"]["provider"], "Resend Broadcasts")
        self.assertEqual(data["production_status"], "migration_required")
        status, _, _ = self.running.request(
            "POST", "/api/lists", {"name": "Blocked by CSRF"}, csrf=False
        )
        self.assertEqual(status, 403)

    def test_production_readiness_is_explicit_and_fail_closed(self) -> None:
        status, _, _ = self.running.request(
            "GET", "/api/production-readiness", authenticated=False
        )
        self.assertEqual(status, 401)
        self.running.login()
        status, data, _ = self.running.request("GET", "/api/production-readiness")
        self.assertEqual(status, 200)
        self.assertTrue(data["ready_for_local_testing"])
        self.assertFalse(data["ready_for_live_sending"])
        self.assertEqual(data["current"]["transport"], "Local sandbox")
        self.assertEqual(data["target"]["platform"], "Vercel")
        self.assertEqual(data["target"]["database"], "Managed PostgreSQL")
        self.assertEqual(data["target"]["provider"], "Resend Broadcasts")
        checks = {check["id"]: check["status"] for check in data["checks"]}
        self.assertEqual(checks["local_test_build"], "ready")
        self.assertEqual(checks["vercel_runtime"], "migration_required")
        self.assertEqual(checks["postgres_database"], "migration_required")
        self.assertEqual(checks["resend_broadcasts"], "not_connected")
        self.assertFalse(any("secret" in key.lower() for key in data))

    def test_user_administration_validates_and_revokes_access(self) -> None:
        self.running.login()
        status, directory, _ = self.running.request("GET", "/api/users")
        self.assertEqual(status, 200)
        self.assertEqual(len(directory["users"]), 1)
        serialized = json.dumps(directory).lower()
        self.assertNotIn("password_hash", serialized)
        self.assertEqual({role["id"] for role in directory["roles"]}, {"admin", "marketer", "analyst"})

        marketer_password = "MarketerPass123!"
        status, created, _ = self.running.request(
            "POST",
            "/api/users",
            {
                "name": "Morgan Marketer",
                "email": "morgan@example.test",
                "role": "marketer",
                "password": marketer_password,
            },
        )
        self.assertEqual(status, 201)
        marketer_id = created["user"]["id"]
        self.assertNotIn("password", json.dumps(created).lower())

        status, duplicate, _ = self.running.request(
            "POST",
            "/api/users",
            {
                "name": "Duplicate",
                "email": "MORGAN@example.test",
                "role": "analyst",
                "password": "AnotherPass123!",
            },
        )
        self.assertEqual(status, 409)
        self.assertEqual(duplicate["code"], "email_exists")

        status, weak, _ = self.running.request(
            "POST",
            "/api/users",
            {
                "name": "Weak Password",
                "email": "weak@example.test",
                "role": "analyst",
                "password": "short",
            },
        )
        self.assertEqual(status, 400)
        self.assertIn("12", weak["error"])

        admin_id = directory["users"][0]["id"]
        status, self_change, _ = self.running.request(
            "PATCH", f"/api/users/{admin_id}", {"role": "marketer"}
        )
        self.assertEqual(status, 409)
        self.assertEqual(self_change["code"], "self_access_change")

        self.running.login("morgan@example.test", marketer_password)
        marketer_cookie = self.running.cookie
        marketer_csrf = self.running.csrf
        self.running.login()
        status, updated, _ = self.running.request(
            "PATCH", f"/api/users/{marketer_id}", {"role": "analyst"}
        )
        self.assertEqual(status, 200)
        self.assertTrue(updated["sessions_revoked"])
        self.running.cookie = marketer_cookie
        self.running.csrf = marketer_csrf
        status, _, _ = self.running.request("GET", "/api/session")
        self.assertEqual(status, 401)

        self.running.login()
        new_password = "ReplacementPass456!"
        status, reset, _ = self.running.request(
            "POST",
            f"/api/users/{marketer_id}/reset-password",
            {"password": new_password},
        )
        self.assertEqual(status, 200)
        self.assertTrue(reset["sessions_revoked"])
        with self.assertRaises(AssertionError):
            self.running.login("morgan@example.test", marketer_password)
        self.running.login("morgan@example.test", new_password)

    def test_role_permissions_are_enforced_server_side(self) -> None:
        self.running.login()
        accounts = [
            ("Market User", "market@example.test", "marketer", "MarketAccess123!"),
            ("Report User", "report@example.test", "analyst", "ReportAccess123!"),
        ]
        for name, email, role, password in accounts:
            status, _, _ = self.running.request(
                "POST",
                "/api/users",
                {"name": name, "email": email, "role": role, "password": password},
            )
            self.assertEqual(status, 201)

        self.running.login("market@example.test", "MarketAccess123!")
        status, session, _ = self.running.request("GET", "/api/session")
        self.assertEqual(status, 200)
        self.assertIn("contacts.manage", session["permissions"])
        self.assertNotIn("users.view", session["permissions"])
        status, _, _ = self.running.request("GET", "/api/contacts")
        self.assertEqual(status, 200)
        status, _, _ = self.running.request("POST", "/api/lists", {"name": "Marketer list"})
        self.assertEqual(status, 201)
        status, denied, _ = self.running.request("GET", "/api/users")
        self.assertEqual(status, 403)
        self.assertEqual(denied["code"], "permission_denied")
        status, _, _ = self.running.request("GET", "/api/audit")
        self.assertEqual(status, 403)
        status, _, _ = self.running.request(
            "POST", "/api/messages/not-a-message/event", {"event": "complaint"}
        )
        self.assertEqual(status, 403)
        status, invalid_reason, _ = self.running.request(
            "POST",
            "/api/suppressions",
            {"email": "manual@example.test", "reason": "complaint"},
        )
        self.assertEqual(status, 400)
        self.assertIn("manual reason", invalid_reason["error"].lower())
        status, _, _ = self.running.request(
            "POST",
            "/api/suppressions",
            {"email": "manual@example.test", "reason": "manual"},
        )
        self.assertEqual(status, 201)

        self.running.login("report@example.test", "ReportAccess123!")
        status, session, _ = self.running.request("GET", "/api/session")
        self.assertEqual(status, 200)
        self.assertEqual(session["user"]["role_label"], "Analyst")
        self.assertIn("campaigns.view", session["permissions"])
        self.assertNotIn("contacts.view", session["permissions"])
        status, summary, _ = self.running.request("GET", "/api/summary")
        self.assertEqual(status, 200)
        self.assertFalse(summary["delivery_records_visible"])
        self.assertEqual(summary["recent_messages"], [])
        status, _, _ = self.running.request("GET", "/api/lists")
        self.assertEqual(status, 200)
        status, _, _ = self.running.request("GET", "/api/campaigns")
        self.assertEqual(status, 200)
        for path in ("/api/contacts", "/api/messages", "/api/suppressions", "/api/users"):
            status, denied, _ = self.running.request("GET", path)
            self.assertEqual(status, 403, path)
            self.assertEqual(denied["code"], "permission_denied")
        status, denied, _ = self.running.request("POST", "/api/campaigns", {})
        self.assertEqual(status, 403)
        self.assertEqual(denied["permission"], "campaigns.manage")

    def test_complete_sandbox_workflow(self) -> None:
        self.running.login()

        status, list_data, _ = self.running.request("GET", "/api/lists")
        self.assertEqual(status, 200)
        list_id = list_data["lists"][0]["id"]

        mixed_csv = """email,first_name,last_name
new.one@example.test,New,One
new.two@example.test,New,Two
new.two@example.test,Duplicate,Row
not-an-email,Bad,Row
"""
        status, imported, _ = self.running.request(
            "POST", "/api/contacts/import", {"csv_text": mixed_csv, "list_id": list_id}
        )
        self.assertEqual(status, 200)
        self.assertEqual(imported["imported"], 2)
        self.assertEqual(imported["duplicates"], 1)
        self.assertEqual(imported["invalid"], 1)

        campaign_payload = {
            "name": "Integration campaign",
            "subject": "Hello {{first_name}}",
            "from_name": "SendStack Test",
            "from_email": "updates@example.test",
            "html_body": "<h1>Hello {{first_name}}</h1><a href='{{unsubscribe_url}}'>Unsubscribe</a>",
            "text_body": "Hello {{first_name}}. Unsubscribe: {{unsubscribe_url}}",
            "list_id": list_id,
        }
        status, created, _ = self.running.request("POST", "/api/campaigns", campaign_payload)
        self.assertEqual(status, 201)
        campaign_id = created["id"]

        status, _, _ = self.running.request(
            "POST", f"/api/campaigns/{campaign_id}/test-send", {"email": "owner@example.test"}
        )
        self.assertEqual(status, 200)

        status, launch, _ = self.running.request(
            "POST", f"/api/campaigns/{campaign_id}/launch", {}
        )
        self.assertEqual(status, 200)
        self.assertEqual(launch["queued"], 5)

        deadline = time.time() + 4
        while time.time() < deadline:
            status, detail, _ = self.running.request("GET", f"/api/campaigns/{campaign_id}")
            if detail["campaign"]["status"] == "completed":
                break
            time.sleep(0.05)
        self.assertEqual(detail["campaign"]["status"], "completed")
        self.assertEqual(detail["campaign"]["stats"]["sent"], 5)

        status, inbox, _ = self.running.request("GET", "/api/messages")
        self.assertEqual(status, 200)
        self.assertEqual(len(inbox["messages"]), 6)
        first_campaign_message = next(
            item for item in inbox["messages"] if item["to_email"] == "new.one@example.test"
        )
        status, _, _ = self.running.request(
            "POST",
            f"/api/messages/{first_campaign_message['id']}/event",
            {"event": "hard_bounce"},
        )
        self.assertEqual(status, 200)
        status, suppressions, _ = self.running.request("GET", "/api/suppressions")
        self.assertEqual(status, 200)
        self.assertIn("new.one@example.test", {item["email"] for item in suppressions["suppressions"]})

        status, created_second, _ = self.running.request(
            "POST", "/api/campaigns", {**campaign_payload, "name": "Second campaign"}
        )
        self.assertEqual(status, 201)
        status, second_launch, _ = self.running.request(
            "POST", f"/api/campaigns/{created_second['id']}/launch", {}
        )
        self.assertEqual(status, 200)
        self.assertEqual(second_launch["queued"], 4)

    def test_public_unsubscribe_is_idempotent(self) -> None:
        self.running.login()
        status, lists, _ = self.running.request("GET", "/api/lists")
        list_id = lists["lists"][0]["id"]
        payload = {
            "name": "Unsubscribe test",
            "subject": "Test",
            "from_name": "SendStack",
            "from_email": "updates@example.test",
            "html_body": "<a href='{{unsubscribe_url}}'>Unsubscribe</a>",
            "text_body": "{{unsubscribe_url}}",
            "list_id": list_id,
        }
        _, campaign, _ = self.running.request("POST", "/api/campaigns", payload)
        _, message, _ = self.running.request(
            "POST", f"/api/campaigns/{campaign['id']}/test-send", {"email": "owner@example.test"}
        )
        _, detail, _ = self.running.request("GET", f"/api/messages/{message['id']}")
        token = detail["message"]["unsubscribe_token"]
        status, _, _ = self.running.request("POST", f"/u/{token}", authenticated=False, csrf=False)
        self.assertEqual(status, 200)
        status, _, _ = self.running.request("POST", f"/u/{token}", authenticated=False, csrf=False)
        self.assertEqual(status, 200)
        _, suppressions, _ = self.running.request("GET", "/api/suppressions")
        matches = [item for item in suppressions["suppressions"] if item["email"] == "owner@example.test"]
        self.assertEqual(len(matches), 1)

    def test_campaign_content_modes_round_trip(self) -> None:
        self.running.login()
        _, lists, _ = self.running.request("GET", "/api/lists")
        list_id = lists["lists"][0]["id"]
        modes = {
            "visual": {
                "schema_version": 1,
                "template": "announcement",
                "headline": "Visual headline",
            },
            "rich_text": {
                "schema_version": 1,
                "rich_html": "<h1>Rich message</h1><p>Hello {{first_name}}</p>",
            },
            "custom_html": {"schema_version": 1},
            "plain_text": {
                "schema_version": 1,
                "plain_text": "Plain message\n\nUnsubscribe: {{unsubscribe_url}}",
            },
        }
        for mode, content_json in modes.items():
            with self.subTest(mode=mode):
                payload = {
                    "name": f"{mode} campaign",
                    "subject": "Hello {{first_name}}",
                    "from_name": "SendStack Test",
                    "from_email": "updates@example.test",
                    "content_mode": mode,
                    "content_json": content_json,
                    "html_body": "<h1>Hello {{first_name}}</h1><a href='{{unsubscribe_url}}'>Unsubscribe</a>",
                    "text_body": "Hello {{first_name}}. Unsubscribe: {{unsubscribe_url}}",
                    "list_id": list_id,
                }
                status, created, _ = self.running.request("POST", "/api/campaigns", payload)
                self.assertEqual(status, 201)
                status, detail, _ = self.running.request(
                    "GET", f"/api/campaigns/{created['id']}"
                )
                self.assertEqual(status, 200)
                self.assertEqual(detail["campaign"]["content_mode"], mode)
                self.assertEqual(detail["campaign"]["content_json"], content_json)

    def test_campaign_content_validation_rejects_active_html_and_unknown_tokens(self) -> None:
        self.running.login()
        _, lists, _ = self.running.request("GET", "/api/lists")
        base = {
            "name": "Unsafe content",
            "subject": "Test",
            "from_name": "SendStack Test",
            "from_email": "updates@example.test",
            "content_mode": "custom_html",
            "content_json": {"schema_version": 1},
            "text_body": "Unsubscribe: {{unsubscribe_url}}",
            "list_id": lists["lists"][0]["id"],
        }
        status, response, _ = self.running.request(
            "POST",
            "/api/campaigns",
            {**base, "html_body": "<script>alert(1)</script><a href='{{unsubscribe_url}}'>Unsubscribe</a>"},
        )
        self.assertEqual(status, 400)
        self.assertIn("unsafe", response["error"].lower())

        status, response, _ = self.running.request(
            "POST",
            "/api/campaigns",
            {**base, "html_body": "<p>{{account_password}}</p><a href='{{unsubscribe_url}}'>Unsubscribe</a>"},
        )
        self.assertEqual(status, 400)
        self.assertIn("unknown personalization", response["error"].lower())


class SecurityPrimitiveTests(unittest.TestCase):
    def test_password_hashes_are_salted_and_verifiable(self) -> None:
        first = hash_password("correct horse battery staple")
        second = hash_password("correct horse battery staple")
        self.assertNotEqual(first, second)
        self.assertTrue(verify_password("correct horse battery staple", first))
        self.assertFalse(verify_password("wrong", first))

    def test_smtp_mode_fails_closed_without_configuration(self) -> None:
        config = Config(delivery_mode="smtp", smtp_host="", smtp_username="", smtp_password="")
        with self.assertRaises(ValueError):
            config.validate()

    def test_smtp_allowlist_requires_exact_addresses(self) -> None:
        config = Config(
            delivery_mode="smtp",
            smtp_host="smtp.example.com",
            smtp_username="user",
            smtp_password="secret",
            smtp_from_email="sender@example.com",
            smtp_starttls=True,
            recipient_allowlist="@example.com",
        )
        config.validate()
        with self.assertRaises(ValueError):
            DeliveryAdapter(config)


if __name__ == "__main__":
    unittest.main()
