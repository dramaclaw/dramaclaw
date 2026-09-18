from __future__ import annotations

from dramaclaw_blender.core.naming import (
    sanitize_camera_name,
    still_filename,
    video_filename,
)


def test_plain_camera_name_survives():
    assert sanitize_camera_name("Camera") == "Camera"


def test_path_separators_are_stripped():
    assert sanitize_camera_name("a/b\\c") == "a_b_c"


def test_dots_cannot_walk_up():
    assert sanitize_camera_name("..") == "camera"
    assert sanitize_camera_name("../../etc/passwd") == "camera"


def test_control_characters_are_stripped():
    # 末尾的换行先被 strip 掉，不会留下一个多余的下划线。
    assert sanitize_camera_name("Cam\x00era\n") == "Cam_era"


def test_non_ascii_falls_back_rather_than_mangling():
    # 中文相机名很常见。不硬转拼音，也不留原样——落到服务端会再被清洗一次，
    # 与其猜不如给个稳定的名字。
    assert sanitize_camera_name("主机位") == "camera"


def test_empty_name_falls_back():
    assert sanitize_camera_name("") == "camera"
    assert sanitize_camera_name("   ") == "camera"


def test_long_name_is_truncated():
    assert sanitize_camera_name("C" * 200) == "C" * 48


def test_still_filename_shape():
    assert (
        still_filename("Camera", 24, "20260918163000")
        == "blockout_Camera_frame_24_20260918163000.png"
    )


def test_video_filename_shape():
    assert (
        video_filename("Camera", 1, 250, "20260918163000")
        == "blockout_Camera_1-250_20260918163000.mp4"
    )


def test_filenames_use_the_sanitized_camera_name():
    assert still_filename("../evil", 1, "20260918163000").startswith("blockout_camera_")
