import json
from pathlib import Path

from novelvideo.chat import backend_sdk
from novelvideo.chat.runtime_port import AgentRuntimeThreadPort, ChatBackendEvent
from novelvideo.chat.tool_policy import (
    allows_mainline_media_ui_specs,
    freezone_canvas_execution_mode_from_context,
    freezone_canvas_id_from_context,
    tool_mode_for_surface,
)
from novelvideo.freezone.agent_catalog_schema import AgentCatalogRecipeConfig
from novelvideo.freezone.workflow_contract_generated import (
    AGENT_CREATABLE_NODE_TYPES,
    GENERATION_ACTION_TYPES,
    MODEL_ALIASES_BY_NODE_TYPE,
    RECIPE_ENVELOPE_CONTRACT,
    WORKFLOW_LINK_TYPES,
    WORKFLOW_NODE_TYPES,
)
from novelvideo.freezone.workflow_runs import GENERATION_ACTIONS
from novelvideo.freezone.workflow_schema import LINK_TYPE_VALUES, NODE_TYPE_VALUES

ROOT = Path(__file__).resolve().parents[1]


def test_stable_contract_drives_backend_workflow_enums() -> None:
    assert NODE_TYPE_VALUES == WORKFLOW_NODE_TYPES
    assert LINK_TYPE_VALUES == WORKFLOW_LINK_TYPES
    assert GENERATION_ACTIONS == set(GENERATION_ACTION_TYPES)


def test_stable_contract_recipe_fields_match_backend_validator() -> None:
    backend_required = set(AgentCatalogRecipeConfig.model_json_schema()["required"])
    assert set(RECIPE_ENVELOPE_CONTRACT["required"]) == backend_required


def test_stable_contract_aliases_are_scoped_to_creatable_nodes() -> None:
    assert set(MODEL_ALIASES_BY_NODE_TYPE).issubset(AGENT_CREATABLE_NODE_TYPES)
    assert all(
        alias and target
        for aliases in MODEL_ALIASES_BY_NODE_TYPE.values()
        for alias, target in aliases.items()
    )


def test_generated_mcp_fragment_matches_backend_contract() -> None:
    payload = json.loads(
        (ROOT / "src/novelvideo/chat/workflow_contract.generated.json").read_text()
    )
    properties = payload["properties"]
    assert properties["node_type"]["enum"] == WORKFLOW_NODE_TYPES
    assert properties["link_type"]["enum"] == WORKFLOW_LINK_TYPES
    assert properties["action"]["enum"] == GENERATION_ACTION_TYPES


def test_runtime_port_is_provider_neutral_and_backend_compatible() -> None:
    assert backend_sdk.AgentRuntimeThreadPort is AgentRuntimeThreadPort
    assert backend_sdk.ChatBackendEvent is ChatBackendEvent


def test_tool_policy_is_independent_of_prompt_markers() -> None:
    assert tool_mode_for_surface(None, prompt="[SUPERTALE_CANVAS_ROUTING]") == "default"
    assert tool_mode_for_surface("freezone") == "freezone_canvas"
    assert tool_mode_for_surface(
        None, surface_context={"freezone_canvas_id": "canvas-a"}
    ) == ("freezone_canvas")
    assert freezone_canvas_id_from_context({}) == "default"
    assert freezone_canvas_execution_mode_from_context({}) == "manual_confirm"
    assert not allows_mainline_media_ui_specs("freezone_canvas")
