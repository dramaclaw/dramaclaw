"""Native Windows checks; also runnable with the packaged Python (no test dependencies)."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


@unittest.skipUnless(os.name == "nt", "Windows process and DACL APIs")
class WindowsAppServerBoundary(unittest.TestCase):
    def test_missing_socket_fails_without_waiting_for_startup_timeout(self):
        from novelvideo.chat.codex_app_server_windows import (
            connect_unix_socket,
            prepare_private_directory,
            private_control_root,
        )
        import time

        with tempfile.TemporaryDirectory(dir=private_control_root()) as root:
            private = Path(root) / "private"
            prepare_private_directory(private)
            started = time.monotonic()
            with self.assertRaises(OSError):
                connect_unix_socket(private / "missing.sock", 0.2)
            self.assertLess(time.monotonic() - started, 2)

    def test_socket_timeout_closes_the_native_handle(self):
        from novelvideo.chat import codex_app_server_windows as native

        stream = Mock()
        stream.fileno.return_value = 123
        winsock = Mock()
        winsock.connect.return_value = -1
        winsock.WSAGetLastError.return_value = 10035
        with (
            patch.object(native, "prepare_private_directory"),
            patch.object(native.ctypes, "WinDLL", return_value=winsock),
            patch.object(native.socket, "socket", return_value=stream),
            patch.object(native.select, "select", return_value=([], [], [])),
        ):
            with self.assertRaises(TimeoutError):
                native.connect_unix_socket(Path("C:/private/codex.sock"), 0.2)
        stream.close.assert_called_once()

    def test_pid_probe_does_not_terminate_process(self):
        from novelvideo.chat.codex_app_server_windows import pid_alive

        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        try:
            self.assertTrue(pid_alive(child.pid))
            self.assertTrue(pid_alive(child.pid))
            self.assertIsNone(child.poll())
        finally:
            child.terminate()
            child.wait(timeout=10)
        self.assertFalse(pid_alive(child.pid))
        self.assertFalse(pid_alive(0))

    def test_control_root_is_stable_across_processes(self):
        from novelvideo.chat.codex_app_server_windows import private_control_root

        local = str(private_control_root())
        peer = subprocess.check_output(
            [
                sys.executable,
                "-c",
                "from novelvideo.chat.codex_app_server_windows import private_control_root; "
                "print(private_control_root())",
            ],
            text=True,
        ).strip()
        self.assertEqual(local, peer)
        self.assertLess(
            len(os.fsencode(local + "/0123456789abcdef/app-server.sock")), 108
        )

    def test_existing_private_directory_is_accepted(self):
        from novelvideo.chat.codex_app_server_windows import prepare_private_directory

        with tempfile.TemporaryDirectory() as root:
            private = Path(root) / "private"
            prepare_private_directory(private)
            prepare_private_directory(private)

    def test_inherited_acl_is_rejected_without_repair(self):
        from novelvideo.chat.codex_app_server_windows import prepare_private_directory
        import win32security

        with tempfile.TemporaryDirectory() as root:
            unsafe = Path(root) / "inherited"
            unsafe.mkdir()
            info = (
                win32security.DACL_SECURITY_INFORMATION
                | win32security.OWNER_SECURITY_INFORMATION
            )
            before = win32security.ConvertSecurityDescriptorToStringSecurityDescriptor(
                win32security.GetFileSecurity(str(unsafe), info), 1, info
            )
            with self.assertRaisesRegex(RuntimeError, "not private"):
                prepare_private_directory(unsafe)
            after = win32security.ConvertSecurityDescriptorToStringSecurityDescriptor(
                win32security.GetFileSecurity(str(unsafe), info), 1, info
            )
            self.assertEqual(before, after)

    def test_junction_is_rejected(self):
        from novelvideo.chat.codex_app_server_windows import prepare_private_directory

        with tempfile.TemporaryDirectory() as root:
            target, junction = Path(root) / "target", Path(root) / "junction"
            prepare_private_directory(target)
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(junction), str(target)],
                check=True,
                capture_output=True,
            )
            with self.assertRaisesRegex(RuntimeError, "Unsafe"):
                prepare_private_directory(junction)


if __name__ == "__main__":
    unittest.main()
