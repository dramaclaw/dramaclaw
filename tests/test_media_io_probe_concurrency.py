"""ffprobe fan-out must stay bounded.

Reading one episode's beats probes every audio clip for its duration. Issued as
one unbounded ``gather``, a long episode forks one ffprobe per beat at once —
and since the probes run on the default thread pool, the burst also stalls every
other blocking call in the process until it drains.
"""

import asyncio
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
