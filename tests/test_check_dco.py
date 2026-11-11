"""Exercise the DCO command against real commit graphs."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CHECKER = Path(__file__).resolve().parents[1] / "scripts" / "check_dco.py"
SIGNOFF = "Signed-off-by: Maintainer <maintainer@example.com>"


class DcoCommandTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.env = {
            **os.environ,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_AUTHOR_NAME": "Maintainer",
            "GIT_AUTHOR_EMAIL": "maintainer@example.com",
            "GIT_COMMITTER_NAME": "Maintainer",
            "GIT_COMMITTER_EMAIL": "maintainer@example.com",
        }
        self.git("init", "-b", "main")
        self.base = self.commit("base\n\n" + SIGNOFF)

    def git(self, *args):
        return subprocess.check_output(
            ["git", *args],
            cwd=self.root,
            env=self.env,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()

    def commit(self, message):
        self.git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", message)
        return self.git("rev-parse", "HEAD")

    def check(self):
        return subprocess.run(
            [sys.executable, str(CHECKER), self.base + "..HEAD"],
            cwd=self.root,
            env=self.env,
            capture_output=True,
            text=True,
            check=False,
        )

    def recover(self, *targets, signoff=SIGNOFF):
        trailers = "\n".join("DCO-Remediation: " + target for target in targets)
        return self.commit(
            "Certify the listed contributions under DCO 1.1\n\n"
            + trailers
            + "\n"
            + signoff
        )

    def test_signed_commit_passes(self):
        self.commit("signed change\n\n" + SIGNOFF)
        self.assertEqual(self.check().returncode, 0)

    def test_unsigned_commit_fails(self):
        target = self.commit("unsigned change")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn(target[:12], result.stderr)

    def test_signed_followup_certifies_exact_historical_commits(self):
        first = self.commit("first unsigned change")
        second = self.commit("second unsigned change")
        recovery = self.recover(first, second)
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(first[:12], result.stdout)
        self.assertIn(second[:12], result.stdout)
        self.assertIn(recovery[:12], result.stdout)

    def test_recovery_does_not_cover_an_unlisted_commit(self):
        first = self.commit("first unsigned change")
        second = self.commit("second unsigned change")
        self.recover(first)
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn(second[:12], result.stderr)

    def test_unsigned_followup_cannot_certify_history(self):
        target = self.commit("unsigned change")
        self.commit("unsigned recovery\n\nDCO-Remediation: " + target)
        self.assertEqual(self.check().returncode, 1)

    def test_followup_must_carry_its_authors_own_signoff(self):
        target = self.commit("unsigned change")
        self.recover(target, signoff="Signed-off-by: Someone Else <else@example.com>")
        self.assertEqual(self.check().returncode, 1)

    def test_abbreviated_target_is_rejected(self):
        target = self.commit("unsigned change")
        self.recover(target[:12])
        self.assertEqual(self.check().returncode, 1)

    def test_empty_target_is_rejected(self):
        self.recover("")
        self.assertEqual(self.check().returncode, 1)

    def test_unrelated_branch_cannot_be_certified(self):
        self.git("checkout", "-b", "other")
        other = self.commit("other branch\n\n" + SIGNOFF)
        self.git("checkout", "main")
        self.recover(other)
        self.assertEqual(self.check().returncode, 1)

    def test_unknown_commit_is_rejected(self):
        self.recover("a" * 40)
        self.assertEqual(self.check().returncode, 1)

    def test_body_text_is_not_a_remediation_trailer(self):
        target = self.commit("unsigned change")
        self.commit(
            "discuss recovery\n\nDCO-Remediation: "
            + target
            + "\nThis is prose, not a trailer.\n\n"
            + SIGNOFF
        )
        self.assertEqual(self.check().returncode, 1)

    def test_trusted_base_history_is_still_excluded(self):
        self.base = self.commit("unsigned trusted baseline")
        self.commit("new signed change\n\n" + SIGNOFF)
        self.assertEqual(self.check().returncode, 0)

    def test_unsigned_merge_commit_is_still_skipped(self):
        self.git("checkout", "-b", "other")
        self.commit("other change\n\n" + SIGNOFF)
        self.git("checkout", "main")
        self.commit("main change\n\n" + SIGNOFF)
        self.git(
            "-c",
            "commit.gpgsign=false",
            "merge",
            "--no-ff",
            "other",
            "-m",
            "merge branches",
        )
        self.assertEqual(self.check().returncode, 0)
