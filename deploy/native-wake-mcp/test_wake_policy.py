from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
import tempfile
import unittest
from zoneinfo import ZoneInfo

from wake_policy import WakePolicy


class WakeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "wake.sqlite3"
        self.now = datetime(2026, 9, 5, 9, tzinfo=ZoneInfo("Asia/Kuching"))
        self.policy = WakePolicy(self.path, lambda: self.now)

    def tearDown(self):
        self.temp.cleanup()

    def enable(self, client="chatgpt"):
        return self.policy.set_enabled(client, True)

    def test_disabled_on_first_use_and_read_does_not_enable(self):
        for client in ("chatgpt", "claude"):
            self.assertEqual(self.policy.status(client)["reason"], "disabled")
            self.assertFalse(self.policy.claim(client)["allowed"])

    def test_workday_and_night_boundaries(self):
        self.enable()
        for hour, minute, reason in [(8, 0, "quiet_hours"), (16, 59, "quiet_hours"), (17, 0, "ready"), (22, 59, "ready"), (23, 0, "quiet_hours")]:
            self.now = datetime(2026, 9, 7, hour, minute, tzinfo=ZoneInfo("Asia/Kuching"))
            self.assertEqual(self.policy.status("chatgpt")["reason"], reason)

    def test_weekend_boundary_and_feeding_day(self):
        self.enable()
        self.now = self.now.replace(hour=8, minute=59)
        self.assertFalse(self.policy.claim("chatgpt")["allowed"])
        self.now = self.now.replace(hour=9, minute=0)
        self.assertTrue(self.policy.claim("chatgpt")["allowed"])
        self.assertEqual(self.policy.status("chatgpt")["feeding_day"], 518)

    def test_atomic_concurrent_attempts_across_connections(self):
        self.enable()
        def attempt(_):
            return WakePolicy(self.path, lambda: self.now).claim("chatgpt")["allowed"]
        with ThreadPoolExecutor(max_workers=8) as workers:
            self.assertEqual(sum(workers.map(attempt, range(24))), 1)
        self.assertEqual(self.policy.status("chatgpt")["claims_today"], 1)

    def test_retry_and_hour_boundary_cannot_duplicate(self):
        self.enable()
        self.now = self.now.replace(minute=59)
        self.assertTrue(self.policy.claim("chatgpt")["allowed"])
        self.now += timedelta(minutes=1)
        self.assertEqual(self.policy.claim("chatgpt")["reason"], "cooldown")
        self.now += timedelta(minutes=59)
        self.assertTrue(self.policy.claim("chatgpt")["allowed"])

    def test_cap_and_local_midnight_reset(self):
        self.enable()
        for hour in range(9, 19):
            self.now = self.now.replace(hour=hour)
            self.assertTrue(self.policy.claim("chatgpt")["allowed"])
        self.now = self.now.replace(hour=19)
        self.assertEqual(self.policy.claim("chatgpt")["reason"], "daily_limit")
        self.now += timedelta(days=1)
        self.now = self.now.replace(hour=0)
        self.assertEqual(self.policy.status("chatgpt")["claims_today"], 0)
        self.assertEqual(self.policy.claim("chatgpt")["reason"], "quiet_hours")
        self.now = self.now.replace(hour=9)
        self.assertTrue(self.policy.claim("chatgpt")["allowed"])

    def test_platform_counts_and_pause_are_independent(self):
        self.enable("chatgpt")
        self.enable("claude")
        claim = self.policy.claim("chatgpt")
        self.assertEqual(self.policy.status("claude")["claims_today"], 0)
        self.assertTrue(self.policy.claim("claude")["allowed"])
        self.policy.set_enabled("chatgpt", False)
        self.assertTrue(self.policy.status("claude")["enabled"])
        self.assertFalse(self.policy.claim("chatgpt")["allowed"])
        with self.assertRaises(ValueError):
            self.policy.record_outcome("claude", claim["claim_id"], "generated")

    def test_pause_survives_restart_and_status_reads(self):
        self.enable()
        self.policy.set_enabled("chatgpt", False)
        restarted = WakePolicy(self.path, lambda: self.now)
        self.assertFalse(restarted.status("chatgpt")["enabled"])
        self.assertFalse(restarted.claim("chatgpt")["allowed"])

    def test_outcomes_are_assertions_and_failures_keep_the_limit(self):
        self.enable()
        claim = self.policy.claim("chatgpt")
        result = self.policy.record_outcome("chatgpt", claim["claim_id"], "failed")
        self.assertFalse(result["delivery_verified"])
        self.assertEqual(self.policy.record_outcome("chatgpt", claim["claim_id"], "failed"), result)
        self.assertFalse(self.policy.claim("chatgpt")["allowed"])
        with self.assertRaises(ValueError):
            self.policy.record_outcome("chatgpt", claim["claim_id"], "generated")

    def test_invalid_arguments_and_naive_clock(self):
        for client in ("", "frontend", "../claude"):
            with self.assertRaises(ValueError):
                self.policy.status(client)
        with self.assertRaises(ValueError):
            self.policy.set_enabled("chatgpt", "false")
        self.now = datetime(2026, 9, 5, 9)
        with self.assertRaises(ValueError):
            self.policy.status("chatgpt")


if __name__ == "__main__":
    unittest.main()
