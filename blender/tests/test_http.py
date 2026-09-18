from __future__ import annotations

from dramaclaw_blender.core.http import ApiError, encode_multipart


def test_multipart_carries_the_file_bytes_verbatim():
    body, content_type = encode_multipart(
        fields={"kind": "image"},
        filename="shot.png",
        payload=b"\x89PNG\r\n\x1a\nbinary\x00bytes",
        mime="image/png",
    )

    assert b"\x89PNG\r\n\x1a\nbinary\x00bytes" in body
    assert content_type.startswith("multipart/form-data; boundary=")


def test_multipart_includes_every_field():
    body, _ = encode_multipart(
        fields={"kind": "video", "fps": "24"},
        filename="shot.mp4",
        payload=b"x",
        mime="video/mp4",
    )

    assert b'name="kind"' in body and b"video" in body
    assert b'name="fps"' in body and b"24" in body
    assert b'name="file"; filename="shot.mp4"' in body


def test_none_fields_are_dropped_not_sent_as_the_string_none():
    # 图片没有 fps。送 "None" 过去服务端会当成一个真值去 parse。
    body, _ = encode_multipart(
        fields={"kind": "image", "fps": None},
        filename="shot.png",
        payload=b"x",
        mime="image/png",
    )

    assert b'name="fps"' not in body
    assert b"None" not in body


def test_boundary_does_not_collide_with_the_payload():
    payload = b"--boundary-like-garbage--"
    body, content_type = encode_multipart(
        fields={}, filename="x.bin", payload=payload, mime="application/octet-stream"
    )

    boundary = content_type.split("boundary=", 1)[1].encode()
    assert payload.count(boundary) == 0


def test_api_error_keeps_the_status_and_the_server_message():
    error = ApiError(413, "上传超过 20MB 上限")

    assert error.status == 413
    assert "20MB" in str(error)
