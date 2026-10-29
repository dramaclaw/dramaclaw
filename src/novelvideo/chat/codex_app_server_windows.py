"""Windows process liveness and private App Server rendezvous directories."""

from __future__ import annotations

import hashlib
from pathlib import Path

# uv --target does not execute pywin32.pth. Load its DLL bootstrap before win32api.
import pywintypes
import ntsecuritycon
import win32api
import win32con
import win32file
import win32process
import win32security


def current_user_sid():
    token = win32security.OpenProcessToken(
        win32api.GetCurrentProcess(), win32con.TOKEN_QUERY
    )
    try:
        return win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    finally:
        token.Close()


def private_control_root() -> Path:
    sid = win32security.ConvertSidToStringSid(current_user_sid())
    identity = hashlib.sha256(sid.encode("ascii")).hexdigest()[:12]
    # Stable across workers, and short enough for Windows AF_UNIX's 108-byte limit.
    path = Path(win32api.GetWindowsDirectory()) / "Temp" / f"dc-cx-{identity}"
    prepare_private_directory(path)
    return path


def prepare_private_directory(path: Path) -> None:
    """Match codex-uds's protected, inheritable, current-user-only DACL.

    Never repair an existing insecure directory: changing its ACL cannot revoke
    handles already held by another account.
    """

    sid = current_user_sid()
    sid_text = win32security.ConvertSidToStringSid(sid)
    attributes = pywintypes.SECURITY_ATTRIBUTES()
    attributes.SECURITY_DESCRIPTOR = (
        win32security.ConvertStringSecurityDescriptorToSecurityDescriptor(
            f"O:{sid_text}D:P(A;OICI;FA;;;{sid_text})", 1
        )
    )
    try:
        win32file.CreateDirectory(str(path), attributes)
    except pywintypes.error as exc:
        if exc.winerror != 183:  # ERROR_ALREADY_EXISTS
            raise

    handle = win32file.CreateFile(
        str(path),
        win32con.READ_CONTROL
        | ntsecuritycon.FILE_READ_ATTRIBUTES
        | ntsecuritycon.FILE_LIST_DIRECTORY,
        win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE,
        None,
        win32con.OPEN_EXISTING,
        win32con.FILE_FLAG_BACKUP_SEMANTICS | win32file.FILE_FLAG_OPEN_REPARSE_POINT,
        None,
    )
    try:
        flags = win32file.GetFileInformationByHandle(handle)[0]
        if (
            not flags & win32con.FILE_ATTRIBUTE_DIRECTORY
            or flags & win32con.FILE_ATTRIBUTE_REPARSE_POINT
        ):
            raise RuntimeError(f"Unsafe Codex App Server control directory: {path}")
        descriptor = win32security.GetSecurityInfo(
            handle,
            win32security.SE_FILE_OBJECT,
            win32security.OWNER_SECURITY_INFORMATION
            | win32security.DACL_SECURITY_INFORMATION,
        )
        owner = descriptor.GetSecurityDescriptorOwner()
        control, _revision = descriptor.GetSecurityDescriptorControl()
        dacl = descriptor.GetSecurityDescriptorDacl()
        trusted = (
            owner == sid
            and control & win32security.SE_DACL_PROTECTED
            and dacl is not None
            and dacl.GetAceCount() == 1
        )
        if trusted:
            (kind, inheritance), mask, trustee = dacl.GetAce(0)
            trusted = (
                kind == win32security.ACCESS_ALLOWED_ACE_TYPE
                and inheritance
                == win32con.OBJECT_INHERIT_ACE | win32con.CONTAINER_INHERIT_ACE
                and mask == ntsecuritycon.FILE_ALL_ACCESS
                and trustee == sid
            )
        if not trusted:
            raise RuntimeError(
                f"Codex App Server directory is not private to the current user: {path}"
            )
    finally:
        handle.Close()


def pid_alive(pid: int) -> bool:
    """Query the process; os.kill(pid, 0) terminates a Windows process."""

    if pid <= 0:
        return False
    try:
        handle = win32api.OpenProcess(0x1000, False, pid)
        try:
            return win32process.GetExitCodeProcess(handle) == 259  # STILL_ACTIVE
        finally:
            handle.Close()
    except pywintypes.error as exc:
        if exc.winerror == 87:  # ERROR_INVALID_PARAMETER: process no longer exists
            return False
        if exc.winerror == 5:  # A live process owned by a different account.
            return True
        raise
