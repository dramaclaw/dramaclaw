"""Process-local canvas observations expose independent numeric aggregates."""

from novelvideo.freezone import agent_canvas_metrics as metrics


def test_observations_aggregate_two_names_and_snapshots_are_independent():
    before = metrics.observations_snapshot()
    metrics.observe("test.canvas.duration", 2.5)
    metrics.observe("test.canvas.duration", 7.5)
    metrics.observe("test.canvas.frames", 3.0)
    after = metrics.observations_snapshot()
    for name, amount, total, maximum in (
        ("test.canvas.duration", 2, 10.0, 7.5),
        ("test.canvas.frames", 1, 3.0, 3.0),
    ):
        previous = before.get(name, {"count": 0, "total": 0.0, "max": maximum})
        assert after[name] == {
            "count": previous["count"] + amount,
            "total": previous["total"] + total,
            "max": max(previous["max"], maximum),
        }
    after["test.canvas.duration"]["count"] = -1
    assert metrics.observations_snapshot()["test.canvas.duration"]["count"] == (
        before.get("test.canvas.duration", {}).get("count", 0) + 2
    )
