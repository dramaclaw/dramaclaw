"""Guard the worker-slot construction against a keyword the slot no longer has.

This is the shape of bug the unit suite kept missing: `_WorkerSlot` dropped its
`authorization` field for a good security reason — a slot outlives the turn, so
keeping a real API key on it would let organisation A's credential still be
sitting there when B reused the worker — but `_spawn_locked` went on passing it.
Nothing failed until a worker was actually spawned, which no test did.

Checked statically rather than by spawning: the assertion is about the call
site agreeing with the dataclass, and a test that needs a real subprocess to
notice a TypeError is a test that will be skipped on the machine that matters.
"""
from __future__ import annotations

import ast
import dataclasses
import pathlib

from novelvideo.chat import hermes_pool

SOURCE = pathlib.Path(hermes_pool.__file__).read_text()


def _worker_slot_constructions() -> list[ast.Call]:
    return [node for node in ast.walk(ast.parse(SOURCE))
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_WorkerSlot"]


def test_every_worker_slot_construction_matches_the_dataclass():
    fields = {field.name for field in dataclasses.fields(hermes_pool._WorkerSlot)}
    constructions = _worker_slot_constructions()
    assert constructions, "no _WorkerSlot construction found — has it been renamed?"
    for call in constructions:
        passed = {keyword.arg for keyword in call.keywords if keyword.arg}
        unknown = passed - fields
        assert not unknown, (
            f"_WorkerSlot construction at line {call.lineno} passes {sorted(unknown)}, "
            f"which the dataclass does not declare")


def test_the_slot_never_stores_a_credential_bearing_authorization():
    """The security half of the same fact, stated so a revert is loud."""
    fields = {field.name for field in dataclasses.fields(hermes_pool._WorkerSlot)}
    assert "authorization" not in fields, (
        "a worker slot outlives the turn; storing the turn's authorization would "
        "leave one organisation's API key reachable while another reuses the worker")
    assert "gateway_api_key" not in fields
    assert "credential" not in fields
