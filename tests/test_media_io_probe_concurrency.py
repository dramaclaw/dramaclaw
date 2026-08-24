"""ffprobe fan-out must stay bounded.

Reading one episode's beats probes every audio clip for its duration. Issued as
one unbounded ``gather``, a long episode forks one ffprobe per beat at once —
and since the probes run on the default thread pool, the burst also stalls every
other blocking call in the process until it drains.

The cap alone is not enough, so the timeout is pinned here too: a gate only
limits how many probes may hang at once, it cannot make a hung one let go.
"""

import asyncio
import subprocess
import weakref

import pytest

from novelvideo.utils import media_io


async def _run_with_cap(monkeypatch, cap: int, count: int) -> int:
    """Probe ``count`` paths under ``cap`` and report the observed peak overlap."""
    in_flight = 0
    peak = 0

    async def fake_probe(path: str) -> float:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        # Yield twice so every admitted probe is still in flight when the next
        # one starts: without a gate the whole batch would overlap.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        in_flight -= 1
        return 1.0

    monkeypatch.setattr(media_io, "get_audio_duration_async", fake_probe)
    monkeypatch.setattr(media_io, "_PROBE_CONCURRENCY", cap)
    # The gate is memoised per loop; drop any semaphore built before the patch.
    monkeypatch.setattr(media_io, "_probe_semaphores", weakref.WeakKeyDictionary())

    results = await media_io.get_audio_durations_async(
        [f"/tmp/beat_{i:03d}.mp3" for i in range(count)]
    )
    assert len(results) == count
    return peak


@pytest.mark.asyncio
async def test_probe_fan_out_never_exceeds_the_cap(monkeypatch):
    # Peak is asserted against the literal, not against the module constant:
    # reading the constant back makes the bound move with the implementation and
    # the assertion vacuous.
    assert await _run_with_cap(monkeypatch, 3, 64) == 3
    assert await _run_with_cap(monkeypatch, 8, 64) == 8


@pytest.mark.asyncio
async def test_a_batch_smaller_than_the_cap_runs_fully_parallel(monkeypatch):
    """闸门是上限不是队列——没超过上限的批次不该被串行化。"""
    assert await _run_with_cap(monkeypatch, 8, 5) == 5


def test_default_cap_is_small_enough_to_matter():
    """默认值得比线程池默认宽度小，否则这个闸门等于没装。"""
    assert 1 < media_io._PROBE_CONCURRENCY <= 16


@pytest.mark.asyncio
async def test_results_stay_aligned_and_one_bad_file_does_not_fail_the_batch(
    monkeypatch,
):
    async def fake_probe(path: str) -> float:
        if path.endswith("bad.mp3"):
            raise OSError("ffprobe exploded")
        return 1.5

    monkeypatch.setattr(media_io, "get_audio_duration_async", fake_probe)

    results = await media_io.get_audio_durations_async(
        ["a.mp3", "bad.mp3", "c.mp3"]
    )

    # Positional alignment is the contract: the caller zips these back onto beats.
    assert results == [1.5, None, 1.5]


@pytest.mark.asyncio
async def test_empty_input_probes_nothing(monkeypatch):
    async def fake_probe(path: str) -> float:  # pragma: no cover - must not run
        raise AssertionError("probed an empty batch")

    monkeypatch.setattr(media_io, "get_audio_duration_async", fake_probe)

    assert await media_io.get_audio_durations_async([]) == []


def test_the_cap_is_shared_across_requests_on_one_loop():
    """两个并发请求不该把上限翻倍——闸门按事件循环取，不是按调用取。"""

    async def scenario():
        first = media_io._probe_semaphore()
        second = media_io._probe_semaphore()
        assert first is second

    asyncio.run(scenario())


def test_each_event_loop_gets_its_own_gate():
    """信号量绑定首次 await 它的循环；进程里跑多个循环时不能共用一个。"""
    seen = []

    async def scenario():
        seen.append(media_io._probe_semaphore())

    asyncio.run(scenario())
    asyncio.run(scenario())

    assert seen[0] is not seen[1]


def test_the_probe_passes_a_finite_timeout_to_ffprobe(monkeypatch):
    """没有 timeout 的 ffprobe 在网络盘上可以永远挂着，闸门位置全被占死。"""
    seen: dict = {}

    def fake_run(cmd, **kwargs):
        seen.update(kwargs)
        return subprocess.CompletedProcess(cmd, 0, "3.5\n", "")

    monkeypatch.setattr(subprocess, "run", fake_run)

    assert media_io.get_audio_duration("/tmp/beat.mp3") == 3.5
    timeout = seen.get("timeout")
    assert timeout is not None, "ffprobe 必须带超时"
    assert 0 < timeout < 60


@pytest.mark.asyncio
async def test_a_timed_out_probe_reports_none_rather_than_a_made_up_duration(
    monkeypatch,
):
    """超时走批量接口的失败语义（None），而不是那个看起来很真的 5.0。"""

    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout", 0))

    monkeypatch.setattr(subprocess, "run", fake_run)

    assert await media_io.get_audio_durations_async(["/tmp/stalled.mp3"]) == [None]


def test_a_timed_out_probe_raises_instead_of_returning_the_fallback(monkeypatch):
    """单文件接口把超时抛出去：调用方要能区分"探测失败"和"探测到了但读不出来"。"""

    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout", 0))

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(subprocess.TimeoutExpired):
        media_io.get_audio_duration("/tmp/stalled.mp3")


def test_an_unreadable_answer_still_falls_back(monkeypatch):
    """5.0 的语义没变：ffprobe 答了、但答案解析不出来时仍然回落。"""

    def fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 0, "N/A\n", "")

    monkeypatch.setattr(subprocess, "run", fake_run)

    assert media_io.get_audio_duration("/tmp/weird.mp3") == 5.0


def test_the_worst_case_wall_time_is_bounded():
    """闸门 × 超时决定了一集 beats 最坏要等多久；两个都得是有限小值。"""
    assert 0 < media_io._PROBE_TIMEOUT_SECONDS <= 30
    worst_case = -(-40 // media_io._PROBE_CONCURRENCY) * media_io._PROBE_TIMEOUT_SECONDS
    assert worst_case <= 60
