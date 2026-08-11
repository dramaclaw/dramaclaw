"""OI-48 块⑥：整批语音的退款正确性压在一条没人守护的隐含不变量上。

链路：`indextts2_fal.py` 判 `ORG_EGRESS_DENIED`
  → `indextts2_beat_audio_task.py:596 raise`
  → `:622` 吞进 `result.failed`
  → `task_backend/runners/audio.py:106` 只在 `generated == 0 and failed` 时抛
  → `task_backend/run_core.py:721` 退回本次特性积分预留。

也就是说**只有整批全灭才退款**。今天全灭是因为 `ORG_EGRESS_DENIED` 是
(context, provider) 的性质、对每个 beat 齐一——安全是撞上的，不是设计的。
一旦出现「部分 beat 被拒、部分成功」，`generated > 0` 就绕开 `:106`，被拒部分
的积分无声白扣。

本文件钉住这条不变量本身，不改退款逻辑：齐一性一旦被破坏，测试转红并指向
退款缺口。缺口的修复另立 OI 条目。
"""

from __future__ import annotations

import inspect

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference


def _organization_context() -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-1",
        project_id="project-1",
        task_type="beat_audio",
        requester_user_id="user-1",
        root_task_id="root-task-1",
        admission_id="admission-1",
        admitted_at="2026-08-11T00:00:00Z",
        membership_id="membership-1",
        authz_version=7,
        billing_principal=BillingPrincipal(kind="organization", id="org-1"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-1",
            key_version=3,
            org_id="org-1",
        ),
    )


@pytest.mark.asyncio
async def test_org_denial_is_uniform_across_beat_level_inputs(tmp_path) -> None:
    """齐一性的来源：拒绝只取决于 (context, provider)，与 beat 级输入无关。

    两者在一次整批生成里恒定，所以拒绝对每个 beat 齐一，`generated` 必为 0，
    `runners/audio.py:106` 因而总能触发退款。若哪天判据开始读 beat 级输入
    （文本、声线、输出路径），齐一性即告破裂，这条断言会转红——那时
    `generated > 0` 会绕开退款条件。
    """

    from novelvideo.generators.indextts2_fal import IndexTTS2FalClient

    # provider 与组织身份不符 → 组织必须被拒。
    client = IndexTTS2FalClient(provider="fal", egress_context=_organization_context())

    verdicts = []
    for index, text in enumerate(("hello", "a much longer line of dialogue", "")):
        result = await client.generate(
            prompt=text,
            audio_url=f"https://example.invalid/voice-{index}.wav",
            output_path=tmp_path / f"beat-{index}.mp3",
            emotion_prompt="calm" if index % 2 else "",
        )
        verdicts.append((result.success, result.error))

    assert verdicts == [(False, "ORG_EGRESS_DENIED")] * 3


def test_refund_requires_the_whole_batch_to_fail() -> None:
    """把「只有全灭才退款」这条实际条件钉下来，别让它看起来像「失败就退款」。"""

    from novelvideo.task_backend.runners import audio

    source = inspect.getsource(audio)
    assert "if result.generated == 0 and result.failed:" in source


@pytest.mark.asyncio
async def test_denied_batch_reports_zero_generated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """行为面：组织整批被拒时 `generated == 0`，退款条件成立。"""

    from novelvideo.audio import indextts2_beat_audio_task as task
    from novelvideo.generators.tts_generator import TTSResult

    class _DeniedClient:
        async def generate(self, **kwargs: object) -> TTSResult:
            return TTSResult(success=False, error="ORG_EGRESS_DENIED")

    beats = [
        {"beat_num": 1, "speaker": "A", "dialogue": "hello"},
        {"beat_num": 2, "speaker": "B", "dialogue": "world"},
    ]

    class _Store:
        project_dir = "/tmp/oi48-refund"
        db_path = "/tmp/oi48-refund/db.sqlite"

        async def get_beats_as_dicts(self, episode: int) -> list[dict[str, object]]:
            return list(beats)

    result = await task.run_indextts2_beat_audio_generation(
        store=_Store(),
        username="user-1",
        project="project-1",
        episode=1,
        beat_numbers=[1, 2],
        generator=_DeniedClient(),
        egress_context=_organization_context(),
    )
    assert result.generated == 0
