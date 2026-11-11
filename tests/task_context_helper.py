"""A real project context for task-state and workflow recovery tests."""

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
