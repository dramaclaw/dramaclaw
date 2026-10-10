from novelvideo.chat import service as chat_service


def test_merge_stream_text_keeps_repeated_delta_chunks():
    assert chat_service._merge_stream_text("已完成", "完成") == "已完成完成"
    assert chat_service._merge_stream_text("好。", "。") == "好。。"


def test_merge_stream_text_accepts_cumulative_updates():
    assert chat_service._merge_stream_text("首帧已", "首帧已完成") == "首帧已完成"


def test_suppresses_partial_labeled_transcript_replay_before_current_prompt():
    replay = "User: 之前的问题\nAssistant: 之前的回答\nUser: 另一条旧问题"

    assert (
        chat_service._strip_replayed_chat_response(
            replay,
            previous_assistant=[],
            current_prompt="现在的问题",
            suppress_partial_replay=True,
        )
        == ""
    )


def test_keeps_reply_after_current_prompt_in_replayed_transcript():
    replay = (
        "User: 之前的问题\n"
        "Assistant: 之前的回答\n"
        "User: 现在的问题\n"
        "Assistant: 这是新的回复"
    )

    assert (
        chat_service._strip_replayed_chat_response(
            replay,
            previous_assistant=[],
            current_prompt="现在的问题",
            suppress_partial_replay=True,
        )
        == "这是新的回复"
    )


def test_final_replay_strip_still_returns_unlabeled_content():
    assert (
        chat_service._strip_replayed_chat_response(
            "正常的新回复",
            previous_assistant=[],
            current_prompt="现在的问题",
        )
        == "正常的新回复"
    )


def test_strips_unlabeled_assistant_history_sequence_before_new_reply():
    previous = [
        "你好！有什么我可以帮你的吗？",
        "你好！我是 Hermes Agent，你的 AI 助手。",
    ]
    replay = "".join(previous) + "当前任务失败了，我建议先重试脚本生成。"

    assert (
        chat_service._strip_replayed_chat_response(
            replay,
            previous_assistant=previous,
            current_prompt="继续",
            suppress_partial_replay=True,
        )
        == "当前任务失败了，我建议先重试脚本生成。"
    )


def test_keeps_complete_repeated_short_reply_on_final_strip():
    assert (
        chat_service._strip_replayed_chat_response(
            "你好！有什么可以帮你？",
            previous_assistant=["你好！有什么可以帮你？"],
            current_prompt="你好",
            suppress_partial_replay=False,
        )
        == "你好！有什么可以帮你？"
    )


def test_suppresses_complete_repeated_short_reply_during_streaming():
    assert (
        chat_service._strip_replayed_chat_response(
            "你好！有什么可以帮你？",
            previous_assistant=["你好！有什么可以帮你？"],
            current_prompt="你好",
            suppress_partial_replay=True,
        )
        == ""
    )


def test_suppresses_truncated_unlabeled_assistant_replay():
    previous = [
        "上一批（Beat 10、11、12）的首帧已全部完成。"
        "已继续第 3 集下一批：Beat 13、14、15 的首帧已进入生成队列。\n\n"
        "首帧完成后我会继续剩余批次。需要推进时再说一声即可。"
    ]
    replay = (
        "上一批（Beat 10、11、12）的首帧已全部完成。"
        "已继续第 3 集下一批：Beat 13、14、15 的首帧已进入生成队列。\n\n首帧完"
    )

    assert (
        chat_service._strip_replayed_chat_response(
            replay,
            previous_assistant=previous,
            current_prompt="继续下一步",
        )
        == ""
    )
    assert (
        chat_service._strip_replayed_chat_response(
            replay,
            previous_assistant=previous,
            current_prompt="继续下一步",
            suppress_partial_replay=True,
        )
        == ""
    )


def test_keeps_short_reply_that_matches_start_of_previous_assistant_text():
    assert (
        chat_service._strip_replayed_chat_response(
            "上一批首帧完成",
            previous_assistant=["上一批首帧完成后，我会继续生成剩余批次。"],
            current_prompt="进度",
        )
        == "上一批首帧完成"
    )


def test_hermes_replay_history_is_bounded_to_latest_message_and_character_budget():
    contents = ["old", "latest" + "x" * chat_service._HERMES_REPLAY_HISTORY_MAX_CHARS]

    bounded = chat_service._bounded_replay_history(contents)

    assert len(bounded) == 1
    assert bounded[0].startswith("latest")
    assert len(bounded[0]) == chat_service._HERMES_REPLAY_HISTORY_MAX_CHARS


def test_replay_strip_accepts_precomputed_prefix_candidates():
    previous = ["上一轮回复"]
    candidates = chat_service._assistant_prefix_candidates(previous)

    assert (
        chat_service._strip_replayed_chat_response(
            "上一轮回复这是本轮回复",
            previous,
            "继续",
            assistant_prefix_candidates=candidates,
        )
        == "这是本轮回复"
    )


def test_hides_internal_skill_tool_events_from_chat_cards():
    assert chat_service._is_hidden_chat_tool_event(
        "skill",
        "→ skill view (dramaclaw)\n内容: Loading skill 'dramaclaw'",
    )
    assert not chat_service._is_hidden_chat_tool_event(
        "dramaclaw_pipeline_status",
        "→ dramaclaw_pipeline_status\ncompleted",
    )
