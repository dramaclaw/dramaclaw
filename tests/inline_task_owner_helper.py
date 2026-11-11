"""Real lock-holder subprocess for inline task liveness tests."""

import json
import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

from novelvideo.project_context import ProjectContext


def task_context(root: Path) -> ProjectContext:
    return ProjectContext(
        project_id="project", project_name="demo", owner_type="user", owner_id="owner",
        owner_username="owner", requester_user_id="requester", requester_username="requester",
        requester_principals=(("user", "requester"),), effective_role="editor",
        home_node_id="local", output_dir=root / "output", state_dir=root,
        runtime_dir=root / "runtime", is_home_node=True,
    )


@contextmanager
def inline_owner_process(root: Path, status: str = "running"):
    script = """
import json
import sys
from pathlib import Path
import portalocker
from inline_task_owner_helper import task_context
from novelvideo import task_state

ctx = task_context(Path(sys.argv[1]))
owner_dir = ctx.state_dir / 'inline-owners'
owner_dir.mkdir(parents=True, exist_ok=True)
with (owner_dir / 'sibling.lock').open('a') as lock:
    portalocker.lock(lock, portalocker.LOCK_EX | portalocker.LOCK_NB)
    task_state.utc_now_iso = lambda: '2000-01-01T00:00:00.000000Z'
    manager = task_state.TaskStateManager()
    state, reserved = manager.reserve_task_for_project(
        ctx, 'freezone_workflow_drive', 0, scope='sibling',
        metadata={'backend': 'inline', 'inline_owner': 'sibling'},
    )
    if sys.argv[2] != 'submitting':
        manager.update_progress_for_project(
            ctx, 'freezone_workflow_drive', 0, scope='sibling', status=sys.argv[2],
        )
    print(json.dumps({'status': sys.argv[2], 'reserved': reserved}), flush=True)
    sys.stdin.read()
"""
    env = {**os.environ, "PYTHONPATH": "src:.:tests"}
    process = subprocess.Popen(
        [sys.executable, "-c", script, str(root), status], env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        line = process.stdout.readline()
        assert line, process.communicate(timeout=10)[1]
        assert json.loads(line) == {"status": status, "reserved": True}
        yield process
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=10)
