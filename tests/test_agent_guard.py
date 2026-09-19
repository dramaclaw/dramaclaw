from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "agent_guard.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("agent_guard", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _git(root: Path, *args: str) -> str:
    process = subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return process.stdout.strip()


def _ledger(slug: str, baseline: str, status: str = "执行中") -> str:
    sections = (
        "目标",
        "非目标",
        "写入边界",
        "协调与冲突",
        "实施方案",
        "风险与回退",
        "验收标准",
        "进展记录",
        "已定下来的决策",
        "待办",
        "阻塞",
        "交接摘要",
    )
    body = "\n\n".join(f"## {section}\n\n内容" for section in sections)
    return (
        f"# {slug}\n\n**状态**：{status}\n**最后更新**：2026-09-18\n"
        f"**基线**：`{baseline}`\n\n{body}\n"
    )


def _make_repository(tmp_path: Path):
    agent_guard = _load_module()
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init")
    _write(root / "src" / "owned.py", "VALUE = 1\n")
    _git(root, "add", "src/owned.py")
    _git(
        root,
        "-c",
        "user.name=Agent Guard Test",
        "-c",
        "user.email=agent-guard@example.invalid",
        "commit",
        "-m",
        "initial",
    )
    baseline = _git(root, "rev-parse", "HEAD")
    slug = "sample-task"
    _write(
        root / "docs" / "agent" / "STATE.md",
        "\n".join(
            [
                "# STATE",
                "",
                "| 台账 | 主题 | 状态 | 下一步 |",
                "|---|---|---|---|",
                f"| [{slug}](tasks/{slug}.md) | Sample | 执行中 | test |",
                "",
            ]
        ),
    )
    ledger_path = root / "docs" / "agent" / "tasks" / f"{slug}.md"
    _write(ledger_path, _ledger(slug, baseline))
    manifest_path = root / "docs" / "agent" / "claims" / f"{slug}.toml"
    _write(
        manifest_path,
        "\n".join(
            [
                "version = 1",
                f'slug = "{slug}"',
                f'ledger = "docs/agent/tasks/{slug}.md"',
                f'baseline = "{baseline}"',
                "",
                "[[claims]]",
                'path = "docs/agent/STATE.md"',
                'mode = "coordination"',
                'reason = "Live index."',
                "",
                "[[claims]]",
                f'path = "docs/agent/tasks/{slug}.md"',
                'mode = "coordination"',
                'reason = "Task ledger."',
                "",
                "[[claims]]",
                f'path = "docs/agent/claims/{slug}.toml"',
                'mode = "exclusive"',
                'reason = "Task scope."',
                "",
                "[[claims]]",
                'path = "src/owned.py"',
                'mode = "exclusive"',
                'reason = "Owned implementation."',
                "",
            ]
        ),
    )
    _write(root / "src" / "owned.py", "VALUE = 2\n")
    model = agent_guard.load_repository(root, require_current_baseline=False)
    return agent_guard, root, slug, ledger_path, model


def test_claim_paths_reject_broad_or_unsafe_patterns() -> None:
    agent_guard = _load_module()

    assert agent_guard.normalize_claim_path("src/feature/**") == "src/feature/**"
    assert agent_guard.normalize_claim_path("src/feature.py") == "src/feature.py"
    for path in ("", ".", "/", "**", "src/*/file.py", "../outside.py"):
        with pytest.raises(agent_guard.GuardError):
            agent_guard.normalize_claim_path(path)

    assert agent_guard.require_owner("codex/session-123") == "codex/session-123"
    with pytest.raises(agent_guard.GuardError, match="client"):
        agent_guard.require_owner("anonymous")


def test_cross_task_shared_claims_must_be_mutual() -> None:
    agent_guard = _load_module()
    shared_a = agent_guard.Claim(
        "src/shared.py", "shared", frozenset({"task-b"}), "shared adapter"
    )
    shared_b = agent_guard.Claim(
        "src/shared.py", "shared", frozenset({"task-a"}), "shared adapter"
    )
    task_a = agent_guard.Workstream("task-a", "a.md", "abc1234", (shared_a,), Path("a"))
    task_b = agent_guard.Workstream("task-b", "b.md", "abc1234", (shared_b,), Path("b"))

    agent_guard.validate_cross_task_claims({"task-a": task_a, "task-b": task_b})

    unsafe_b = agent_guard.Workstream(
        "task-b",
        "b.md",
        "abc1234",
        (
            agent_guard.Claim(
                "src/shared.py", "shared", frozenset({"someone-else"}), "wrong peer"
            ),
        ),
        Path("b"),
    )
    with pytest.raises(agent_guard.GuardError, match="not mutual"):
        agent_guard.validate_cross_task_claims({"task-a": task_a, "task-b": unsafe_b})


def test_repository_check_fails_closed_for_unclaimed_dirty_file(tmp_path: Path) -> None:
    agent_guard, root, _slug, _ledger_path, _model = _make_repository(tmp_path)

    _write(root / "src" / "unclaimed.py", "VALUE = 3\n")

    with pytest.raises(agent_guard.GuardError, match="no workstream claim"):
        agent_guard.load_repository(root, require_current_baseline=False)


def test_lock_preflight_handoff_and_release(tmp_path: Path) -> None:
    agent_guard, root, slug, ledger_path, model = _make_repository(tmp_path)
    owner = "test-agent/session-1"

    agent_guard.acquire(model, slug, owner)
    agent_guard.preflight(model, slug, owner, ["src/owned.py"])
    with pytest.raises(agent_guard.GuardError, match="no writable claim"):
        agent_guard.preflight(model, slug, owner, ["src/not-owned.py"])
    with pytest.raises(agent_guard.GuardError, match="belongs to"):
        agent_guard.release(model, slug, "test-agent/other-session", force=False)

    _write(root / "src" / "owned.py", "VALUE = 3\n")
    with pytest.raises(agent_guard.GuardError, match="did not update its ledger"):
        agent_guard.handoff(model, slug, owner)
    with pytest.raises(agent_guard.GuardError, match="did not update its ledger"):
        agent_guard.release(model, slug, owner, force=False)

    with ledger_path.open("a", encoding="utf-8") as handle:
        handle.write("\n本会话记录：更新 owned.py 并完成验证。\n")
    claimed_dirty = agent_guard.handoff(model, slug, owner)
    assert "src/owned.py" in claimed_dirty

    agent_guard.release(model, slug, owner, force=False)
    assert not (root / ".agent-locks" / slug).exists()


def test_overlapping_active_locks_are_rejected(tmp_path: Path) -> None:
    agent_guard = _load_module()
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init")
    _write(root / "src" / "shared.py", "VALUE = 1\n")
    _write(root / "a.md", "task a\n")
    _write(root / "b.md", "task b\n")
    _git(root, "add", "src/shared.py", "a.md", "b.md")
    _git(
        root,
        "-c",
        "user.name=Agent Guard Test",
        "-c",
        "user.email=agent-guard@example.invalid",
        "commit",
        "-m",
        "initial",
    )
    baseline = _git(root, "rev-parse", "HEAD")
    claim_a = agent_guard.Claim(
        "src/shared.py", "shared", frozenset({"task-b"}), "shared"
    )
    claim_b = agent_guard.Claim(
        "src/shared.py", "shared", frozenset({"task-a"}), "shared"
    )
    stream_a = agent_guard.Workstream("task-a", "a.md", baseline, (claim_a,), Path("a"))
    stream_b = agent_guard.Workstream("task-b", "b.md", baseline, (claim_b,), Path("b"))
    ledgers = {
        "task-a": agent_guard.Ledger("task-a", root / "a.md", "执行中", baseline, ()),
        "task-b": agent_guard.Ledger("task-b", root / "b.md", "执行中", baseline, ()),
    }
    model = agent_guard.RepositoryModel(
        root,
        {"task-a": stream_a, "task-b": stream_b},
        ledgers,
        {"task-a": "执行中", "task-b": "执行中"},
        baseline,
    )

    agent_guard.acquire(model, "task-a", "test/owner-a")
    with pytest.raises(agent_guard.GuardError, match="already has writer"):
        agent_guard.acquire(model, "task-b", "test/owner-b")
    agent_guard.release(model, "task-a", "test/owner-a", force=False)


def test_blocked_task_can_lock_coordination_but_not_business_code(tmp_path: Path) -> None:
    agent_guard, root, slug, ledger_path, _model = _make_repository(tmp_path)
    baseline = _git(root, "rev-parse", "HEAD")
    _write(ledger_path, _ledger(slug, baseline, status="已阻塞"))
    state_path = root / "docs" / "agent" / "STATE.md"
    state_path.write_text(
        state_path.read_text(encoding="utf-8").replace("| 执行中 |", "| 已阻塞 |"),
        encoding="utf-8",
    )
    model = agent_guard.load_repository(root, require_current_baseline=False)
    owner = "audit-agent/session-1"

    agent_guard.acquire(model, slug, owner)
    agent_guard.preflight(model, slug, owner, [f"docs/agent/tasks/{slug}.md"])
    with pytest.raises(agent_guard.GuardError, match="not 执行中"):
        agent_guard.preflight(model, slug, owner, ["src/owned.py"])
    agent_guard.release(model, slug, owner, force=False)
