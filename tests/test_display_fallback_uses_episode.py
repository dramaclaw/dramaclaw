"""Media display arguments are episodes, not BrainClaw trajectories.

The BrainClaw evidence plane renamed `episode_group_id` to
`trajectory_group_id`, and the rename leaked past the protocol boundary into
the media-display fallback: seven dictionary keys became `"trajectory"` while
the values still came from the `episode` variable.

Two failures follow, neither of which raises anything.

Inferring a display tool would emit `{"trajectory": N}`, which the real tool
does not accept — it requires `episode`. And reading a tool event that
correctly carries `episode=N` would find nothing under `"trajectory"` and fall
back to episode 1, so a user asking for episode 4 is shown episode 1. That is
worse than an error: it looks like it worked.

`trajectory` belongs only to the evidence, control-context and capability
layers, where it names an opaque HMAC group id. Here `episode` is a drama
episode number that a tool schema requires by that name.
"""
from __future__ import annotations

import pytest

from novelvideo.chat.service import _infer_display_tool_call_from_text


def _infer(text: str):
    result = _infer_display_tool_call_from_text(text, "", [])
    assert result is not None, f"no display tool inferred from {text!r}"
    return result


@pytest.mark.parametrize("text,expected_episode", [
    ("展示第 3 集草图", 3),
    ("看看第 5 集的草图", 5),
])
def test_inferring_a_sketch_tool_emits_episode(text, expected_episode):
    """The tool requires `episode`; a `trajectory` key would simply be rejected."""
    name, args = _infer(text)
    assert "trajectory" not in args, (
        f"{name} was given a trajectory argument; the tool schema requires "
        f"episode, so this call cannot succeed")
    assert args.get("episode") == expected_episode


def test_the_fallback_reads_its_episode_from_the_episode_key():
    """The quiet failure: the wrong episode shown, with nothing to signal it.

    Asserted on the source rather than by calling, because the reader is async
    and reaches the backend for real media. What decides the outcome is which
    key it reads, and reading `trajectory` where the event carries `episode`
    silently resolves to episode 1 — a user asking for episode 4 is shown
    episode 1, and nothing anywhere reports it.
    """
    import inspect

    import novelvideo.chat.service as service

    source = inspect.getsource(service._fallback_display_tool_ui_specs)
    assert 'args.get("episode")' in source, (
        "the fallback no longer reads the episode argument by name")
    assert 'args.get("trajectory")' not in source
    assert 'args["trajectory"]' not in source


def test_no_display_argument_is_named_trajectory():
    """A structural guard, so the next mechanical rename cannot repeat this.

    The leak was invisible in review because the variable kept its name: the
    lines read `"trajectory": episode`, which is correct-looking code carrying
    the wrong key.
    """
    import inspect

    import novelvideo.chat.service as service

    source = inspect.getsource(service)
    for offender in ('"trajectory": episode',
                     'args.get("trajectory")',
                     'args["trajectory"]'):
        assert offender not in source, (
            f'{offender!r} treats a drama episode as a BrainClaw trajectory; '
            f'trajectory belongs to the evidence and capability layers only')
