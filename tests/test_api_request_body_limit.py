from __future__ import annotations

from starlette.requests import Request

from novelvideo.api.app import (
    MAX_REQUEST_BODY_BYTES,
    MAX_UPLOAD_REQUEST_BODY_BYTES,
    _request_body_limit,
)


def _multipart_request(path: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "http",
            "server": ("testserver", 80),
            "client": ("testclient", 50000),
            "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": b"",
            "headers": [(b"content-type", b"multipart/form-data; boundary=test")],
        }
    )


def test_generic_freezone_upload_uses_upload_body_limit() -> None:
    request = _multipart_request("/api/v1/projects/project-1/freezone/upload")

    assert _request_body_limit(request) == MAX_UPLOAD_REQUEST_BODY_BYTES


def test_reference_file_upload_uses_upload_body_limit() -> None:
    request = _multipart_request(
        "/api/v1/projects/project-1/freezone/reference-file-upload"
    )

    assert _request_body_limit(request) == MAX_UPLOAD_REQUEST_BODY_BYTES


def test_non_upload_request_keeps_default_body_limit() -> None:
    request = _multipart_request("/api/v1/projects/project-1/freezone/gen")

    assert _request_body_limit(request) == MAX_REQUEST_BODY_BYTES
