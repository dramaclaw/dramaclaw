import os
import subprocess
import sys
from pathlib import Path
from textwrap import dedent


def test_novelvideo_info_logs_reach_stderr_by_default(tmp_path: Path) -> None:
    code = dedent('''
        import logging
        import novelvideo.api

        logging.getLogger("novelvideo.chat.service").info(
            "canvas_confirmation result=created id=c1 kinds=delete_nodes"
        )
        logging.getLogger("novelvideo.api.routes.freezone").info(
            "canvas_confirmation result=confirmed id=c1"
        )
        logging.getLogger("novelvideo.chat.service").debug("canvas_confirmation debug")
    ''')
    env = os.environ.copy()
    env["NOVELVIDEO_RUNTIME_DIR"] = str(tmp_path / "runtime")
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )

    assert result.returncode == 0, result.stderr
    assert [
        line.split(" ", 2)[2]
        for line in result.stderr.splitlines()
        if "canvas_confirmation" in line
    ] == [
        "INFO canvas_confirmation result=created id=c1 kinds=delete_nodes",
        "INFO canvas_confirmation result=confirmed id=c1",
    ]


def test_existing_root_handler_is_reused_not_duplicated(tmp_path: Path) -> None:
    code = dedent('''
        import logging
        import sys

        logging.basicConfig(stream=sys.stdout, format="%(levelname)s %(name)s %(message)s")
        import novelvideo.api

        logging.getLogger("novelvideo.chat.service").info(
            "canvas_confirmation result=created id=c1 kinds=delete_nodes"
        )
    ''')
    env = os.environ.copy()
    env["NOVELVIDEO_RUNTIME_DIR"] = str(tmp_path / "runtime")
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )

    assert result.returncode == 0, result.stderr
    assert [line for line in result.stdout.splitlines() if "canvas_confirmation" in line] == [
        "INFO novelvideo.chat.service canvas_confirmation result=created id=c1 kinds=delete_nodes"
    ]
    assert "canvas_confirmation" not in result.stderr
