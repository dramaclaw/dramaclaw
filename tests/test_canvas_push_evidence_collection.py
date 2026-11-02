"""Avoid reporting unavailable host counters as zero improvement."""
import importlib.util
from pathlib import Path


def collector():
    path = Path(__file__).resolve().parents[1] / "scripts/acceptance/collect_canvas_push_evidence.py"
    spec = importlib.util.spec_from_file_location("canvas_push_evidence", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_absent_device_and_proc_are_unavailable(tmp_path):
    module = collector()
    unavailable = module.linux_counters("sda", tmp_path)
    assert unavailable == {"cpu_ticks": None, "disk": None}
    assert module.delta(unavailable, unavailable) == {"host_cpu_busy_percent": None, "disk": None}


def test_counter_window_reports_host_cpu_and_selected_disk(tmp_path):
    module = collector()
    (tmp_path / "stat").write_text("cpu 10 0 5 80 5 0 0 0 0 0\n")
    (tmp_path / "diskstats").write_text("8 0 sda 10 0 100 0 20 0 200 0 0 30 0\n")
    before = module.linux_counters("sda", tmp_path)
    (tmp_path / "stat").write_text("cpu 20 0 10 160 10 0 0 0 0 0\n")
    (tmp_path / "diskstats").write_text("8 0 sda 11 0 120 0 22 0 240 0 0 35 0\n")
    result = module.delta(before, module.linux_counters("sda", tmp_path))
    assert result["host_cpu_busy_percent"] == 15
    assert result["disk"] == {"device": "sda", "read_sectors": 20, "write_sectors": 40, "io_ms": 5}
