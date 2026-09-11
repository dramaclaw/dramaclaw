"""Parts of the state/output trees that file backups deliberately leave out."""

from __future__ import annotations

from pathlib import PurePath

# Cognee is deprecated. New backups skip each project's Cognee stores; copies already
# in OSS are kept, and the restore filter (RCLONE_FILTER) can still reach them.
DEPRECATED_COGNEE_DIRS = ("cognee_system", "cognee_data")

# Projects live at <user>/<project>/ or, for organizations, _orgs/<org>/<user>/<project>/.
_ORGS_DIR = "_orgs"

DEPRECATED_COGNEE_FILTER_RULES = tuple(
    rule
    for name in DEPRECATED_COGNEE_DIRS
    for rule in (f"- /*/*/{name}/**", f"- /{_ORGS_DIR}/*/*/*/{name}/**")
)


def is_deprecated_cognee_path(relative: str | PurePath) -> bool:
    """Match a path relative to the tree root the way DEPRECATED_COGNEE_FILTER_RULES do."""

    parts = PurePath(relative).parts
    if len(parts) > 3 and parts[2] in DEPRECATED_COGNEE_DIRS:
        return True
    return len(parts) > 5 and parts[0] == _ORGS_DIR and parts[4] in DEPRECATED_COGNEE_DIRS
