from novelvideo.freezone.audio_node import VoicePrerequisiteError
from novelvideo.task_backend.run_core import _project_task_failure_for_exception


def test_voice_prerequisite_is_a_handled_project_task_failure() -> None:
    exc = VoicePrerequisiteError("项目解说人声线未配置")

    message, payload, handled = _project_task_failure_for_exception(exc)

    assert message == "项目解说人声线未配置"
    assert payload == {"error_code": "voice_prereq_required"}
    assert handled is True
