from types import SimpleNamespace

import pytest

from novelvideo import video_billing


@pytest.mark.asyncio
async def test_probe_total_video_duration_sums_raw_durations_before_billing_rounding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    durations = {"a.mp4": 7.05, "b.mp4": 4.9}

    async def fake_probe(path: str) -> float:
        return durations[path]

    monkeypatch.setattr(video_billing, "probe_video_duration_seconds", fake_probe)

    assert await video_billing.probe_total_video_duration_seconds(
        ["a.mp4", "b.mp4"]
    ) == pytest.approx(11.95)


@pytest.mark.asyncio
async def test_probe_video_duration_rejects_non_finite_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        video_billing.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(
            returncode=0,
            stdout="Infinity\n",
            stderr="",
        ),
    )

    with pytest.raises(ValueError, match="positive"):
        await video_billing.probe_video_duration_seconds("broken.mp4")
