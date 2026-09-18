from __future__ import annotations

from dramaclaw_blender.core import http
from dramaclaw_blender.core.http import (
    CONTROL_TIMEOUT_SECONDS,
    TIMEOUT_SECONDS,
    ApiError,
    encode_multipart,
    get_json,
    post_json,
    post_multipart,
)


class _FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False

    def read(self):
        return b'{"ok": true}'


def _record_timeouts(monkeypatch) -> list[float]:
    seen: list[float] = []

    def fake_urlopen(request, timeout=None):
        seen.append(timeout)
        return _FakeResponse()

    monkeypatch.setattr(http.urllib.request, "urlopen", fake_urlopen)
    return seen


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


def test_a_quote_in_the_filename_cannot_close_the_content_disposition_param():
    body, _ = encode_multipart(
        fields={},
        filename='a".png',
        payload=b"x",
        mime="image/png",
    )

    header = body.split(b"\r\n\r\n", 1)[0]
    # 转义后引号只剩下界定参数的那三对（name="file" 两只，filename="..." 两只）。
    assert header.count(b'"') == 4
    assert b"%22" in header


def test_crlf_in_a_field_name_cannot_forge_a_header_line():
    body, _ = encode_multipart(
        fields={"camera\r\nX-Evil: 1": "cam"},
        filename="shot.png",
        payload=b"x",
        mime="image/png",
    )

    assert b"X-Evil: 1\r\n" not in body
    assert b"%0D%0A" in body


def test_crlf_in_a_field_value_cannot_forge_a_new_part():
    # camera 字段发的是 scene.camera.name 原文，用户爱写什么写什么。
    body, content_type = encode_multipart(
        fields={"camera": 'evil\r\nContent-Disposition: form-data; name="kind"\r\n\r\nvideo'},
        filename="shot.png",
        payload=b"x",
        mime="image/png",
    )

    boundary = content_type.split("boundary=", 1)[1].encode()
    # 两个 part（camera、file）加一个收尾，boundary 只该出现三次。
    assert body.count(b"--" + boundary) == 3
    # 注入的那串还在，但它前面已经没有裸 CRLF 了，解析器读到的是一段文本，
    # 而不是第三个 part 的 header。
    assert body.count(b"\r\nContent-Disposition") == 2
    assert b"%0D%0AContent-Disposition" in body


def test_ordinary_names_are_left_alone():
    body, _ = encode_multipart(
        fields={"camera": "Camera.001"},
        filename="blockout_Camera_frame_1_20260918163000.png",
        payload=b"x",
        mime="image/png",
    )

    assert b'name="camera"' in body
    assert b"Camera.001\r\n" in body
    assert b'filename="blockout_Camera_frame_1_20260918163000.png"' in body


def test_control_calls_do_not_hang_blender_for_ten_minutes(monkeypatch):
    # post_json / get_json 跑在主线程上（配对、拉项目列表），超时就是界面冻住的
    # 时长。服务器不可达但 TCP 挂着时，600 秒意味着 Blender 冻十分钟。
    seen = _record_timeouts(monkeypatch)

    post_json("http://example.invalid/x", {})
    get_json("http://example.invalid/x")

    assert seen == [CONTROL_TIMEOUT_SECONDS, CONTROL_TIMEOUT_SECONDS]
    assert CONTROL_TIMEOUT_SECONDS <= 30


def test_uploads_keep_the_long_timeout(monkeypatch):
    # 上传在后台线程里，慢不冻界面；几十上百 MB 本来就要传很久。
    seen = _record_timeouts(monkeypatch)

    post_multipart(
        "http://example.invalid/x",
        fields={"kind": "video"},
        filename="shot.mp4",
        payload=b"x",
        mime="video/mp4",
        token="t",
    )

    assert seen == [TIMEOUT_SECONDS]
    assert TIMEOUT_SECONDS >= 600


def test_an_explicit_timeout_wins(monkeypatch):
    seen = _record_timeouts(monkeypatch)

    get_json("http://example.invalid/x", timeout=1.5)

    assert seen == [1.5]
