from __future__ import annotations

from dramaclaw_blender.core.blockout import ffmpeg_settings, shading_settings


def test_shading_is_a_flat_light_grey_with_cavity_on():
    settings = shading_settings()

    assert settings["light"] == "STUDIO"
    assert settings["color_type"] == "SINGLE"
    assert settings["single_color"] == (0.8, 0.8, 0.8)
    # 没有 cavity，凸出来和凹进去的面是同一个灰，白模就白看了。
    assert settings["show_cavity"] is True


def test_video_carries_no_audio_track():
    settings = ffmpeg_settings()

    # Blender 默认会写一条静音音轨。留着它，投递上去的每段白模都白白多几百 KB。
    assert settings["audio_codec"] == "NONE"


def test_video_is_h264_in_mp4():
    settings = ffmpeg_settings()

    assert settings["format"] == "MPEG4"
    assert settings["codec"] == "H264"


def test_settings_are_fresh_objects_each_call():
    # 调用方会把它们直接往 bpy 的属性上灌，共享可变对象迟早出事。
    assert shading_settings() is not shading_settings()
    assert ffmpeg_settings() is not ffmpeg_settings()
