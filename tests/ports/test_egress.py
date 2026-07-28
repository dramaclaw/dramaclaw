from dataclasses import FrozenInstanceError

import pytest


def test_egress_operation_spec_is_frozen_and_validates_stable_identity():
    from novelvideo.ports.egress import EgressOperationSpec

    spec = EgressOperationSpec(
        operation_id="op_1",
        workflow_version="v1",
        stable_step_path="episode/1/beat/2/image",
        logical_sequence=1,
        input_digest="sha256:abc",
    )
    with pytest.raises(FrozenInstanceError):
        spec.logical_sequence = 2

    with pytest.raises(ValueError, match="stable_step_path"):
        EgressOperationSpec("op_2", "v1", "", 1, "sha256:abc")


def test_egress_result_reference_contains_no_credentials():
    from novelvideo.ports.egress import EgressResultReference

    assert "api_key" not in EgressResultReference.__dataclass_fields__
