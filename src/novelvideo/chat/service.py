"""AI chat service with project-scoped history and agent runtime state."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import importlib.util
import json
import logging
import os
import re
import shutil
import sqlite3
import stat
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote, unquote, urlparse
from urllib.request import Request, urlopen

from novelvideo.chat.backend_sdk import (
    AgentRuntimeThreadPort,
    ClaudeSdkClient,
    CodexClient,
    _codex_item_completed_trace,
    _codex_item_started_trace,
    _codex_unwrap_item,
    control_codex_runtime,
    interrupt_live_claude_client,
    interrupt_live_codex_turn,
)
from novelvideo.ports import get_auth_session_port
from novelvideo.sqlite_pragmas import configure_sqlite_connection
from novelvideo.utils.error_redaction import redact_secrets
from novelvideo.utils.static_urls import project_static_url

logger = logging.getLogger("novelvideo.chat.service")

_MEDIA_EXTENSIONS = {
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".gif": "image",
    ".mp4": "video",
    ".mov": "video",
    ".webm": "video",
    ".wav": "audio",
    ".mp3": "audio",
    ".m4a": "audio",
}
_URL_RE = re.compile(r"(https?://[^\s)>\"]+|/static/[^\s)>\"]+)")
_REL_PATH_RE = re.compile(
    r"(?P<path>(?:assets|videos|audio|images|frames|sketches|grids|uploads|scripts)/[^\s)>\"]+\.(?:png|jpg|jpeg|webp|gif|mp4|mov|webm|wav|mp3|m4a))"
)
_MARKDOWN_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
_USER_TURN_LABEL_RE = re.compile(r"(?im)^\s*(?:user|human|用户|我)\s*[:：]\s*")
_ASSISTANT_TURN_LABEL_RE = re.compile(
    r"(?i)^\s*(?:assistant|ai|助手|助理|模型)\s*[:：]\s*"
)
_UI_SPEC_BLOCK_RE = re.compile(
    r"<ui-spec\b[^>]*>(.*?)</ui-spec>", re.IGNORECASE | re.DOTALL
)
_UI_SPEC_FENCE_RE = re.compile(
    r"```(?:json-render|ui-spec|json)?\s*(<ui-spec\b[\s\S]*?</ui-spec>)\s*```",
    re.IGNORECASE,
)
_LOCAL_FILESYSTEM_PATH_RE = re.compile(
    r"(?<![\w./-])(?:~|/Users/[^\s`'\"<>)]+)(?:/[^\s`'\"<>)]+)+"
)
_CHAT_RUN_LOCK_KEY = "active_chat_run"
_CHAT_RUN_LOCK_TTL_SECONDS = 10 * 60
_CHAT_RUN_LOCK_MAX_SECONDS = 60 * 60
_CHAT_RUN_LOCK_HEARTBEAT_SECONDS = 30.0
_CHAT_RUN_LOCK_BIRTH_GRACE_SECONDS = 5.0
_HERMES_REPLAY_HISTORY_MESSAGES = 1
_HERMES_REPLAY_HISTORY_MAX_CHARS = 64_000
_CODEX_MODEL_PROVIDER = "dramaclaw_gateway"
_DEFAULT_CODEX_MODEL = "DC-codex-agent-LLM"
_DEFAULT_CODEX_REASONING_EFFORT = "medium"
_CODEX_REASONING_EFFORT_VALUES = frozenset(
    {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
)
_CODEX_GATEWAY_BASE_URL_ENV = "DRAMACLAW_CODEX_GATEWAY_BASE_URL"
_CODEX_PER_TURN_CREDENTIAL_PLACEHOLDER = "dramaclaw-codex-per-turn-placeholder"
_CODEX_GATEWAY_KEY_METADATA = "dramaclaw_gateway_api_key"
_CODEX_CONTROL_CAPABILITY_METADATA = "dramaclaw_control_context_capability"
_ACTIVE_CODEX_TURNS: dict[tuple[str, str], tuple[str, str]] = {}
_ACTIVE_CODEX_TURNS_LOCK = threading.Lock()
_CODEX_DEVELOPER_INSTRUCTIONS = (
    "You are the DramaClaw creative assistant. Use the required dramaclaw MCP "
    "server for all DramaClaw data reads and writes. Use the concrete business tools "
    "listed by the server and their native input schemas. Do not guess a tool name or "
    "argument schema. Do not use shell commands, "
    "local file editing, web search, or other external tools."
)
_CODEX_FREEZONE_DEVELOPER_INSTRUCTIONS = (
    "You are the DramaClaw creative assistant inside the Xi画/Freezone canvas. "
    "If the user asks you to write or return text, copy, a screenplay, or Beats but does not "
    "explicitly ask to create/add/land nodes or a workflow on the canvas, answer in chat. Do not "
    "search Workflow Skills and do not call a canvas write tool merely because the requested "
    "content mentions images, audio, or video. "
    "Use the concrete tools currently listed by the required dramaclaw MCP server. "
    "Freezone tools are exposed directly with names such as freezone_emit_canvas_command. "
    "For any workflow, several connected nodes, grouped stages, storyboard, or media pipeline, "
    "load and follow the project Agent Skill named dramaclaw-workflows. Read that Skill only from "
    "the exact file URI advertised in the available Skills or dramaclaw resources; never invent a "
    "project:// Skill URI. "
    "Never probe guessed HTTP API paths such as /agent-skills, /skills, or /workflows/skills with "
    "dramaclaw_get. For workflow discovery use workflow_catalog_search on dramaclaw_workflows; "
    "read only the returned workflow resource URI or call freezone_get_workflow_skill as its "
    "documented fallback, then stop reading and author the plan. "
    "The Agent Skill package name dramaclaw-workflows is not a Workflow catalog skill_id: never "
    "pass dramaclaw-workflows to workflow_skill_get, freezone_get_workflow_skill, or an intent's "
    "skill_id. Select the matching production Workflow Skill returned by the catalog instead "
    "(for example text-to-image-video for a general image/video pipeline). "
    "The current canvas summary is already injected in SUPERTALE_CANVAS_ONTOLOGY_SUMMARY: use it "
    "directly, never request a canvas:// resource, and call "
    "freezone_get_canvas_ontology only when a fresher or more detailed view is actually required. "
    "Use the high-level "
    "workflow draft/graph tools; never use freezone_emit_canvas_command for a workflow and never "
    "fall back to repeated single-node or single-edge tools after an error. "
    "For a normal workflow request, follow that Skill's discovery, draft, preview, and confirmation "
    "sequence. When the user explicitly specifies exact nodes and dependencies, follow the Skill's "
    "custom-topology reference and call freezone_prepare_workflow_plan_draft once instead; do not "
    "route that request through the compact Intent compiler merely because a "
    "production Skill matches. Explicit Beat, shot, node-count, or dependency requirements must "
    "remain one complete WorkflowPlan even when they exceed the compact planner limit. Copy exact "
    "user totals into expected_node_count and expected_node_counts. For episodic short-drama, Beat, "
    "voice-over, or background-music workflows, prefer the short-drama production Skill over the "
    "generic text-to-image-video Skill. After any validation error, never submit a reduced sample, "
    "smoke test, or placeholder graph such as A/B or T1/T2 to the real canvas; diagnose with the "
    "read-only compiler only by compiling that same complete graph, preserving all nodes and "
    "dependency edges. Never compile reduced probe nodes or use edges=[] for a multi-node plan. "
    "The Agent owns graph completeness: before submission, verify that every plan node belongs to "
    "one undirected connected component. For independent Beat/shot branches that must preserve "
    "failure isolation, add a non-executable common input root and fan it out to each branch input; "
    "do not ask the user to specify this internal topology and do not serialize sibling branches. "
    "Resolve unknown edge compatibility from freezone_get_link_type_catalog once; never guess link "
    "types through repeated compiler calls. Do not use workflow_graph_compile as routine preflight "
    "before the first graph write. After a recovery compile succeeds, immediately submit that exact "
    "corrected Plan with freezone_prepare_workflow_plan_draft instead of stopping at compile success. "
    "Correct the same complete plan once, then report the blocking error. The "
    "failure result must come from the current turn: historical failures are diagnostic context, "
    "not proof that the current adapter remains blocked. When the user repeats the create/run "
    "request or asks to retry after a restart, submit the same complete workflow write once in "
    "that turn instead of repeating an old blocking conclusion. The "
    "user's explicit imperative to create or run is authorization to submit the protected canvas "
    "write and display its approval surface. Never ask for a duplicate 'create and run' confirmation, "
    "and never claim that the environment cannot display an approval card: the Freezone write tool "
    "creates that card. In auto_execute mode the frontend applies the normal approval event, so once "
    "required generation parameters are known, call the write tool immediately. For structured "
    "clarification, call only the dramaclaw MCP tool freezone_request_user_clarification; never use "
    "the built-in request_user_input tool. Never call create_goal for a canvas request. For a "
    "workflow confirmation or graph call with run_after_create=true, that same approved batch is "
    "the one and only run request. If its result says accepted or reports a run_workflow command, "
    "never call freezone_run_workflow again in the same turn. "
    "Only a later explicit user retry after a terminal failure may start another run. For a "
    "Freezone speech uses custom/reference voices only and must never use a preset/system voice. "
    "Preserve a valid voiceRef. If no valid custom voice is selected, skip that audio node without "
    "submitting TTS and continue the remaining workflow. Never choose the first available voice or "
    "call open_voice_picker unless the user explicitly requests voice selection. "
    "request whose actual next step will generate image or video media, inspect the user's message, "
    "the selected Recipe, and existing target-node data before any canvas write. Obey the injected "
    "FREEZONE_CANVAS_EXECUTION_MODE contract for whether a fresh preliminary parameter selection is "
    "required; do not infer that policy from conversation history. When that contract requires a "
    "selection, call freezone_request_user_clarification once for the current request. "
    "Image choices are model preference, aspect "
    "ratio, resolution/quality, and variants per node. Video choices are model or generation mode, aspect "
    "ratio, resolution, duration, sound generation, and variants per node. Offer a recommended/default "
    "choice for each relevant field. Never include an audio voice-source question in this preliminary "
    "clarification: do not ask the user to choose system voice versus custom voice. Freezone speech "
    "uses an already selected custom voiceRef or skips generation when none is selected. "
    "Never bundle these fields into one preset such "
    "as 'recommended settings'. Use one clarification question per missing field with the portable "
    "field name as its question id. Before asking, inspect the live node create schema once for each "
    "relevant image/video type and use its exact options; video_resolution must show every supported "
    "value, including 480P whenever the selected/live model supports it. Do not write, approve, or start the workflow "
    "until the answer is returned. This rule applies to generation or run requests, including "
    "run_after_create=true; it does not apply when the user only asks to create empty nodes, connect, "
    "group, lay out, or edit them without generation. It is an explicit exception to any general "
    "instruction not to ask about model parameters, and it applies only to image and video for now. "
    "Store confirmed shared choices in workflow intent.inputs using portable image_model, "
    "image_aspect_ratio, image_resolution, image_quality, image_variants_per_node, video_model, "
    "video_aspect_ratio, video_resolution, video_duration_seconds, video_generate_audio, and "
    "video_variants_per_node keys. The Skill-specific image_count/video_count fields describe "
    "workflow deliverable or node counts and must never be copied to a node's data.count. If a "
    "canvas write returns code=generation_parameters_required, never retry unchanged. Follow the "
    "injected execution-mode contract to collect or populate the returned fields, then retry the "
    "same plan. A "
    "recommended/default model choice is symbolic: serialize "
    'it as model="recommended" (or the matching portable intent input), not as an invented model '
    "id. The authorized adapter resolves it through the live frontend default. If a complete graph "
    "write fails, do not regenerate or truncate the whole plan merely to replace that sentinel. "
    "For a "
    "standalone canvas mutation, your first assistant action must be the matching "
    "freezone write tool call. Never claim that a canvas operation succeeded unless that same "
    "tool call returned a successful frontend canvas result. The built-in update_plan tool only "
    "records an internal plan and never changes the canvas: do not call it for canvas mutations "
    "and never treat it as completion. Do not use shell commands, local file editing, web search, "
    "or other external tools."
)

# A resumed App Server thread retains the MCP tool catalog and environment from
# when it was created. Bump this value whenever the Freezone MCP exposure or
# browser-bridge contract changes so canvas turns cannot silently resume a
# thread that predates the required concrete write tools. Mainline thread keys
# intentionally remain unchanged.
_CODEX_FREEZONE_THREAD_PROTOCOL_VERSION = "canvas-workflows-v15"


def _codex_developer_instructions(tool_mode: str | None) -> str:
    if str(tool_mode or "").strip() == "freezone_canvas":
        return _CODEX_FREEZONE_DEVELOPER_INSTRUCTIONS
    return _CODEX_DEVELOPER_INSTRUCTIONS


_REINGEST_CONFIRMATION_BLOCK_RE = re.compile(
    r"\[DRAMACLAW_REINGEST_CONFIRMATION\](.*?)\[/DRAMACLAW_REINGEST_CONFIRMATION\]",
    re.DOTALL,
)
_REINGEST_CANCELLED_BLOCK_RE = re.compile(
    r"\[DRAMACLAW_REINGEST_CANCELLED\](.*?)\[/DRAMACLAW_REINGEST_CANCELLED\]",
    re.DOTALL,
)
_CHAT_ATTACHMENTS_BLOCK_RE = re.compile(
    r"\[CHAT_ATTACHMENTS\].*?\[/CHAT_ATTACHMENTS\]",
    re.DOTALL,
)
_DRAMACLAW_INGEST_AUTOMATION_RE = re.compile(
    r"\[DRAMACLAW_(?:INGEST_AUTOMATION|REINGEST_CONFIRMATION|UPLOADED_FILES)\]",
)
_SCRIPT_CREATION_REQUEST_RE = re.compile(
    r"(?:帮我|给我|请|想要|我要|创建|生成|写|做|制作|创作|起草|来一个|出一个)"
    r"[\s\S]{0,40}(?:剧本|短剧|短片剧本|短视频剧本|网剧)",
    re.IGNORECASE,
)
_STYLE_SHORT_DRAMA_REQUEST_RE = re.compile(
    r"(?:[\w\u4e00-\u9fff]+风格|主题|题材|赛博朋克|末世|复仇|女总裁|玄幻|都市|悬疑)"
    r"[\s\S]{0,30}(?:短剧|短片剧本|短视频剧本|网剧)",
    re.IGNORECASE,
)
_CONTINUE_PIPELINE_RE = re.compile(
    r"(?:继续|恢复|接着|下一步|当前|已有|已上传|刚才上传)"
)
_EXPLICIT_PIPELINE_CONTINUATION_RE = re.compile(
    r"(?:继续|恢复|接着(?:做|生成|制作)?|下一步|继续跑|继续做)",
    re.IGNORECASE,
)
_PIPELINE_CONTINUATION_QUESTION_RE = re.compile(
    r"(?:为什么|为何|怎么|如何|能否|是否|可不可以|不能|失败|报错|什么情况|什么意思)"
)
_DRAMACLAW_CONTINUATION_INSTRUCTIONS = """[DRAMACLAW_CONTINUATION]
The user explicitly authorizes continuing the bound mainline project from its current breakpoint.
Read the episode pipeline status at most once and read active tasks at most once. If an active task
exists, report it and stop. If no task is active, use next_step to start exactly one matching write
task in this same turn, then stop. Do not reread identical status, ask the user to repeat "继续",
or reopen run-mode selection. For next_step=selected_regen, call dramaclaw_render_first_frames once
without beat_indices so it selects the next missing batch.
[/DRAMACLAW_CONTINUATION]"""
_DRAMACLAW_SCRIPT_UPLOAD_MODEL_REPLY_INSTRUCTIONS = """[DRAMACLAW_SCRIPT_UPLOAD_GUIDANCE]
用户正在请求创建、生成或编写剧本/短剧，但当前消息没有上传剧本文档。

你必须只用自然中文回复用户，不要调用任何工具，不要创建项目，不要生成剧本，不要构造基础脚本，不要启动摄入或流水线。

回复目标：
- 语气自然，不要像系统错误提示。
- 明确表达：虾导不提供生成剧本功能。
- 引导用户去“虾料”上传已有剧本文档。
- 说明上传后你可以继续帮他推进分集、画面、配音、成片等后续制作。
- 只回复 1-2 句，不要列步骤，不要输出 markdown 标题。
[/DRAMACLAW_SCRIPT_UPLOAD_GUIDANCE]
"""
_HIDDEN_TOOL_MARKERS = (
    "skill_view",
    "skills_list",
    "skill view",
    "skills list",
    "loading skill",
    "→ skill view",
    "→ skills list",
)
_JSON_RENDER_CHAT_INSTRUCTIONS = """[RENDERING_CONTRACT]
这是硬性输出合同，优先级高于普通叙述习惯。违反时必须自我修正后再回复。

触发条件：
- 只有在回复需要展示图片、肖像、身份图、草图、首帧、视频、音频等可视/可播放媒体时，才需要调用对应的 DramaClaw 展示工具。
- 角色列表、剧集规划、项目进度、任务状态、脚本/beat 摘要、表格、长篇正文、普通结构化说明默认使用 markdown；如果没有图片/视频/音频媒体，不要使用媒体展示工具。
- 用户说“继续生成视频”“恢复”“接着做”“下一步”时，只推进未完成任务并汇报本轮状态。
- 除非用户同时明确要求展示、查看、播放或预览，否则不要读取或展示此前已经生成的 beat 视频。
  最终成片在本轮完成时仍按成片交付规则主动展示。

禁止事项：
- 不要向用户解释内部渲染格式、渲染机制、工具调用过程或工具名；只给业务结果和必要的下一步提示。
- 不要为纯文本、进度、脚本、表格、角色/剧集清单调用媒体展示工具；这些内容使用 markdown。
- 用户要求查看图片、肖像、身份图、草图、首帧、视频、音频时，不要用文字列表、文件名列表、Beat 名称列表或 URL 列表替代媒体展示；必须调用对应展示工具。若没有工具返回的可展示媒体，只说明当前暂无可展示媒体。
- 一旦本轮调用了媒体展示工具，最终自然语言回复只能是简短说明，绝对禁止输出 markdown 图片语法（例如 ![标题](url)）、纯文本媒体 URL、任何 http/https 链接、/static 路径、HTML <img>/<video>/<audio> 标签或聊天附件 media_json。
- 不要猜测、拼接或改写静态资源路径，尤其禁止自行编造 /static/projects/{project_id}/...、/static/admin/{slug}/...、localhost URL 或下载地址。

资源 URL 规则：
- 展示工具会读取 API 返回的可访问 URL 字段（portrait_url、image_url、sketch_url、frame_url、video_url、audio_url、url）并准备可展示媒体。
- 如果工具/API 只返回本地文件路径或你不确定 URL 是否可访问，必须先调用相应 DramaClaw 展示工具；不能自己按经验拼 /static 路径。
- 如果没有正式结果 URL、URL 为空、或资源尚未生成，只说明当前状态，不要伪造媒体展示。
- 如果工具/API 返回多个候选字段，优先使用明确的 *_url 字段；不要使用 *_path 作为 src，除非 API 明确说明该 path 已是浏览器可访问 URL。

展示工具选择：
- 角色肖像/身份图：调用 dramaclaw_get_character_media。
- 当前草图：调用 dramaclaw_get_sketches，只展示正式 sketch_url。草图候选池：调用 dramaclaw_get_sketch_candidates，只展示 grids/epNNN/sketch/beat_XX_t* 候选。首帧：调用 dramaclaw_get_first_frames，只展示首帧。
- 场景图：调用 dramaclaw_get_scene_images。
- 视频预览、beat 视频、最终成片：调用 dramaclaw_get_episode_media(media_type="video") 或对应最终视频读取工具。
- 配音/TTS/音乐：调用 dramaclaw_get_episode_media(media_type="audio") 或对应音频读取工具。
- 指定人物肖像：调用 dramaclaw_get_character_media(media_kind="portrait", name="角色名或名称片段")；name 只匹配角色名/别名，不要混入身份图。
- 指定身份图：调用 dramaclaw_get_character_media(media_kind="identity", name="角色名或身份名片段")；不要混入角色肖像。name 匹配角色名/别名/身份名/身份 ID；只有用户明确按描述内容查找时才用 query="..."。
- 指定当前草图：调用 dramaclaw_get_sketches(episode=N, beat=M)；该工具只展示正式 sketch_url/current sketch，不展示 grids/epNNN/sketch/beat_XX_t* 草图池候选。不要用草图池或首帧替代当前草图。指定草图候选/图池/备选草图：调用 dramaclaw_get_sketch_candidates(episode=N, beat=M)。指定首帧：调用 dramaclaw_get_first_frames(episode=N, beat=M)。多个正式草图用 beat_indices=[...]；分页用 offset + limit。
- 指定场景图：调用 dramaclaw_get_scene_images(name="场景名或名称片段")；名称按包含关系模糊匹配；多个关键词用 names=[...]；按第几个场景用 index=N 或 scene_indices=[...]；按类型筛选用 scene_type="..."；分页用 offset + limit。
- 指定视频：调用 dramaclaw_get_episode_media(episode=N, media_type="video", beat=M)；按内容片段查视频用 query="..."，匹配 beat 标题、画面描述、解说/对白、说话人、角色、场景；多个 beat 用 beat_indices=[...]；分页用 offset + limit。
- 指定音频/配音/TTS：调用 dramaclaw_get_episode_media(episode=N, media_type="audio", beat=M)；按内容片段查音频用 query="..."，匹配 beat 标题、解说/对白、说话人、角色、场景；多个 beat 用 beat_indices=[...]；分页用 offset + limit。

发送前自检：
1. 本回复是否展示图片/视频/音频媒体？如果是，是否调用了对应展示工具？
2. 是否避免暴露内部渲染格式、渲染机制、工具调用过程或工具名？
3. 如果不展示图片/视频/音频，是否使用 markdown？
4. 如果任一答案是否，先修正再回复。
[/RENDERING_CONTRACT]"""


def _media_path_from_static_url(url: str) -> str | None:
    parsed = urlparse(url)
    path = parsed.path if parsed.scheme in {"http", "https"} else url.split("?", 1)[0]
    if not path.startswith("/static/"):
        return None
    rel = path[len("/static/") :]
    parts = rel.split("/", 2)
    if len(parts) == 3:
        return unquote(parts[2])
    return unquote(rel)


def _canonical_project_static_media_url(
    project_id: str,
    project_dir: Path,
    url_or_path: str,
) -> tuple[str, str] | None:
    media_path = _media_path_from_static_url(url_or_path)
    if media_path is None:
        media_path = url_or_path.strip().split("?", 1)[0].lstrip("./")
    if not media_path:
        return None
    local_path = project_dir / media_path
    return project_static_url(project_id, media_path, local_path=local_path), media_path


def _media_project_dir(
    username: str,
    project: str,
    project_dir: str | Path | None = None,
) -> Path:
    return (
        Path(project_dir)
        if project_dir is not None
        else _project_dir(username, project)
    )


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _output_root() -> Path:
    configured = os.environ.get("NOVELVIDEO_OUTPUT_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return _repo_root() / "output"


def _state_root() -> Path:
    configured = os.environ.get("NOVELVIDEO_STATE_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return _repo_root() / "state"


def _runtime_root() -> Path:
    configured = os.environ.get("NOVELVIDEO_RUNTIME_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    data_root = os.environ.get("NOVELVIDEO_DATA_ROOT", "").strip()
    if data_root:
        return Path(data_root).expanduser() / "runtime"
    return _repo_root() / "runtime"


def _codex_node_home() -> Path:
    configured = os.environ.get("DRAMACLAW_CODEX_HOME", "").strip()
    if configured:
        return Path(configured).expanduser()
    return _state_root() / ".codex-app-server"


def _json_render_error_log_path() -> Path:
    configured = os.environ.get("JR_ERROR_LOG", "").strip()
    if configured:
        return Path(configured).expanduser()
    return _repo_root() / "jr_error.log"


_FREEZONE_CANVAS_ASSISTANT_INSTRUCTIONS = """[FREEZONE_CANVAS_ASSISTANT]
This chat turn is running inside the Xi画/Freezone canvas.

Scope:
- Inspect project assets, tasks, skill runs, and canvas data; answer explanations naturally.
- Turn creative ideas into working canvas material only when the user asks to create or land it.
- Keep image, audio, video, and composition work inside Freezone. Do not start, mutate, or use
  DramaClaw mainline production tools unless the user explicitly asks for the main project pipeline.
- Freezone accepts creative instructions directly in chat. Do not require the user to save or upload
  a `.txt` screenplay, and do not apply the mainline NovelVideo ingest/upload prerequisite here.

Clarification:
- Use freezone_request_user_clarification when several user-facing choices are required. Ask about
  creative intent, not tool fields, node types, link_type, schema, or model parameters. Image/video
  generation parameters are the exception and must follow the injected
  FREEZONE_CANVAS_EXECUTION_MODE contract. For ordinary chat, one natural follow-up, or an explicit
  request, reply normally without a card.

Canvas write contract:
- Before writing, ground the operation in the current canvas summary/context. Read command catalog,
  node create schema, link type catalog, node detail, or action catalog only when needed. Validate
  multi-step or edge-creating commands before writing.
- For create/add/delete/update/connect/move/layout/select/open/run/apply/execute requests, you MUST
  call a Freezone write tool. For one standalone operation, the first assistant output MUST be that
  matching single-operation write tool call; do not emit prose first. Workflow requests may perform
  only the Skill/catalog reads required by the next rule before their single workflow write call.
- For any workflow, several connected nodes, grouped stages, storyboard, or media pipeline, load
  and follow the dramaclaw-workflows Agent Skill. For an exact user-specified topology, read its
  references/custom-topology.md and call freezone_prepare_workflow_plan_draft once with one complete
  freezone_workflow_plan.v1. Exact means the user names the nodes and their dependency order; do not
  route it through the normal draft flow or compact Intent compiler merely because a production
  Skill matches. Explicit Beat, shot, or node totals must be copied into expected_node_count and
  expected_node_counts and must remain unchanged during recovery. Episodic short-drama, Beat,
  voice-over, or background-music workflows should use the short-drama production Skill rather than
  the generic text-to-image-video Skill.
  Graph completeness is the Agent's responsibility. Before submission, verify that all Plan nodes
  form one connected component when edges are viewed as undirected. For independent Beat/shot
  branches that need failure isolation, add one non-executable common input root and fan it out to
  every branch input; do not ask the user for internal nodes or link types, and do not serialize
  sibling branches merely to satisfy connectivity validation.
  Resolve unknown edge compatibility by reading freezone_get_link_type_catalog once. Never guess
  link types through repeated compiler calls. The graph write already validates, so do not use
  workflow_graph_compile as a routine preflight before the first write. After a recovery compile
  succeeds, immediately prepare the exact same Plan with freezone_prepare_workflow_plan_draft.
  Never call dramaclaw_get with guessed Skill or workflow HTTP paths. Use the workflow MCP catalog
  and its returned resource URI, or the documented freezone_get_workflow_skill fallback, exactly once.
  Do not use freezone_emit_canvas_command for a workflow.
- `dramaclaw-workflows` is the Agent Skill package name, not a Workflow catalog `skill_id`. Never
  pass it to workflow_skill_get/freezone_get_workflow_skill or use it as intent.skill_id. Select the
  matching production Workflow Skill returned by the catalog, such as text-to-image-video for a
  general image/video pipeline.
- Use freezone_create_node only for exactly one standalone textAnnotationNode when the user asks for
  one text node. Use one freezone_emit_canvas_command batch only for several ordinary non-workflow
  canvas edits. Use FREEZONE_CANVAS_CONTEXT's canvas_id. Do not precheck pipeline failure unless the
  user asks about status.
- Never claim any canvas change succeeded without a successful same-turn frontend write result. If
  it fails or is absent, say the change could not be confirmed.
- Never submit reduced sample, smoke-test, or placeholder nodes such as A/B, T1/T2, or “测试节点” to
  the user's canvas while recovering from a workflow error. Use the read-only workflow compiler
  only with that same complete graph, preserving all nodes, edges, groups, and exact counts. Never
  compile reduced probe nodes or use edges=[] for a multi-node plan. Correct the same complete plan
  once, and then report the blocking validation detail.
- Historical failures are diagnostic context only. If the user repeats the create/run request or
  retries after a restart, perform one same-turn write with the complete plan. Never declare the
  current adapter blocked unless the same failure is returned by that current-turn write.
- The user's explicit request to create or run is authorization to submit the protected canvas write
  and show its approval card. Do not ask for a second “创建并运行” confirmation and do not say the
  environment cannot display the card; the write tool creates it. In auto_execute, submit the write
  immediately after required media parameters are known and let the frontend apply the approval.
- For structured clarification, call the MCP tool freezone_request_user_clarification only. Never
  use the host's built-in request_user_input, update_plan, or create_goal tools for canvas work.
- In interactive Xi画 chat, never set auto_apply_after_mcp_approval; canvas writes must produce an
  approval card. Use clear_canvas for “清空画布/全部删除”, and never encode that intent as an empty
  delete_nodes command.
- Complete short videos with canvas video/audio/composition nodes. videoComposeNode is terminal:
  connect video/audio outputs as composition inputs; never connect planning text or prompts to it.

Skill Studio continuation:
- If recent history contains a Skill Studio save result and the user asks to revise it, continue that
  edit instead of writing canvas commands. Use the saved draft when available; otherwise read the
  saved Skill/Recipe. Clarify underspecified changes, then present a complete edit draft.
[/FREEZONE_CANVAS_ASSISTANT]"""

_FREEZONE_CANVAS_WRITE_ACTION_RE = re.compile(
    r"(?:创建|新建|添加|插入|删除|移除|清空|修改|更新|连接|连线|移动|向[上下左右]移|再移|布局|选择|打开|运行|执行|生成|制作|做|"
    r"create|add|insert|delete|remove|clear|update|connect|move|layout|select|open|run|execute|generate)",
    re.IGNORECASE,
)
_FREEZONE_CANVAS_WRITE_OBJECT_RE = re.compile(
    r"(?:节点|画布|工作流|连线|边|合成节点|"
    r"node|canvas|workflow|edge|compose\s+node)",
    re.IGNORECASE,
)
_FREEZONE_DIRECT_MEDIA_WRITE_RE = re.compile(
    r"(?:"
    r"(?:生成|创建|新建|添加|制作|做|运行|执行|用|根据|按照|基于)"
    r"[^。！？!?\n]{0,32}"
    r"(?:图片|图像|图|视频|音频|音乐|配音|旁白|成片)"
    r"|(?:generate|create|add|make|run|execute)\s+(?:an?\s+|some\s+)?"
    r"(?:image|video|audio|music|voiceover|composition)"
    r")",
    re.IGNORECASE,
)
_FREEZONE_CANVAS_KNOWLEDGE_QUESTION_RE = re.compile(
    r"(?:如何|怎么|为什么|为何|是什么|教程|方法|步骤|是否支持|支不支持|"
    r"\bwhat\b|\bwhy\b|\bhow\b|\bcan\s+i\b)",
    re.IGNORECASE,
)
_FREEZONE_CANVAS_NO_WRITE_FAILURE_RE = re.compile(
    r"(?:未能|无法|失败|找不到|不可用|未创建|没有创建|未执行|没有执行|不能)",
    re.IGNORECASE,
)
_FREEZONE_TEXT_ONLY_REQUEST_RE = re.compile(
    r"(?:生成|创建|编写|撰写|整理|generate|create|write|draft)"
    r"(?:(?!\n).){0,40}"
    r"(?:剧本|脚本|文案|提示词|解说词|screenplay|script|copy|copywriting|prompt)"
    r"\s*[。！？!?．.]?\s*$",
    re.IGNORECASE,
)
_FREEZONE_CANVAS_WRITE_TOOLS = frozenset(
    {
        "freezone_create_node",
        "freezone_add_next_node",
        "freezone_emit_canvas_command",
        "freezone_update_node_data",
        "freezone_delete_nodes",
        "freezone_delete_edges",
        "freezone_create_edge",
        "freezone_layout_nodes",
        "freezone_group_nodes",
        "freezone_move_nodes",
        "freezone_select_nodes",
        "freezone_open_mainline_projection",
        "freezone_run_node_action",
        "freezone_run_workflow",
        "freezone_confirm_workflow_draft",
        "freezone_confirm_canvas_action",
    }
)


def _freezone_canvas_write_requested(prompt: str | None) -> bool:
    """Recognize explicit user canvas mutations without matching injected context."""

    raw_prompt = str(prompt or "")
    user_text = raw_prompt.split("[SUPERTALE_", 1)[0].strip()
    if not user_text:
        return False
    has_action = bool(_FREEZONE_CANVAS_WRITE_ACTION_RE.search(user_text))
    has_canvas_object = bool(_FREEZONE_CANVAS_WRITE_OBJECT_RE.search(user_text))
    has_direct_media_write = bool(_FREEZONE_DIRECT_MEDIA_WRITE_RE.search(user_text))
    has_node_reference = "[SUPERTALE_CANVAS_NODE_REFERENCES]" in raw_prompt
    standalone_clear = bool(re.search(r"(?:清空|clear)", user_text, re.IGNORECASE))
    if _FREEZONE_CANVAS_KNOWLEDGE_QUESTION_RE.search(user_text):
        return False
    # A text artifact request such as “生成一个视频脚本” or “create an image
    # prompt” must remain a chat response unless the user explicitly names a
    # canvas/node mutation. Otherwise the post-turn adapter may replace the
    # generated text with a misleading canvas-write failure.
    # Only suppress an explicit text-artifact request.  Media requests may
    # legitimately contain the same words (for example “根据这个提示词生成
    # 一张图” or “生成一张带文案的图片”), so do not use a broad keyword
    # exclusion here.
    if (
        _FREEZONE_TEXT_ONLY_REQUEST_RE.search(user_text)
        and not re.search(r"(?:根据|用|按照|基于|带|包含|from|using|based\s+on|with)", user_text, re.IGNORECASE)
        and not re.search(r"(?:节点|画布|连线|node|canvas|edge)", user_text, re.IGNORECASE)
    ):
        return False
    return has_action and (
        has_canvas_object
        or has_direct_media_write
        or has_node_reference
        or standalone_clear
    )


def _codex_freezone_tool_name(event: Any) -> str:
    name = str(getattr(event, "name", "") or "").rsplit(".", 1)[-1].strip()
    if name == "dramaclaw_tool_call":
        tool_input = getattr(event, "input", None)
        if isinstance(tool_input, dict):
            name = str(tool_input.get("tool_name") or "").strip()
    return name


def _json_objects_from_codex_tool_value(value: Any) -> list[dict[str, Any]]:
    objects: list[dict[str, Any]] = []
    if isinstance(value, dict):
        objects.append(value)
        for nested in value.values():
            objects.extend(_json_objects_from_codex_tool_value(nested))
    elif isinstance(value, list):
        for nested in value:
            objects.extend(_json_objects_from_codex_tool_value(nested))
    elif isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return objects
        objects.extend(_json_objects_from_codex_tool_value(parsed))
    return objects


def _codex_freezone_write_result_succeeded(event: Any) -> bool:
    if _codex_freezone_tool_name(event) not in _FREEZONE_CANVAS_WRITE_TOOLS:
        return False
    status = str(getattr(event, "status", "") or "").strip().lower()
    if status not in {"completed", "success", "succeeded"} or getattr(
        event, "error", None
    ):
        return False
    values = [getattr(event, "structured", None), getattr(event, "output", None)]
    for value in values:
        for payload in _json_objects_from_codex_tool_value(value):
            if payload.get("ok") is not True:
                continue
            apply_status = str(payload.get("canvas_apply_status") or "").strip().lower()
            project_id = str(payload.get("project_id") or "").strip()
            canvas_id = str(payload.get("canvas_id") or "").strip()
            bridge_key = str(payload.get("bridge_key") or "").strip()
            revision = payload.get("revision")
            # A transport/tool status is not proof that the canvas mutation
            # was persisted. Browser-applied results are durable only when
            # they carry the bridge receipt identity; direct applies must
            # carry the saved canvas revision returned by the persistence API.
            browser_receipt = (
                apply_status in {"applied", "accepted"}
                and payload.get("applied") is True
                and bool(bridge_key and project_id and canvas_id)
            )
            direct_receipt = (
                apply_status == "direct_applied"
                and payload.get("applied") is True
                and bool(project_id and canvas_id)
                and isinstance(revision, int)
            )
            if browser_receipt or direct_receipt:
                return True
    return False


def _codex_freezone_write_result_error(event: Any) -> str:
    """Extract the business error returned by a completed Freezone write tool."""

    if _codex_freezone_tool_name(event) not in _FREEZONE_CANVAS_WRITE_TOOLS:
        return ""
    values = [
        getattr(event, "structured", None),
        getattr(event, "output", None),
        getattr(event, "error", None),
    ]
    for value in values:
        for payload in _json_objects_from_codex_tool_value(value):
            if payload.get("ok") is not False:
                continue
            for key in ("user_message", "error"):
                message = payload.get(key)
                if isinstance(message, str) and message.strip():
                    return message.strip()[:1000]
            errors = payload.get("errors")
            if isinstance(errors, list):
                messages = [str(item).strip() for item in errors if str(item).strip()]
                if messages:
                    return "；".join(messages[:3])[:1000]
            message = payload.get("message")
            if isinstance(message, str) and message.strip():
                return message.strip()[:1000]
    raw_error = getattr(event, "error", None)
    if isinstance(raw_error, str) and raw_error.strip():
        return raw_error.strip()[:1000]
    return ""


def _codex_freezone_ready_workflow_draft(event: Any) -> dict[str, Any] | None:
    """Return a successfully prepared workflow draft carried by a Codex event."""

    if _codex_freezone_tool_name(event) != "freezone_prepare_workflow_draft":
        return None
    status = str(getattr(event, "status", "") or "").strip().lower()
    if status not in {"completed", "success", "succeeded"}:
        return None
    for value in (getattr(event, "structured", None), getattr(event, "output", None)):
        for payload in _json_objects_from_codex_tool_value(value):
            if (
                payload.get("ok") is True
                and str(payload.get("status") or "") == "workflow_draft_ready"
                and str(payload.get("draft_id") or "").strip()
            ):
                return payload
    return None


_FREEZONE_SKILL_STUDIO_TRIGGER_RE = re.compile(
    r"(?:"
    r"(?:创建|新建|新增|生成|做|制作|编辑|修改|更新|保存|沉淀|整理|总结|抽成|转成|变成)"
    r"[\s\S]{0,24}(?:Skill|Skills|Recipe|Recipes|skill|skills|recipe|recipes|技能|配方)"
    r"|(?:Skill|Skills|Recipe|Recipes|skill|skills|recipe|recipes|技能|配方)"
    r"[\s\S]{0,24}(?:创建|新建|新增|生成|编辑|修改|更新|保存|沉淀|整理|总结)"
    r"|(?:保存|沉淀|整理|总结|抽成|转成|变成)[\s\S]{0,18}(?:模板|可复用能力|复用能力)"
    r")",
    re.IGNORECASE,
)

_FREEZONE_SKILL_STUDIO_INSTRUCTIONS = """[FREEZONE_SKILL_STUDIO]
This block is present only when the user explicitly wants to create, edit, save, or distill Xi画 Skills / Recipes.

Routing:
- Skill Studio creates catalog configuration drafts. It is not a canvas write operation.
- Normal creative work, canvas node edits, and short-video ideation must stay in the normal Freezone path unless the user explicitly asks to create/edit/save/distill a Skill or Recipe.
- In Skill Studio turns, you must not emit Freezone canvas commands or claim that canvas nodes changed.
- Skill Studio only creates or edits Skill/Recipe catalog drafts. Unless the user explicitly asks to build from the current canvas, selected nodes, or an existing workflow, do not call canvas node schema, link catalog, node detail, or other canvas read tools.
- For Skill/Recipe authoring, follow the repo skill reference `references/skill-studio-authoring-guide.md`: perform capability modeling before asking or drafting.
- Do not treat tool schemas as authoring guidance; schema fields are final serialization constraints, not the creative plan.
- All user-visible Skill Studio text must follow the user's current language. If the user writes in Chinese, use natural Chinese; if the user writes in English, use natural English. This applies to analysis summaries, clarification questions, option labels, option descriptions, draft progress explanations, and final chat replies. Do not mix languages casually and do not show internal English headings such as "Prompt evidence", "creative contract", "Let me check", or "Now I'll submit" when replying to a Chinese user; keep internal analysis internal or summarize it in the user's language.
- Before asking questions or drafting, classify the Skill Studio source mode:
  - new_from_user_brief: the user asks to create/build/make a new Skill or Recipe from a topic, domain, or natural-language brief without explicitly saying current canvas, current flow, selected nodes, this project, this workflow, or existing workflow. In this mode, the current canvas is ambient context, not source evidence. Do not let canvas ontology influence Skill identity, questions, Recipes, constraints, names, or keywords. Do not ask whether to preserve current project details, current brand, current character, or current story.
  - distill_from_canvas: the user explicitly asks to save/distill/summarize/turn the current canvas, current flow, selected nodes, this project, this workflow, or existing workflow into a Skill or Recipe. In this mode, call freezone_get_canvas_ontology before asking any question. Do not use canvas summary as the evidence source for Skill Studio questions. If ontology lacks evidence for style, prompts, key media, or graph dependencies, fetch only a few key node details with freezone_get_node_detail. Then infer the reusable workflow and current production style, and ask 2-4 high-quality confirmation questions first instead of immediately presenting a draft. Each question should usually provide 3-5 user-facing options unless the decision is truly binary.
  - edit_existing_catalog: the user asks to revise an existing saved Skill/Recipe or visible draft. Use the saved/draft configuration as source of truth.
- For new_from_user_brief with a short brief, ask high-level questions about topic/domain, audience/context, artifact scope, style/tone, and workflow granularity. Do not ask current-canvas abstraction questions unless the user explicitly opts into using the current canvas.
- For distill_from_canvas/current-flow/selected-node workflow distillation, perform an internal canvas_workflow_analysis before asking or drafting. This analysis must be based on freezone_get_canvas_ontology evidence or key node detail evidence, not on the user's short request or canvas summary.
- Do not call freezone_request_user_clarification for canvas distillation until you have canvas evidence from ontology or a small set of key node details. Do not read every node detail one by one; only fetch individual node detail for a small number of key nodes when ontology is missing fields needed for the draft or for evidence-backed questions.
- Summary-flow confirmation questions should be grounded in the current canvas evidence. Before asking, build an internal decision matrix with these distinct layers: production_method (what this workflow makes and how), visual_language (only evidence-backed visual style, not a generic noun), case_variables (brand, character, product, one-off story), reusable_protocol (stage order, anchors, review gates, inheritance rules), hard_constraints (rules that must not be broken), start_options (choices the user should set each time), and applicability_scope (where this Skill can be used). Do not merge these layers into one question.
- Do not over-infer visual style from node names, product categories, or a single word such as 光影. If the evidence is thin, say internally that visual evidence is insufficient and ask the user which visual direction to preserve. Never present a vague phrase such as "光影风格广告" as the recognized core style unless the canvas evidence explicitly supports it.
- Ask about applicability_scope only after production_method, reusable_protocol, and case_variables are clear. The first question for canvas distillation should usually be about what workflow method to preserve, not which product category it applies to.
- Each confirmation question must ask one decision only. Do not pack style rules, workflow steps, and final composition constraints into one option. If a hard-rule option becomes a long sentence, split it into separate choices or a multi-select question.
- The questions and options must mention recognized workflow evidence in the user's language, for example "主体锚点 + 参考资产 + 分镜草图 + 逐段生成", rather than generic "当前案例". Only mention a concrete visual style when it is actually supported by canvas prompt/media evidence.
- Before showing a clarification card, briefly state the canvas evidence in plain user language, for example: "我看到这张画布像是一个广告短片流程：先固定角色和道具，再做分镜，再生成逐镜视频，最后加音频并合成。" This evidence sentence should be concise and should not expose ontology/schema/tool names.
- Summary-flow confirmation questions should focus on user-facing abstraction choices: what to reuse next time, what can be replaced next time, what style or quality rules must stay, how detailed the reusable steps should be, and what choices the user wants to confirm each time. Do not always ask the same two questions.
- Translate internal analysis labels into user-facing question titles. Do not use question titles like "硬约束与开始前选项", "完整保留全链路", "作为默认风格写进 Skill", or "变成每次可替换的输入". Prefer titles such as "下次主要复用什么？", "下次可以替换哪些内容？", "哪些效果必须保持？", "每次开始前要确认什么？".
- Option text should describe the effect of choosing it, not the implementation. Prefer "下次换产品时，角色和道具可以重新指定，但分镜到成片的流程保持一致" over "case_variables become input_parameters". Keep each option short enough for a user to scan quickly.
- In user-facing questions, do not expose internal terms such as Recipe, Recipes, 配方, allowed_recipe_ids, workflow_templates, videoCompose, schema, or tool fields. Use product language such as "复用方式", "能力模块", "执行步骤", "工作流细致程度", or "细粒度复用".
- If you need to ask about internal Recipe granularity, phrase it as a user-facing reuse choice. For example, ask "复用方式" with options like "细粒度复用（推荐）：把角色、道具、分镜、视频、音频等步骤分别沉淀，之后更容易单独复用和调整" and "简化复用：合并成较少步骤，配置更轻，但后续单独调整某一步的灵活性较弱".
- Do not present videoCompose, final media composition, or final synthesis as a user-facing granularity option, and do not count the terminal composition step in the user-facing step count.
- Do not ask for Skill name, category, or fixed topology as the first summary-flow questions. Prefer concrete case vs reusable Skill, user-facing reuse mode, and hard constraint preservation.
- Skip those summary-flow questions only when the user explicitly says to skip confirmation, use recommended/default settings, or already gives equivalent preferences.

Output contract:
- For setup questions, call freezone_request_user_clarification.
- For generated or modified drafts, use the chunked draft tools:
  freezone_put_agent_catalog_draft_outline -> freezone_begin_agent_catalog_draft ->
  freezone_put_agent_catalog_skill -> freezone_put_agent_catalog_recipe once per Recipe ->
  freezone_finish_agent_catalog_draft.
- For create drafts with Recipes, freezone_put_agent_catalog_draft_outline is mandatory before
  freezone_begin_agent_catalog_draft. The outline must record the reusable goal, Skill-level
  constraints, planned executable stages, whether each planned Recipe is reused or new, and
  catalog_checked=true after using the injected catalog summary or freezone_list_agent_catalog.
  Reused existing Recipes do not need freezone_put_agent_catalog_recipe calls; include their ids in
  the Skill allowed_recipe_ids only. expected_recipe_count counts only new Recipe chunks that the
  agent will submit in this draft.
- In the outline, every reuse=new stage must include new_recipe_craft_gap. This is not a style note:
  it must explain the missing executable craft in existing Recipes, such as input structure, output
  structure, required items, quality checks, failure boundaries, or execution-stage differences.
  Style, subject, brand, visual taste, or aesthetic differences belong in Skill
  planning.prompt_guide/conduct_rules/evaluation and are not enough reason to create a new Recipe.
- For local edits, prefer freezone_patch_agent_catalog_draft after begin. Use put_skill / put_recipe
  only when replacing an entire Skill or Recipe object. Always finish with
  freezone_finish_agent_catalog_draft. Do not regenerate unchanged Recipes.
  For target=recipe, pass recipe_id and use patch paths relative to that Recipe object,
  for example /system_prompt or /must_have_items. Never use /recipes/<recipe_id>/...
  inside patch.path. The top-level parameter is patch, not operation, operations, or patches.
  To remove the selected Recipe, use patch=[{"op":"remove","path":""}].
- Before calling freezone_begin_agent_catalog_draft, decide the planned Recipe list/count and pass
  the same expected_recipe_count used in the outline. Use 0 when every Recipe is reused or when the
  draft intentionally has no Recipes.
- Before emitting the final draft, run an internal boundary self-check: each Recipe should cover one
  executable stage, audio Recipes should not contain final video composition, task-time counts should
  not be hard-coded when input_parameters exposes them, and style/domain identity should live in the
  Skill unless the Recipe is intentionally domain-specific. Fix clear issues before calling
  freezone_finish_agent_catalog_draft.
- Do not pass the full Skill/Recipe catalog in one tool call.
- Do not paste the final JSON as the chat answer.
- Do not return only a diff or patch.
- Do not claim the Skill or Recipe is saved; saving happens only after the user confirms in the UI.
- Use one skill_studio_session_id across the questions, draft, and later edits for the same draft flow.

Draft revision:
- When the frontend returns action=start_revision or skill_studio_status=revision_started, use the
  returned draft_ref only as the draft identity and start a revision question flow. The frontend does
  not return the full draft at this point. If you call freezone_request_user_clarification for this
  revision flow, the questions array must contain exactly one question object. Wait for the user's
  answer before deciding the next question unless the requested change is already clear.
- In revision flows, draft_ref is only the object identity; it is not user intent. Do not infer desired
  edits, structural improvements, Recipe splits/merges, Recipe additions/removals, or dependency
  rewrites from draft_ref, the existing draft summary, or history alone.
- A broad category answer such as "basic info", "input parameters", "module content", "constraints",
  "quality standards", "execution flow", or similar is still not a concrete edit. Ask one more focused
  clarification question. Only edit after the user provides a concrete target and concrete change.
- A start_revision result means the user is dissatisfied and wants changes. Do not ask whether to
  save the current draft, and do not offer save_now/save_current/confirm_save as options. Saving is
  handled only by the draft card UI after you present an updated draft.
- In revision flows, use freezone_patch_agent_catalog_draft for field-level changes. Only resend changed
  Skill/Recipe chunks when replacing entire objects; unchanged Recipes can remain in the current draft
  session until freezone_finish_agent_catalog_draft assembles the draft.
- After a Skill Studio save result, if the user naturally asks to revise the recently saved
  Skill/Recipe, infer the target from history, read full saved config with freezone_get_saved_skill
  and/or freezone_get_saved_recipe if needed, ask focused revision questions, then present a
  complete edit draft.
- Do not ask the user to click another button to revise saved content, and do not rely on frontend
  short-message routing.

Draft rules:
- Generate complete Skill / Recipe drafts, not partial fields.
- For every new Skill, derive the draft from capability modeling: target user, input sources, output artifacts, execution path, quality gates, and failure/refinement strategy.
- Do not include workflow_templates. Skills store reusable planning rules and Recipe boundaries; each run authors a complete dynamic freezone_workflow_plan.v1 from the confirmed user goal.
- Before drafting Recipes, use the injected catalog summary to decide reuse. If the summary is missing or too thin, call freezone_list_agent_catalog(kind="recipes", query=...) for compact Recipe summaries. Prefer existing Recipes when the stage craft matches; create new Recipes only for real craft gaps.
- For every new Recipe decision, write the craft gap into the outline's new_recipe_craft_gap. If you
  cannot name a concrete craft gap after removing current style/theme/brand/case variables, reuse an
  existing Recipe instead.
- Do not over-generalize Recipes. If removing the current Skill's style, domain, and case variables leaves only vague words such as stable, clear, reusable, or high quality, keep a more specific Recipe boundary and id. Recipe ids/names must reflect the true reusable scope.
- Every Skill must include allowed_recipe_ids containing exactly the executable Recipe ids this Skill may use. Each id must refer to a top-level Recipe draft in the same draft session or an intentionally reused saved Recipe.
- allowed_recipe_ids is the executable whitelist for this Skill, not a list of related Recipes. Include only Recipes the runtime plan may actually use.
- Do not auto-add front-loaded text Recipes unless the Skill truly needs textGeneration nodes whose outputs are consumed downstream.
- Keep style identity, domain rules, workflow gates, input options, material inheritance, and refinement boundaries in the Skill; keep one-stage prompt/instruction craft in Recipes.
- For multi-node canvas processes, planning.planning_notes must describe the ordered phases, dependency rules, parallelism, review gates, aspect-ratio policy, and the Recipe action_keys available to dynamic planning.
- If subjects, assets, or references must stay consistent across stages, planning.planning_notes and planning.conduct_rules must state which anchors to create or reuse and which downstream stages must reference the same anchor. Do not rely on a vague "keep consistent" sentence inside a Recipe.
- videoCompose may appear only as a terminal node in the runtime dynamic plan for existing video/audio assets. Do not create a Recipe for videoCompose and do not claim a Recipe prompt will drive videoComposeNode directly. If AI planning is needed for editing, create a textGeneration Recipe for a compose/timeline plan, then let the dynamic plan add the terminal videoCompose node.
- For canvas workflow distillation, perform prompt_evidence_analysis before topology summarization: first extract repeated prompt phrases, media facts, source filenames, references, and edges, then summarize the graph. Infer the domain_contract or creative_contract from that evidence, not from displayName or node type alone.
- For canvas workflow distillation, perform skill_identity_analysis after prompt_evidence_analysis. Classify evidence terms into case_variables, reusable_protocol_terms, output_format_terms, use_case_terms, and workflow_method_terms. Skill name, id, description, and triggers.keywords must remove case_variables but preserve reusable_protocol_terms. Do not let workflow_method_terms alone dominate the Skill identity; keywords must cover protocol, output format, use case, and workflow method.
- For canvas workflow distillation, infer Recipe boundaries from reusable capabilities and graph dependencies. Do not derive Recipes only from node types.
- Extract hard constraints from repeated prompt text, references, and edges; turn them into conduct_rules, evaluation.domain_constraints, dynamic dependency rules, and Recipe quality standards. Do not collapse them into vague "style consistency" language.
- Write the domain_contract or creative_contract into existing fields: planning_notes, conduct_rules, evaluation.domain_constraints, and Recipe quality standards. Do not add schema fields for the contract. Express it in generic layers first: global creative language, stage-specific exceptions, and inheritance rules. For non-visual domains, the same contract may capture metric definitions, legal jurisdiction, teaching level, voice persona, or gameplay rules.
- Do not create global spec, final spec, or input-analysis Recipes to shuttle aspect ratio, duration, style, asset policy, or execution mode. Those authoritative values belong in input_parameters, planning.prompt_guide, planning.conduct_rules, confirmed inputs, and runtime plan inputs.
- Do not put stage progression instructions such as "after confirmation, proceed to the next stage" inside Recipe system_prompt, planning_prompt, or result_summary. Stage order, pauses, automatic execution, and rework boundaries belong to Skill planning.conduct_rules and runtime authorization.
- Do not hard-code subjective choices into Skill rules. If a choice would vary by author or by this run, ask the user when it changes the graph, or let runtime generate comparable candidates when it can be judged side by side.
- Keep ids lowercase and limited to letters, numbers, underscores, and hyphens.
- Use Skill triggers.node_scopes only for catalog node scopes: textGeneration, imageGeneration, videoGeneration, audioGeneration. Do not use canvas node types such as imageGenNode, textAnnotationNode, videoNode, or audioNode in Skill triggers.
- Use input_parameters for task-time aspect choices, duration, counts, and other per-run controls. For example, add an aspect_ratio single_select input with a default such as 16:9 when users should choose it each time. Do not write planning.default_aspect_ratios, model_preferences, or fixed model ids.
- If a workflow produces multiple ratios, describe the ratio policy in planning_notes/conduct_rules and put explicit aspectRatio values on the relevant dynamic plan nodes at runtime.
- planning.planning_notes must start with an executable path summary: ordered steps, task types, action_keys, upstream dependencies, review/wait behavior, and aspect ratio policy. Put visual/style guidance after the execution path.
- planning.conduct_rules must include hard execution rules, not only style principles: step order, one-node-per-step constraints, input source rules, review gates, aspect ratios, and forbidden premature downstream execution.
- planning_notes and conduct_rules must be precise enough for the runtime Agent to author node types, dependencies, parallel branches, and review gates without a fixed template.
- Split planning fields by responsibility: prompt_guide describes how outputs should feel/read/sound; planning_notes describes how the Graph should be planned; conduct_rules describes what must never be violated.
- When Recipe craft conflicts with this turn's user request, confirmed inputs, or Skill constraints, use this priority order: user request > confirmed inputs > Skill constraints > Recipe craft > defaults.
- Use snake_case Recipe fields directly: system_prompt, must_have_items, planning_prompt, result_summary, requires_source_media.
- Do not ask the user for low-level fields such as id, category, action_keys, or system_prompt; infer them.
- Recipe system_prompt is a prompt/instruction generator: it guides the current Agent/LLM to write
  the prompt, brief, or instruction that will be sent to the corresponding textGeneration,
  imageGeneration, videoGeneration, or audioGeneration node（送入对应节点）. 不要直接生成最终内容。
  - For text Recipes, do not write the final copy/script/outline directly; instruct the current LLM
    to produce a complete prompt/instruction for the textGeneration node that will generate that artifact.
  - For image/video/audio Recipes, do not write the final image/video/audio prompt as the Recipe itself;
    instruct the current LLM to transform upstream inputs into one complete downstream generation prompt.
  - The system_prompt itself should say: output only the downstream node prompt/instruction, do not
    execute the final content generation inside this step.
- Recipe system_prompt must never be the final downstream prompt itself. It must instruct the current LLM how to transform upstream input into the downstream node prompt/instruction. It should explicitly include: “重要：你的输出是一条提示词/指令，将被送入下游 <node_type> 节点执行；不要自己生成最终内容。”
- Recipe system_prompt must include concrete structured sections: 【角色设定】, 【输入来源】, 【任务目标】, 【输出结构要求】, 【质量标准】, and 【禁止事项/约束】. The output structure describes the modules that the downstream prompt/brief must contain, such as subject, scene, shot/composition, style, color, text/layout, continuity, and negative constraints.
- Recipe must_have_items should usually be required modules/sections for the downstream prompt/brief, not only style adjectives. For an image Recipe, prefer items such as "主视觉描述", "文化元素提取", "构图与留白", "色彩与字体建议", "负面提示词/禁止事项".
- Recipe planning_prompt must be non-empty and describe this node's work in one short business sentence, usually "根据 X，生成/提取/改写 Y。". Do not explain scheduling mechanics, downstream nodes, workflow internals, or "when to schedule this Recipe" in this field.
- Recipe result_summary must be non-empty and describe this node's business output in one short phrase or sentence, such as "3:4 竖版数码产品科技感详情图" or "家乡文化海报图片生成指令". Do not mention downstream execution, imageGeneration handoff, planner behavior, or workflow mechanics in this field.
- For multi-step Skills, split planning/prompt-writing Recipes from terminal image/video generation Recipes when useful.
- If the request is ambiguous, ask 3-5 high-level option questions instead of field-by-field questions.
- Manual card edits are the source of truth after the draft is shown; later natural-language changes must be based on the current draft.
[/FREEZONE_SKILL_STUDIO]"""


def _freezone_skill_studio_requested(prompt: str | None) -> bool:
    text = str(prompt or "").strip()
    if not text:
        return False
    return bool(_FREEZONE_SKILL_STUDIO_TRIGGER_RE.search(text))


def _freezone_agent_catalog_summary(username: str, *, limit: int = 40) -> str:
    try:
        from novelvideo.freezone.agent_config_store import list_user_agent_config_items
    except Exception:
        return "catalog_summary_unavailable"

    lines: list[str] = []
    for kind in ("skills", "recipes"):
        try:
            items = list_user_agent_config_items(username, kind)
        except Exception:
            lines.append(f"{kind}: unavailable")
            continue
        visible = [
            item
            for item in items
            if item.get("enabled") is not False and item.get("hidden") is not True
        ]
        lines.append(f"{kind}:")
        if not visible:
            lines.append("- none")
            continue
        for item in visible[:limit]:
            source = str(item.get("_catalog_source") or "user")
            if item.get("_catalog_base_source") == "builtin":
                source = "customized"
            if kind == "skills":
                triggers = (
                    item.get("triggers")
                    if isinstance(item.get("triggers"), dict)
                    else {}
                )
                keywords = (
                    triggers.get("keywords") if isinstance(triggers, dict) else []
                )
                keyword_text = (
                    ", ".join(str(value) for value in keywords[:6])
                    if isinstance(keywords, list)
                    else ""
                )
                lines.append(
                    "- "
                    f"id={item.get('id')}; source={source}; category={item.get('category')}; "
                    f"description={item.get('description')}; keywords={keyword_text}"
                )
            else:
                action_keys = item.get("action_keys")
                action_text = (
                    ", ".join(str(value) for value in action_keys[:6])
                    if isinstance(action_keys, list)
                    else ""
                )
                lines.append(
                    "- "
                    f"id={item.get('id')}; source={source}; name={item.get('name')}; "
                    f"output_kind={item.get('output_kind')}; action_keys={action_text}"
                )
        if len(visible) > limit:
            lines.append(f"- ... {len(visible) - limit} more")
    return "\n".join(lines)


def _freezone_skill_studio_context(username: str, prompt: str | None) -> str:
    if not _freezone_skill_studio_requested(prompt):
        return ""
    return (
        f"\n\n{_FREEZONE_SKILL_STUDIO_INSTRUCTIONS}\n\n"
        "[FREEZONE_AGENT_CATALOG_SUMMARY]\n"
        f"{_freezone_agent_catalog_summary(username)}\n"
        "[/FREEZONE_AGENT_CATALOG_SUMMARY]"
    )


_FREEZONE_CANVAS_PROMPT_MARKERS = (
    "[SUPERTALE_CANVAS_ROUTING]",
    "[SUPERTALE_CANVAS_CHAT_COMMANDS]",
    "[SUPERTALE_CANVAS_ONTOLOGY_CONTEXT]",
    "[SUPERTALE_CANVAS_ONTOLOGY_SUMMARY]",
    "[SUPERTALE_CANVAS_NODE_REFERENCES]",
)


def _prompt_has_freezone_canvas_context(prompt: str | None) -> bool:
    text = str(prompt or "")
    return any(marker in text for marker in _FREEZONE_CANVAS_PROMPT_MARKERS)


def _surface_context_has_freezone_canvas(
    surface_context: dict[str, Any] | None,
) -> bool:
    return bool(str((surface_context or {}).get("freezone_canvas_id") or "").strip())


def _tool_mode_for_surface(
    surface: str | None,
    *,
    prompt: str | None = None,
    surface_context: dict[str, Any] | None = None,
) -> str:
    if str(surface or "").strip() == "freezone":
        return "freezone_canvas"
    if _surface_context_has_freezone_canvas(surface_context):
        return "freezone_canvas"
    if _prompt_has_freezone_canvas_context(prompt):
        return "freezone_canvas"
    return "default"


def _freezone_canvas_id_from_context(surface_context: dict[str, Any] | None) -> str:
    return (
        str((surface_context or {}).get("freezone_canvas_id") or "default").strip()
        or "default"
    )


def _freezone_canvas_execution_mode_from_context(
    surface_context: dict[str, Any] | None,
) -> str:
    value = str(
        (surface_context or {}).get("canvas_command_execution_mode") or ""
    ).strip()
    return "auto_execute" if value == "auto_execute" else "manual_confirm"


def _write_hermes_tool_mode(username: str, *, mode: str) -> None:
    try:
        from novelvideo.chat.hermes_workspace import ensure_user_hermes_workspace

        home = ensure_user_hermes_workspace(
            username,
            profile="freezone" if mode == "freezone_canvas" else "director",
        )
        path = home / "tmp" / "dramaclaw_tool_mode.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"mode": mode}, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as exc:  # noqa: BLE001 - tool mode is defense-in-depth.
        logger.warning(
            "failed to write hermes tool mode for user=%s mode=%s: %s",
            username,
            mode,
            exc,
        )


def _route_prompt_with_execution_context(
    prompt: str,
    route_prompt: str | None,
) -> tuple[str, str]:
    """Separate visible user intent from transport-only execution context.

    The UI appends canvas ontology, attachment analysis, node references, and
    command context after the visible text. Hermes still needs that context,
    but BrainClaw must classify and embed only the visible intent following the
    final ``[USER_MESSAGE]`` marker.

    Only split the prompt when the clean route prompt is an exact leading text
    segment followed by a line boundary. Older callers and transformed prompts
    retain the previous behavior instead of risking lost user content.
    """

    transport_prompt = str(prompt or "")
    clean_route_prompt = str(route_prompt or "").strip()
    if not clean_route_prompt:
        return transport_prompt, ""
    if transport_prompt == clean_route_prompt:
        return clean_route_prompt, ""
    if transport_prompt.startswith(clean_route_prompt):
        suffix = transport_prompt[len(clean_route_prompt) :]
        if suffix.startswith(("\n", "\r")):
            return clean_route_prompt, suffix.strip()
    return transport_prompt, ""


def _prompt_with_user_context(
    username: str,
    project: str,
    prompt: str,
    *,
    tool_mode: str = "default",
    surface_context: dict[str, Any] | None = None,
    route_prompt: str | None = None,
    turn_id: str | None = None,
    require_generation_parameter_preflight: bool = False,
) -> str:
    user_message, execution_context = _route_prompt_with_execution_context(
        prompt,
        route_prompt,
    )
    scope = f"project:{project}" if project else "home"
    canvas_id = _freezone_canvas_id_from_context(surface_context)
    canvas_execution_mode = _freezone_canvas_execution_mode_from_context(
        surface_context
    )
    generation_parameter_round = str(turn_id or "current_request").strip()
    if require_generation_parameter_preflight:
        generation_parameter_policy = (
            f"generation_parameter_round: {generation_parameter_round}\n"
            "For every new request in this round that will actually generate image or video media, "
            "show one preliminary structured generation-parameter clarification before any canvas "
            "write in both manual_confirm and auto_execute. Historical clarification answers, "
            "existing node data, Recipe defaults, and parameters from an earlier turn may only "
            "prefill recommended choices; they never count as confirmation for this round. Do not "
            "ask again after the clarification tool returns answers for this same round. This card "
            "covers image/video parameters only; never add a system-voice/custom-voice choice and "
            "do not ask the user to choose system voice versus custom voice.\n"
            "manual_confirm: After the preliminary parameter answers return, put them into the plan "
            "and submit the protected write. The normal approval card is still shown and remains the "
            "final parameter editor before execution.\n"
            "auto_execute: After the preliminary parameter answers return, submit the protected canvas "
            "write immediately without asking for another create/run confirmation. A normal approval "
            "event is still emitted and the frontend auto-applies it; explicit human-review requirements "
            "may pause. Use the MCP clarification tool, never built-in request_user_input.\n"
        )
    else:
        generation_parameter_policy = (
            "manual_confirm: Do not ask a preliminary image/video parameter clarification. Read the "
            "live schema and put supported defaults or symbolic recommended values into the plan; the "
            "approval card is where the user reviews and adjusts final generation parameters.\n"
            "auto_execute: If image/video parameters needed for generation are missing, ask once before "
            "the canvas write, with one structured question per missing field. A normal approval event "
            "is still emitted and the frontend auto-applies it; explicit human-review requirements may "
            "pause. After the answers return, submit the protected canvas write immediately without "
            "asking for another create/run confirmation. Use the MCP clarification tool, never built-in "
            "request_user_input.\n"
        )
    canvas_context = (
        "\n\n[FREEZONE_CANVAS_CONTEXT]\n"
        f"canvas_id: {canvas_id}\n"
        "Use this canvas_id for Freezone canvas tools unless the user explicitly names another canvas.\n"
        "[/FREEZONE_CANVAS_CONTEXT]\n\n"
        "[FREEZONE_CANVAS_EXECUTION_MODE]\n"
        f"mode: {canvas_execution_mode}\n"
        f"{generation_parameter_policy}"
        "If the mode is absent or invalid, use manual_confirm. The mode changes parameter collection "
        "only; it does not bypass validation, approval events, or the authorized canvas write path.\n"
        "[/FREEZONE_CANVAS_EXECUTION_MODE]"
        if tool_mode == "freezone_canvas"
        else ""
    )
    surface_instructions = (
        f"\n\n{_FREEZONE_CANVAS_ASSISTANT_INSTRUCTIONS}"
        f"{_freezone_skill_studio_context(username, route_prompt if route_prompt is not None else prompt)}"
        f"{canvas_context}"
        if tool_mode == "freezone_canvas"
        else ""
    )
    continuation_source = route_prompt if route_prompt is not None else prompt
    continuation_instructions = _pipeline_continuation_instructions(
        continuation_source,
        tool_mode=tool_mode,
    )
    rendering_instructions = (
        ""
        if tool_mode == "freezone_canvas"
        else f"{_JSON_RENDER_CHAT_INSTRUCTIONS}\n\n"
    )
    execution_context_block = (
        "[DRAMACLAW_EXECUTION_CONTEXT]\n"
        f"{execution_context}\n"
        "[/DRAMACLAW_EXECUTION_CONTEXT]\n\n"
        if execution_context
        else ""
    )
    return (
        "[DRAMACLAW_USER_CONTEXT]\n"
        f"username: {username}\n"
        f"scope: {scope}\n"
        "Project-scoped facts and learned preferences must stay in the project scope.\n\n"
        f"{rendering_instructions}"
        f"{continuation_instructions}"
        f"{surface_instructions}\n\n"
        f"{execution_context_block}"
        "[USER_MESSAGE]\n"
        f"{user_message}"
    )


def _pipeline_continuation_instructions(prompt: str, *, tool_mode: str) -> str:
    """Return a narrow execution hint for explicit mainline continuation commands."""
    if tool_mode != "default":
        return ""
    text = str(prompt or "").strip()
    if not text or len(text) > 80:
        return ""
    if not _EXPLICIT_PIPELINE_CONTINUATION_RE.search(text):
        return ""
    if _PIPELINE_CONTINUATION_QUESTION_RE.search(text):
        return ""
    return f"{_DRAMACLAW_CONTINUATION_INSTRUCTIONS}\n\n"


def _chat_backend() -> str:
    preferred = (
        os.environ.get("DRAMACLAW_CHAT_BACKEND")
        or os.environ.get("SUPERTALE_CHAT_BACKEND")
        or "hermes"
    ).strip().lower() or "hermes"
    if preferred == "hermes":
        # Explicit "hermes" must succeed — do NOT silently fall back to
        # claude/codex. A missing hermes binary is a config error to surface.
        if is_hermes_backend_available():
            return "hermes"
        raise RuntimeError(
            "DRAMACLAW_CHAT_BACKEND=hermes requested but hermes is unavailable. "
            "Run `uv tool install 'hermes-agent[acp]'`, "
            "then run `hermes doctor` to diagnose."
        )
    if preferred == "codex":
        if is_codex_backend_available():
            return "codex"
        raise RuntimeError(
            "DRAMACLAW_CHAT_BACKEND=codex requested but Codex is unavailable. "
            "Install `openai-codex`/Codex Python SDK support in the backend environment "
            "and ensure CODEX_BIN points to a valid codex binary."
        )
    if preferred == "claude":
        if is_claude_backend_available():
            return "claude"
        raise RuntimeError(
            "DRAMACLAW_CHAT_BACKEND=claude requested but Claude is unavailable. "
            "Install claude-agent-sdk and ensure CLAUDE_CLI_PATH points to a valid claude binary."
        )
    if is_codex_backend_available():
        return "codex"
    if is_claude_backend_available():
        return "claude"
    return preferred


def _claude_cli_path() -> Path:
    configured = os.environ.get("CLAUDE_CLI_PATH", "").strip()
    if configured:
        return Path(configured).expanduser()
    resolved = shutil.which("claude")
    if resolved:
        return Path(resolved)
    return Path.home() / ".local" / "bin" / "claude"


def _codex_bin_path() -> Path | None:
    configured = os.environ.get("CODEX_BIN", "").strip()
    if configured:
        return Path(configured).expanduser()
    return None


def _codex_model() -> str:
    from novelvideo.shared.runtime_env import is_ce_effective

    if is_ce_effective():
        from novelvideo.model_gateway_settings import get_effective_llm_config

        # CE is configured interactively and SQLite is authoritative. The
        # BrainClaw choice is a direct model route; Advanced mode keeps using
        # DramaClaw's logical Codex alias on the user-selected NewAPI gateway.
        gateway = get_effective_llm_config()
        return "brainclaw" if gateway.is_brainclaw else _DEFAULT_CODEX_MODEL

    # EE/SaaS is deployment-configured. The gateway address and logical model
    # come from env, while an organization channel's key is authorized and
    # injected separately for each turn.
    return (
        os.environ.get("CODEX_MODEL", _DEFAULT_CODEX_MODEL).strip()
        or _DEFAULT_CODEX_MODEL
    )


def _codex_reasoning_effort() -> str:
    value = (
        os.environ.get(
            "CODEX_REASONING_EFFORT", _DEFAULT_CODEX_REASONING_EFFORT
        ).strip()
        or _DEFAULT_CODEX_REASONING_EFFORT
    ).lower()
    if value not in _CODEX_REASONING_EFFORT_VALUES:
        supported = ", ".join(sorted(_CODEX_REASONING_EFFORT_VALUES))
        raise RuntimeError(
            f"Unsupported CODEX_REASONING_EFFORT={value!r}; expected one of: {supported}"
        )
    return value


def _claude_model() -> str | None:
    model = os.environ.get("CLAUDE_MODEL", "").strip()
    return model or None


def _claude_sdk_available() -> bool:
    return importlib.util.find_spec("claude_agent_sdk") is not None


def is_claude_backend_available() -> bool:
    return _claude_cli_path().exists() and _claude_sdk_available()


def is_codex_backend_available() -> bool:
    codex_bin = _codex_bin_path()
    # Per-turn gateway credentials travel in App Server metadata. The SDK's
    # bundled 0.147 runtime logs that metadata verbatim, so only the explicitly
    # configured, DramaClaw-patched runtime is safe to start.
    return (
        codex_bin is not None
        and codex_bin.exists()
        and importlib.util.find_spec("openai_codex") is not None
    )


def is_hermes_backend_available() -> bool:
    """Lazy import so chat_service can be loaded without hermes deps."""
    try:
        from novelvideo.chat.hermes_pool import is_hermes_backend_available as _check
    except ImportError:
        return False
    return _check()


def is_chat_backend_available() -> bool:
    # NOTE: _chat_backend() raises when DRAMACLAW_CHAT_BACKEND=hermes is
    # requested but unavailable; catch so this probe stays non-throwing.
    try:
        backend = _chat_backend()
    except RuntimeError:
        return False
    if backend == "claude":
        return is_claude_backend_available()
    if backend == "codex":
        return is_codex_backend_available()
    if backend == "hermes":
        return is_hermes_backend_available()
    return False


def get_chat_backend_name() -> str:
    return _chat_backend()


def _repo_skill_roots() -> list[Path]:
    root = _repo_root()
    return [
        root / "src" / "novelvideo" / "agent_skills",
        root / ".claude" / "skills",
        root / ".codex" / "skills",
    ]


def _skill_sources() -> list[tuple[str, Path]]:
    sources: dict[str, Path] = {}
    for repo_skills_root in _repo_skill_roots():
        if not repo_skills_root.exists():
            continue
        for child in sorted(repo_skills_root.iterdir()):
            if child.is_dir() and (child / "SKILL.md").exists():
                # Keep the first matching skill name. Public agent skills are
                # preferred, followed by optional host-specific overlays.
                sources.setdefault(child.name, child)

    configured = (
        os.environ.get("CLAUDE_DRAMACLAW_SKILL_PATH")
        or os.environ.get("CLAUDE_SUPERTALE_SKILL_PATH")
        or ""
    ).strip()
    if configured:
        sources["dramaclaw"] = Path(configured).expanduser()

    return [(name, path) for name, path in sorted(sources.items()) if path.exists()]


def _sync_project_skills(skills_dir: Path, *, agent_profile: str = "main") -> None:
    skills_dir.mkdir(parents=True, exist_ok=True)
    profile = str(agent_profile or "main").strip() or "main"
    allowed = (
        {"freezone", "workflows", "dramaclaw-workflows"}
        if profile.startswith("freezone")
        else None
    )
    manifest_path = skills_dir / ".dramaclaw-managed-skills.json"
    previous_managed: set[str] = set()
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        if isinstance(payload, dict) and isinstance(payload.get("skills"), dict):
            previous_managed = {
                name
                for name in payload["skills"]
                if isinstance(name, str) and _is_safe_managed_skill_name(name)
            }
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        pass

    sources = {
        name: src for name, src in _skill_sources() if _is_safe_managed_skill_name(name)
    }
    managed_names = previous_managed | set(sources)
    active: dict[str, str] = {}
    for skill_name in sorted(managed_names):
        dst = _managed_skill_destination(skills_dir, skill_name)
        if dst is None:
            continue
        src = sources.get(skill_name)
        if src is None or (allowed is not None and skill_name not in allowed):
            _remove_managed_skill_path(dst, root=skills_dir)
            continue
        source_digest = _skill_tree_digest(src)
        destination_digest = _skill_tree_digest(dst) if dst.is_dir() else ""
        if source_digest != destination_digest:
            if not _remove_managed_skill_path(dst, root=skills_dir):
                continue
            shutil.copytree(src, dst)
        active[skill_name] = source_digest

    manifest_path.write_text(
        json.dumps(
            {"schema_version": 1, "profile": profile, "skills": active},
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def _is_safe_managed_skill_name(name: object) -> bool:
    if not isinstance(name, str) or not name or name != name.strip():
        return False
    candidate = Path(name)
    return (
        not candidate.is_absolute()
        and candidate.name == name
        and name not in {".", ".."}
        and "/" not in name
        and "\\" not in name
    )


def _managed_skill_destination(skills_dir: Path, skill_name: str) -> Path | None:
    if not _is_safe_managed_skill_name(skill_name):
        return None
    root = skills_dir.resolve()
    destination = skills_dir / skill_name
    try:
        resolved = destination.resolve(strict=False)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError):
        return None
    if resolved == root:
        return None
    return destination


def _remove_managed_skill_path(path: Path, *, root: Path) -> bool:
    root = root.resolve()
    try:
        resolved = path.resolve(strict=False)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError):
        return False
    if resolved == root:
        return False
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)
    return True


def _skill_tree_digest(root: Path) -> str:
    if not root.is_dir():
        return ""
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _project_dir(username: str, project: str) -> Path:
    base_dir = _output_root() / username / project
    for path in (
        base_dir,
        base_dir / "graph",
        base_dir / "assets",
        base_dir / "assets" / "characters",
        base_dir / "scripts",
        base_dir / "images",
        base_dir / "audio",
        base_dir / "videos",
        base_dir / "uploads",
    ):
        path.mkdir(parents=True, exist_ok=True)
    return base_dir


def _project_state_dir(username: str, project: str) -> Path:
    base_dir = _state_root() / username / project
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir


def _user_state_dir(username: str) -> Path:
    base_dir = _state_root() / username
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir


def _user_agent_workspace(username: str) -> Path:
    workspace = _user_state_dir(username) / ".chat_agents"
    workspace.mkdir(parents=True, exist_ok=True)
    return workspace


def _user_chat_agent_locks_dir(username: str) -> Path:
    base_dir = _user_state_dir(username) / "chat_agent_locks"
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir


def _legacy_chat_db_path(
    username: str,
    project: str,
    project_dir: str | Path | None = None,
) -> Path:
    base_dir = (
        Path(project_dir)
        if project_dir is not None
        else _project_dir(username, project)
    )
    return base_dir / ".chat" / "chat.db"


def _migrate_legacy_chat_db(
    username: str,
    project: str,
    new_db_path: Path,
    project_dir: str | Path | None = None,
    *,
    create_parent: bool = True,
) -> None:
    legacy_db_path = _legacy_chat_db_path(username, project, project_dir)
    if new_db_path.exists() or not legacy_db_path.exists():
        return
    if not create_parent and not new_db_path.parent.exists():
        return

    if create_parent:
        new_db_path.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        src = Path(f"{legacy_db_path}{suffix}")
        if not src.exists():
            continue
        dst = Path(f"{new_db_path}{suffix}")
        if dst.exists():
            continue
        shutil.move(str(src), str(dst))

    legacy_dir = legacy_db_path.parent
    try:
        if legacy_dir.exists() and not any(legacy_dir.iterdir()):
            legacy_dir.rmdir()
    except OSError:
        pass


def _chat_db_path(
    username: str,
    project: str,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> Path:
    if project_state_dir is not None:
        db_path = Path(project_state_dir) / "chat.db"
        _migrate_legacy_chat_db(
            username,
            project,
            db_path,
            project_dir,
            create_parent=True,
        )
        return db_path
    db_path = _project_state_dir(username, project) / "chat.db"
    _migrate_legacy_chat_db(username, project, db_path, project_dir, create_parent=True)
    return db_path


def _chat_input_history_path(username: str, project: str) -> Path:
    return _project_state_dir(username, project) / "chat_input_history.json"


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    configure_sqlite_connection(conn)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chat_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          media_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        )
        """)
    conn.commit()
    return conn


def load_chat_input_history(username: str, project: str) -> list[str]:
    if not username or not project:
        return []
    path = _chat_input_history_path(username, project)
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(payload, list):
        return []
    history: list[str] = []
    for item in payload:
        text = str(item or "").strip()
        if text:
            history.append(text)
    return history


def save_chat_input_history(
    username: str, project: str, history: list[str], *, limit: int = 200
) -> None:
    if not username or not project:
        return
    cleaned: list[str] = []
    for item in history:
        text = str(item or "").strip()
        if text:
            cleaned.append(text)
    if limit > 0:
        cleaned = cleaned[-limit:]
    path = _chat_input_history_path(username, project)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(
        json.dumps(cleaned, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp_path.replace(path)


def _get_setting(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute(
        "SELECT value FROM chat_settings WHERE key = ?", (key,)
    ).fetchone()
    return str(row["value"]) if row else None


def _set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO chat_settings(key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
        """,
        (key, value, _now_iso()),
    )
    conn.commit()


def _pid_is_alive(pid: int | None) -> bool:
    if pid is None or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _parse_chat_run_lock(
    value: str | None,
) -> tuple[str | None, int | None, datetime | None, datetime | None]:
    if not value:
        return None, None, None, None
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return value, None, None, None
    if not isinstance(payload, dict):
        return None, None, None, None
    lock_id = payload.get("lock_id")
    owner_pid = payload.get("owner_pid")
    started_at = payload.get("started_at")
    updated_at = payload.get("updated_at") or started_at
    return (
        str(lock_id).strip() or None if lock_id is not None else None,
        int(owner_pid) if isinstance(owner_pid, int) else None,
        _parse_iso_datetime(str(started_at)) if started_at is not None else None,
        _parse_iso_datetime(str(updated_at)) if updated_at is not None else None,
    )


def _chat_run_lock_is_stale(
    started_at: datetime | None,
    updated_at: datetime | None = None,
) -> bool:
    now = datetime.now(timezone.utc)
    if started_at is not None:
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        if (now - started_at).total_seconds() > _CHAT_RUN_LOCK_MAX_SECONDS:
            return True
    heartbeat_at = updated_at or started_at
    if heartbeat_at is None:
        return False
    if heartbeat_at.tzinfo is None:
        heartbeat_at = heartbeat_at.replace(tzinfo=timezone.utc)
    return (now - heartbeat_at).total_seconds() > _CHAT_RUN_LOCK_TTL_SECONDS


def _chat_run_lock_key(project: str) -> str:
    if project.startswith("freezone:"):
        return project
    return _CHAT_RUN_LOCK_KEY


def _chat_run_lock_project_for_turn(
    project: str,
    *,
    tool_mode: str,
    store_scope: Any | None = None,
) -> str:
    if tool_mode != "freezone_canvas":
        return project
    canvas_id = str(getattr(store_scope, "canvas_id", "") or "").strip()
    agent_id = str(getattr(store_scope, "agent_id", "") or "main").strip() or "main"
    if canvas_id:
        return f"freezone:{project}:canvas:{canvas_id}:agent:{agent_id}"
    return f"freezone:{project}:agent:{agent_id}"


def _chat_run_lock_path(username: str, project: str) -> Path:
    lock_key = _chat_run_lock_key(project)
    digest = hashlib.sha256(lock_key.encode("utf-8")).hexdigest()
    return _user_chat_agent_locks_dir(username) / f"{digest}.lock"


def _read_chat_run_lock_file(
    path: Path,
) -> tuple[str | None, int | None, datetime | None, datetime | None]:
    try:
        value = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, None, None, None
    except OSError:
        return None, None, None, None
    return _parse_chat_run_lock(value)


def _remove_chat_run_lock_file(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _atomic_write_chat_run_lock_file(path: Path, payload: str) -> None:
    tmp_path = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        tmp_path.write_text(payload, encoding="utf-8")
        tmp_path.replace(path)
    finally:
        tmp_path.unlink(missing_ok=True)


def _chat_run_lock_payload(lock_id: str, *, started_at: str | None = None) -> str:
    now = _now_iso()
    return json.dumps(
        {
            "lock_id": lock_id,
            "owner_pid": os.getpid(),
            "started_at": started_at or now,
            "updated_at": now,
        },
        ensure_ascii=False,
    )


def _chat_run_lock_file_is_new(path: Path) -> bool:
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return (
        datetime.now(timezone.utc).timestamp() - mtime
    ) < _CHAT_RUN_LOCK_BIRTH_GRACE_SECONDS


def _acquire_chat_run_lock(username: str, project: str) -> str:
    lock_path = _chat_run_lock_path(username, project)
    lock_id = uuid.uuid4().hex
    lock_payload = _chat_run_lock_payload(lock_id)
    payload_bytes = lock_payload.encode("utf-8")
    for _attempt in range(3):
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            existing_lock_id, owner_pid, started_at, updated_at = (
                _read_chat_run_lock_file(lock_path)
            )
            if not existing_lock_id and _chat_run_lock_file_is_new(lock_path):
                raise RuntimeError("当前用户已有 AI 对话正在处理中，请稍后再试。")
            if (
                existing_lock_id
                and _pid_is_alive(owner_pid)
                and not _chat_run_lock_is_stale(started_at, updated_at)
            ):
                raise RuntimeError("当前用户已有 AI 对话正在处理中，请稍后再试。")
            _remove_chat_run_lock_file(lock_path)
            continue
        try:
            with os.fdopen(fd, "wb") as file:
                file.write(payload_bytes)
            return lock_id
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            _remove_chat_run_lock_file(lock_path)
            raise
    raise RuntimeError("当前用户已有 AI 对话正在处理中，请稍后再试。")


def _release_chat_run_lock(username: str, project: str, lock_id: str) -> None:
    lock_path = _chat_run_lock_path(username, project)
    current_lock_id, _owner_pid, _started_at, _updated_at = _read_chat_run_lock_file(
        lock_path
    )
    if current_lock_id == lock_id:
        _remove_chat_run_lock_file(lock_path)


def _heartbeat_chat_run_lock(username: str, project: str, lock_id: str) -> bool:
    lock_path = _chat_run_lock_path(username, project)
    current_lock_id, _owner_pid, started_at, _updated_at = _read_chat_run_lock_file(
        lock_path
    )
    if current_lock_id != lock_id:
        return False
    payload = _chat_run_lock_payload(
        lock_id,
        started_at=started_at.isoformat() if started_at else None,
    )
    try:
        _atomic_write_chat_run_lock_file(lock_path, payload)
    except OSError:
        return False
    return True


def chat_run_lock_is_active(username: str, project: str = "") -> bool:
    lock_path = _chat_run_lock_path(username, project)
    existing_lock_id, owner_pid, started_at, updated_at = _read_chat_run_lock_file(
        lock_path
    )
    if (
        existing_lock_id
        and _pid_is_alive(owner_pid)
        and not _chat_run_lock_is_stale(started_at, updated_at)
    ):
        return True
    _remove_chat_run_lock_file(lock_path)
    return False


def force_release_chat_run_lock(username: str, project: str) -> None:
    _remove_chat_run_lock_file(_chat_run_lock_path(username, project))


#: A turn that ends without ever reaching a terminal event failed; it did not
#: succeed quietly.
_DEFAULT_TURN_DISPOSITION = "failed"


def _turn_operation_finalizer(authorization: Any | None) -> Any | None:
    """Own the egress claim for this turn, if there is one.

    Placed here rather than on the worker slot because this is the only layer
    that sees a whole business turn: the slot outlives it and the streaming loop
    is re-entered by both retry paths.
    """
    claim = getattr(authorization, "claim", None)
    if claim is None:
        return None
    from novelvideo.chat.hermes_operation import TurnOperationFinalizer
    from novelvideo.ports import get_egress_operation_port

    return TurnOperationFinalizer(get_egress_operation_port(), claim)


def _turn_disposition_for(event: Any) -> str:
    """Classify how this turn ended.

    ``complete`` is also synthesised for a timeout, so the event type cannot
    settle the ledger on its own.
    """
    from novelvideo.chat.hermes_operation import disposition_for

    return disposition_for(event)


def _evidence_identity(
    project: str | None, store_scope: Any | None, agent_profile: str
) -> dict[str, str]:
    """Name the trajectory and project this turn belongs to.

    ``project_group_id`` is the DramaClaw project, or the home sentinel when
    there is none — BrainClaw refuses to invent a grouping it cannot see, so the
    caller must say "no project" explicitly rather than omit it.

    ``trajectory_id`` is the most specific conversation scope available within
    the project: a Freezone canvas-and-Agent profile when there is one,
    otherwise the project-and-profile conversation. Project is part of both
    names so a reused canvas ID cannot merge evidence families across projects;
    the profile keeps the identity correct if multi-session UI is enabled again.
    Within that boundary this deliberately over-groups — every turn of one long
    conversation lands in one family — because over-grouping only costs
    statistical power, while under-grouping manufactures independence that
    does not exist.
    """
    from novelvideo.chat.hermes_egress import HOME_SCOPE_EGRESS_PROJECT_ID

    project_id = (project or "").strip() or HOME_SCOPE_EGRESS_PROJECT_ID
    canvas_id = str(getattr(store_scope, "canvas_id", "") or "").strip()
    trajectory_id = (
        f"canvas:{project_id}:{canvas_id}:{agent_profile}"
        if canvas_id
        else f"conversation:{project_id}:{agent_profile}"
    )
    return {"trajectory_id": trajectory_id, "project_id": project_id}


async def _chat_run_lock_heartbeat_loop(
    username: str, project: str, lock_id: str
) -> None:
    while True:
        await asyncio.sleep(_CHAT_RUN_LOCK_HEARTBEAT_SECONDS)
        if not _heartbeat_chat_run_lock(username, project, lock_id):
            return


def _append_message(
    conn: sqlite3.Connection,
    role: str,
    content: str,
    media: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    media = media or []
    created_at_iso = _now_iso()
    cursor = conn.execute(
        """
        INSERT INTO chat_messages(role, content, media_json, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (role, content, json.dumps(media, ensure_ascii=False), created_at_iso),
    )
    conn.commit()
    return {
        "id": int(cursor.lastrowid),
        "role": role,
        "content": content,
        "media": media,
        "created_at": created_at_iso,
    }


def _split_trace_contents(content: str) -> list[str]:
    raw_lines = str(content or "").rstrip().splitlines()
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in raw_lines:
        if not line.strip():
            if current:
                blocks.append(current)
                current = []
            continue
        current.append(line)
    if current:
        blocks.append(current)
    return ["\n".join(block) for block in blocks if block]


def _is_hidden_chat_tool_event(name: object, text: object) -> bool:
    """Internal Hermes bookkeeping tools should not become user-visible cards."""
    haystack = f"{name or ''}\n{text or ''}".lower()
    return any(marker in haystack for marker in _HIDDEN_TOOL_MARKERS)


def _is_anonymous_hermes_tool_call_update(event: Any) -> bool:
    raw = getattr(event, "raw", None)
    if getattr(event, "name", None) is not None or not isinstance(raw, dict):
        return False
    return raw.get("sessionUpdate") == "tool_call_update" and bool(
        str(raw.get("toolCallId") or "").strip()
    )


def _is_hermes_lifecycle_tool_update(event: Any) -> bool:
    raw = getattr(event, "raw", None)
    if not isinstance(raw, dict):
        return False
    kind = raw.get("sessionUpdate")
    if kind == "tool_call":
        return True
    if kind != "tool_call_update":
        return False
    has_result_payload = any(
        raw.get(key) not in (None, "", [], {})
        for key in ("content", "result", "data", "output", "message", "error")
    )
    if has_result_payload:
        return False
    text = str(getattr(event, "text", "") or "").strip().lower()
    status = str(raw.get("status") or "").strip().lower()
    return bool(status) and text in {status, f"{status}."}


def _completion_text_or_existing(event_text: object, existing: str) -> str:
    """ACP may finish with metadata like ``stop=end_turn`` after text deltas."""
    final_text = str(event_text or "").strip()
    if not final_text or final_text.startswith("stop="):
        return existing
    if final_text.lower() == "(hermes timed out)" and existing.strip():
        return existing
    if existing.strip() and _is_completion_notice(final_text):
        if final_text in existing:
            return existing
        return f"{existing.rstrip()}\n\n{final_text}"
    return final_text


def _is_completion_notice(text: str) -> bool:
    return text in {
        "当前任务已开始处理。请稍后让我查看当前任务进度，或在任务完成后再继续下一步。",
        "刚才这一步没有成功启动任务。请先根据返回的错误补齐前置条件；如果是配音缺少声线，可以到「虾塘」上传或录制缺失声线后再继续。",
    }


def _merge_stream_text(existing: str, incoming: object) -> str:
    """Support providers that emit either cumulative text or delta chunks."""
    chunk = str(incoming or "")
    if not chunk:
        return existing
    if chunk.startswith(existing):
        return chunk
    return existing + chunk


async def _emit_chat_event_best_effort(on_event, event: dict[str, Any]) -> bool:
    """Emit to the connected client without making persistence depend on it."""
    try:
        await on_event(event)
        return True
    except Exception:
        return False


def _assistant_prefix_candidates(previous_assistant: object) -> list[str]:
    if isinstance(previous_assistant, (list, tuple)):
        items = [
            str(item or "").strip()
            for item in previous_assistant
            if str(item or "").strip()
        ]
        candidates = []
        for index in range(len(items)):
            suffix = items[index:]
            candidates.append("".join(suffix))
            candidates.append("\n".join(suffix))
            candidates.append("\n\n".join(suffix))
        candidates.extend(items)
        return sorted(set(candidates), key=len, reverse=True)
    prefix = str(previous_assistant or "").strip()
    return [prefix] if prefix else []


def _bounded_replay_history(contents: list[str]) -> list[str]:
    """Keep only a small display-dedup window; this history never becomes agent context."""

    bounded = [
        str(content or "") for content in contents[-_HERMES_REPLAY_HISTORY_MESSAGES:]
    ]
    return [
        content[:_HERMES_REPLAY_HISTORY_MAX_CHARS] for content in bounded if content
    ]


def _is_truncated_assistant_replay(content: str, candidates: list[str]) -> bool:
    """Detect a sufficiently long strict prefix of previously emitted assistant text."""
    compact_content = "".join(str(content or "").split())
    if len(compact_content) < 16:
        return False

    compact_candidates = {"".join(candidate.split()) for candidate in candidates}
    if compact_content in compact_candidates:
        return False
    return any(
        candidate.startswith(compact_content) for candidate in compact_candidates
    )


def _strip_replayed_assistant_prefix(
    content: str,
    previous_assistant: object,
    *,
    suppress_partial_replay: bool = False,
    candidates: list[str] | None = None,
) -> str:
    """Hermes ACP can replay prior assistant text at the start of a new turn."""
    text = str(content or "")
    original_text = text
    prefixes = (
        candidates
        if candidates is not None
        else _assistant_prefix_candidates(previous_assistant)
    )
    if _is_truncated_assistant_replay(text, prefixes):
        return ""
    while text and prefixes:
        original = text
        for prefix in prefixes:
            if text.startswith(prefix):
                text = text[len(prefix) :].lstrip()
                break
            compact_prefix = "".join(prefix.split())
            if not compact_prefix:
                continue
            matched = 0
            end_index = 0
            for index, char in enumerate(text):
                if char.isspace():
                    continue
                if matched >= len(compact_prefix) or char != compact_prefix[matched]:
                    break
                matched += 1
                end_index = index + 1
                if matched == len(compact_prefix):
                    text = text[end_index:].lstrip()
                    break
            if text != original:
                break
        if text == original:
            break
    if suppress_partial_replay and not text.strip() and str(content or "").strip():
        return ""
    if not suppress_partial_replay and not text.strip() and original_text.strip():
        return original_text
    return text


def _compact_chat_text(content: object) -> str:
    return "".join(str(content or "").split())


def _strip_leading_assistant_label(content: str) -> str:
    return _ASSISTANT_TURN_LABEL_RE.sub("", str(content or ""), count=1).lstrip()


def _looks_like_labeled_transcript_replay(content: str) -> bool:
    text = str(content or "").lstrip()
    if not text:
        return False
    if _USER_TURN_LABEL_RE.match(text):
        return True
    return bool(
        _USER_TURN_LABEL_RE.search(text) and _ASSISTANT_TURN_LABEL_RE.search(text)
    )


def _strip_replayed_turn_transcript(
    content: str,
    current_prompt: object,
    *,
    suppress_partial_replay: bool = False,
) -> str:
    """Remove a replayed labeled transcript while keeping normal short replies intact."""
    text = str(content or "")
    prompt = str(current_prompt or "").strip()
    if not text or not prompt:
        return text

    compact_prompt = _compact_chat_text(prompt)
    best_end = -1
    for match in _USER_TURN_LABEL_RE.finditer(text):
        start = match.end()
        line_end = text.find("\n", start)
        if line_end < 0:
            line_end = len(text)
        line = text[start:line_end]

        prompt_index = line.rfind(prompt)
        if prompt_index >= 0:
            best_end = max(best_end, start + prompt_index + len(prompt))
            continue

        if len(compact_prompt) >= 4 and compact_prompt in _compact_chat_text(line):
            best_end = max(best_end, line_end)

    if best_end < 0:
        if suppress_partial_replay and _looks_like_labeled_transcript_replay(text):
            return ""
        return text
    remainder = _strip_leading_assistant_label(text[best_end:])
    if suppress_partial_replay and not remainder.strip():
        return ""
    return remainder


def _strip_replayed_chat_response(
    content: str,
    previous_assistant: object,
    current_prompt: object,
    *,
    suppress_partial_replay: bool = False,
    assistant_prefix_candidates: list[str] | None = None,
) -> str:
    text = _strip_replayed_turn_transcript(
        content,
        current_prompt,
        suppress_partial_replay=suppress_partial_replay,
    )
    return _strip_replayed_assistant_prefix(
        text,
        previous_assistant,
        suppress_partial_replay=suppress_partial_replay,
        candidates=assistant_prefix_candidates,
    )


def _json_loads_with_trailing_repair(raw: str) -> Any:
    text = str(raw or "").strip()
    if not text:
        raise ValueError("empty ui-spec")
    first_object = text.find("{")
    first_array = text.find("[")
    starts = [index for index in (first_object, first_array) if index >= 0]
    if not starts:
        raise ValueError("ui-spec does not contain JSON")
    start = min(starts)
    text = text[start:].strip()

    candidates = [text]
    stack: list[str] = []
    in_string = False
    escaped = False
    for char in text:
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == "{":
            stack.append("}")
        elif char == "[":
            stack.append("]")
        elif char in {"}", "]"} and stack and stack[-1] == char:
            stack.pop()
    if 0 < len(stack) <= 4:
        candidates.append(text + "".join(reversed(stack)))

    last_object = text.rfind("}")
    last_array = text.rfind("]")
    end = max(last_object, last_array)
    if end >= 0:
        candidates.append(text[: end + 1])

    errors: list[str] = []
    for candidate in dict.fromkeys(candidates):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as exc:
            errors.append(str(exc))
    raise ValueError("; ".join(errors) or "invalid ui-spec JSON")


def _canonicalize_ui_spec(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("ui-spec root must be an object")
    spec = dict(value)
    spec_type = spec.get("type")
    root = spec.get("root")
    elements = spec.get("elements")
    if not isinstance(spec_type, str) or not spec_type.strip():
        raise ValueError("ui-spec.type is required")
    if not isinstance(root, str) or not root.strip():
        raise ValueError("ui-spec.root is required")
    if not isinstance(elements, dict) or not elements:
        raise ValueError("ui-spec.elements is required")
    if root not in elements:
        raise ValueError("ui-spec.root must point to an element")

    canonical_elements: dict[str, Any] = {}
    for key, element in elements.items():
        if not isinstance(key, str) or not key:
            raise ValueError("ui-spec element keys must be strings")
        if not isinstance(element, dict):
            raise ValueError(f"ui-spec element {key} must be an object")
        element_type = element.get("type")
        if not isinstance(element_type, str) or not element_type.strip():
            raise ValueError(f"ui-spec element {key}.type is required")
        props = element.get("props")
        children = element.get("children")
        if props is None:
            props = {}
        if children is None:
            children = []
        if not isinstance(props, dict):
            raise ValueError(f"ui-spec element {key}.props must be an object")
        if not isinstance(children, list) or not all(
            isinstance(child, str) for child in children
        ):
            raise ValueError(f"ui-spec element {key}.children must be a string array")
        normalized_props = dict(props)
        legacy_text = normalized_props.get("children")
        if isinstance(legacy_text, str):
            if (
                element_type in {"Text", "Heading"}
                and "content" not in normalized_props
            ):
                normalized_props["content"] = legacy_text
                normalized_props.pop("children", None)
            elif element_type == "Badge" and "label" not in normalized_props:
                normalized_props["label"] = legacy_text
                normalized_props.pop("children", None)

        if element_type == "Stack" and "direction" not in normalized_props:
            if normalized_props.get("row") is True:
                normalized_props["direction"] = "row"
            elif normalized_props.get("row") is False:
                normalized_props["direction"] = "column"

        canonical_elements[key] = {
            **element,
            "type": element_type,
            "props": normalized_props,
            "children": children,
        }

    reachable: set[str] = set()
    pending = [root]
    while pending:
        key = pending.pop()
        if key in reachable:
            continue
        element = canonical_elements.get(key)
        if element is None:
            raise ValueError(f"ui-spec references missing child {key}")
        reachable.add(key)
        pending.extend(element["children"])

    spec["type"] = spec_type
    spec["root"] = root
    spec["elements"] = canonical_elements
    return spec


def _log_json_render_error(error: ValueError, body: str) -> None:
    original_body = str(body or "")
    raw_body = original_body
    max_chars = 12000
    if len(raw_body) > max_chars:
        raw_body = f"{raw_body[:max_chars]}\n...[truncated {len(original_body) - max_chars} chars]"
    entry = f"\n--- {_now_iso()} ---\n" f"error: {error}\n" "body:\n" f"{raw_body}\n"
    try:
        path = _json_render_error_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(entry)
    except OSError:
        return


def _normalize_single_ui_spec_block(body: str) -> str:
    nested_start = body.lower().rfind("<ui-spec")
    if nested_start >= 0:
        close_index = body.lower().find("</ui-spec>", nested_start)
        if close_index >= 0:
            nested_block = body[nested_start : close_index + len("</ui-spec>")]
            return _normalize_json_render_reply(nested_block)

    try:
        value = _json_loads_with_trailing_repair(body)
        if isinstance(value, list):
            specs = [_canonicalize_ui_spec(item) for item in value]
            return _wrap_ui_spec_bundle(specs)
        spec = _canonicalize_ui_spec(value)
    except ValueError as exc:
        _log_json_render_error(exc, body)
        return "（json-render 格式校验失败：模型返回的 ui-spec 不是合法 canonical JSON，已阻止展示。请重新生成。）"

    spec_type = spec.get("type") if isinstance(spec.get("type"), str) else "ui_spec"
    json_text = json.dumps(spec, ensure_ascii=False, indent=2)
    return f'<ui-spec type="{spec_type}">\n{json_text}\n</ui-spec>'


def _normalize_json_render_reply(content: str) -> str:
    text = str(content or "")
    text = _wrap_embedded_ui_spec_json(text)
    if "<ui-spec" not in text.lower():
        return text
    text = _UI_SPEC_FENCE_RE.sub(lambda match: match.group(1).strip(), text)
    return _UI_SPEC_BLOCK_RE.sub(
        lambda match: _normalize_single_ui_spec_block(match.group(1)),
        text,
    )


def _wrap_embedded_ui_spec_json(content: str) -> str:
    text = str(content or "")
    if "<ui-spec" in text.lower():
        return text
    if '"elements"' not in text or '"root"' not in text:
        return text

    decoder = json.JSONDecoder()
    index = 0
    parts: list[str] = []
    changed = False
    while index < len(text):
        start = text.find("{", index)
        if start < 0:
            parts.append(text[index:])
            break
        parts.append(text[index:start])
        try:
            value, end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            parts.append(text[start : start + 1])
            index = start + 1
            continue
        if isinstance(value, dict):
            try:
                spec = _canonicalize_ui_spec(value)
            except ValueError:
                spec = None
            if spec is not None:
                parts.append(_ui_spec_block(spec))
                index = start + end
                changed = True
                continue
        parts.append(text[start : start + end])
        index = start + end

    if not changed:
        return text
    return re.sub(r"\n{3,}", "\n\n", "".join(parts)).strip()


def _redact_local_filesystem_paths(content: str) -> str:
    """Hide local developer paths before text is shown or persisted in chat."""
    text = str(content or "")
    if not text:
        return ""
    return _LOCAL_FILESYSTEM_PATH_RE.sub("[本地路径]", text)


def _strip_media_rendering_leaks(content: str) -> str:
    """Remove internal rendering/tool chatter that models sometimes echo."""
    lines: list[str] = []
    for line in str(content or "").splitlines():
        stripped = line.strip()
        lower = stripped.lower()
        if not stripped:
            lines.append(line)
            continue
        if "<ui-spec" in lower or "ui-spec" in lower or "ui_spec" in lower:
            continue
        if (
            "json-render" in lower
            or "automatically rendered" in lower
            or "backend" in lower
        ):
            continue
        if "dramaclaw_" in lower:
            continue
        if "按规范渲染" in stripped or "UI画廊" in stripped:
            continue
        lines.append(line)
    text = _redact_local_filesystem_paths("\n".join(lines).strip())
    return re.sub(r"\n{3,}", "\n\n", text)


def _strip_embedded_ui_spec_json_text(content: str) -> str:
    """Remove model-written media JSON from prose before appending tool specs."""
    text = str(content or "")
    pattern = re.compile(
        r'\{\s*"type"\s*:\s*"(?:character_showcase|sketch_gallery|keyframe_video|audio_list|media_bundle)"'
    )
    index = 0
    parts: list[str] = []
    decoder = json.JSONDecoder()
    changed = False

    while True:
        match = pattern.search(text, index)
        if not match:
            parts.append(text[index:])
            break
        start = match.start()
        parts.append(text[index:start])
        try:
            value, end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            next_paragraph = text.find("\n\n", start)
            index = len(text) if next_paragraph < 0 else next_paragraph
            changed = True
            continue
        if isinstance(value, dict):
            try:
                _canonicalize_ui_spec(value)
                index = start + end
                changed = True
                continue
            except ValueError:
                pass
        parts.append(text[start : start + end])
        index = start + end

    if not changed:
        return text.strip()
    return re.sub(r"\n{3,}", "\n\n", "".join(parts)).strip()


def _extract_tool_ui_specs(value: Any) -> list[dict[str, Any]]:
    specs: list[dict[str, Any]] = []

    def append_spec(node: Any) -> None:
        try:
            specs.append(_canonicalize_ui_spec(node))
        except ValueError as exc:
            _log_json_render_error(
                exc, json.dumps(node, ensure_ascii=False, default=str)
            )

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            ui_spec = node.get("ui_spec")
            if isinstance(ui_spec, dict):
                append_spec(ui_spec)
            elif {"type", "root", "elements"}.issubset(node):
                append_spec(node)
            for child in node.values():
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)
        elif isinstance(node, str):
            text = node.strip()
            if not text or len(text) > 1_000_000:
                return
            if "<ui-spec" in text.casefold():
                _, embedded_specs = _split_ui_specs_from_text(text)
                specs.extend(embedded_specs)
                return
            if "ui_spec" not in text and not {"type", "root", "elements"}.issubset(
                set(re.findall(r'"([^"]+)"\s*:', text))
            ):
                return
            try:
                decoded = json.loads(text)
            except json.JSONDecodeError:
                return
            visit(decoded)

    visit(value)
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for spec in specs:
        key = json.dumps(spec, ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(spec)
    return deduped


def _extract_tool_chat_error(value: Any) -> str | None:
    def normalize_error_text(text: object) -> str:
        raw = redact_secrets(str(text or "")).strip()
        raw = re.sub(r"\s+", " ", raw)
        raw = re.sub(
            r"provider_response_id[\"']?\s*[:=]\s*[\"']?[^\"'\s,;}]+",
            "provider_response_id=[redacted]",
            raw,
            flags=re.IGNORECASE,
        )
        raw = re.sub(
            r"response_id[\"']?\s*[:=]\s*[\"']?[^\"'\s,;}]+",
            "response_id=[redacted]",
            raw,
            flags=re.IGNORECASE,
        )
        if len(raw) > 1200:
            raw = raw[:1200].rstrip() + "..."
        return raw

    def business_chat_error_from_text(text: object) -> str | None:
        raw = normalize_error_text(text)
        if not raw:
            return None
        if "Render 模式需要草图" in raw or "未生成可用图片" in raw:
            return (
                "Render 任务没有生成可用图片：当前缺少必要草图前置。"
                "请先在「虾塘」生成或确认对应 Beat 的草图后，再重新生成 Render。"
                f"\n\n错误原因：{raw[:1200]}"
            )
        return None

    def generic_chat_error_from_text(text: object) -> str | None:
        raw = normalize_error_text(text)
        if not raw:
            return None
        lowered = raw.casefold()
        if "provider_response_id" in lowered and "content_filter" in lowered:
            return None
        return f"任务执行失败：{raw}"

    def parse_jsonish(text: str) -> Any | None:
        raw = str(text or "").strip()
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
        try:
            return _json_loads_with_trailing_repair(raw)
        except ValueError:
            return None

    def visit(node: Any) -> str | None:
        if isinstance(node, str):
            decoded = parse_jsonish(node)
            if decoded is not None:
                return visit(decoded)
            return None
        if isinstance(node, list):
            for child in node:
                found = visit(child)
                if found:
                    return found
            return None
        if not isinstance(node, dict):
            return None

        chat_error = node.get("chat_error")
        if isinstance(chat_error, str) and chat_error.strip():
            return chat_error.strip()

        for key in ("error", "detail", "message"):
            mapped = business_chat_error_from_text(node.get(key))
            if mapped:
                return mapped

        status = str(node.get("status") or "").strip().lower()
        failed_status = status in {"failed", "error", "cancelled", "canceled"}
        ok_false = node.get("ok") is False
        if failed_status or ok_false:
            for key in ("error", "detail", "message"):
                generic = generic_chat_error_from_text(node.get(key))
                if generic:
                    return generic
            if failed_status:
                return f"任务执行失败：当前状态为 {status}。"
            return "任务执行失败：接口返回 ok=false，但没有提供具体错误原因。"

        for key in ("result", "message", "content", "data", "output"):
            found = visit(node.get(key))
            if found:
                return found
        for child in node.values():
            found = visit(child)
            if found:
                return found
        return None

    return visit(value)


def _decode_tool_jsonish(text: str) -> Any | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    try:
        return _json_loads_with_trailing_repair(raw)
    except ValueError:
        return None


def _contains_freezone_canvas_bridge_result(value: Any) -> bool:
    """Return true when a Hermes tool update contains a Freezone bridge result."""
    if isinstance(value, str):
        decoded = _decode_tool_jsonish(value)
        if decoded is None:
            return False
        return _contains_freezone_canvas_bridge_result(decoded)
    if isinstance(value, list):
        return any(_contains_freezone_canvas_bridge_result(item) for item in value)
    if not isinstance(value, dict):
        return False

    has_bridge_status = "tool_call_status" in value or "canvas_apply_status" in value
    has_bridge_body = (
        "command_results" in value
        or "applied_count" in value
        or "opened_ui_actions" in value
        or "created_node_ids" in value
        or "user_message" in value
        or "agent_instruction" in value
    )
    if has_bridge_status and has_bridge_body:
        return True

    return any(
        _contains_freezone_canvas_bridge_result(child) for child in value.values()
    )


def _suppress_freezone_tool_lifecycle_error(value: Any, *, tool_mode: str) -> bool:
    """Ignore Hermes lifecycle-only failures for Freezone canvas bridge tools.

    Freezone canvas commands are resolved by the frontend bridge result.  A
    bare Hermes ``tool_call_update.status=failed`` can be transient lifecycle
    noise and must not be surfaced as the canvas command result.
    """
    if tool_mode != "freezone_canvas" or not isinstance(value, dict):
        return False
    if value.get("sessionUpdate") != "tool_call_update":
        return False
    status = str(value.get("status") or "").strip().lower()
    if status not in {"failed", "error", "cancelled", "canceled"}:
        return False
    business_payload_keys = {
        "chat_error",
        "error",
        "detail",
        "message",
        "result",
        "content",
        "data",
        "output",
    }
    if not any(key in value for key in business_payload_keys):
        return True
    return _contains_freezone_canvas_bridge_result(value)


def _strip_freezone_tool_lifecycle_failure_text(text: str, *, tool_mode: str) -> str:
    if tool_mode != "freezone_canvas":
        return text
    return re.sub(
        r"\A\s*任务执行失败：当前状态为\s+(?:failed|error|cancelled|canceled)。\s*",
        "",
        text,
        flags=re.IGNORECASE,
    ).lstrip()


def _visible_tool_chat_error_for_mode(
    text: str | None, *, tool_mode: str
) -> str | None:
    if not text:
        return None
    visible = _strip_freezone_tool_lifecycle_failure_text(text, tool_mode=tool_mode)
    return visible or None


def _ui_spec_json(spec: dict[str, Any]) -> tuple[str, str]:
    canonical = _canonicalize_ui_spec(spec)
    spec_type = (
        canonical.get("type") if isinstance(canonical.get("type"), str) else "ui_spec"
    )
    return spec_type, json.dumps(canonical, ensure_ascii=False, indent=2)


def _wrap_ui_spec_json(spec_type: str, json_text: str) -> str:
    return f'<ui-spec type="{spec_type}">\n' f"{json_text}\n" "</ui-spec>"


def _wrap_ui_spec_bundle(specs: list[dict[str, Any]]) -> str:
    canonical_specs = [_canonicalize_ui_spec(spec) for spec in specs]
    if len(canonical_specs) == 1:
        spec_type = canonical_specs[0].get("type")
        return _wrap_ui_spec_json(
            spec_type if isinstance(spec_type, str) and spec_type else "ui_spec",
            json.dumps(canonical_specs[0], ensure_ascii=False, indent=2),
        )
    return _wrap_ui_spec_json(
        "media_bundle",
        json.dumps(canonical_specs, ensure_ascii=False, indent=2),
    )


def _ui_spec_block(spec: dict[str, Any]) -> str:
    spec_type, json_text = _ui_spec_json(spec)
    return _wrap_ui_spec_json(spec_type, json_text)


_MERGEABLE_MEDIA_SPEC_TYPES = {
    "character_showcase",
    "sketch_gallery",
    "keyframe_video",
    "audio_list",
}


def _can_merge_ui_specs(left: dict[str, Any], right: dict[str, Any]) -> bool:
    spec_type = left.get("type")
    if spec_type != right.get("type") or spec_type not in _MERGEABLE_MEDIA_SPEC_TYPES:
        return False
    left_elements = left.get("elements")
    right_elements = right.get("elements")
    left_root_id = left.get("root")
    right_root_id = right.get("root")
    if not (
        isinstance(left_elements, dict)
        and isinstance(right_elements, dict)
        and isinstance(left_root_id, str)
        and isinstance(right_root_id, str)
    ):
        return False
    left_root = left_elements.get(left_root_id)
    right_root = right_elements.get(right_root_id)
    if not isinstance(left_root, dict) or not isinstance(right_root, dict):
        return False
    return left_root.get("type") == right_root.get("type") == "Stack"


def _merge_ui_specs(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    left = _canonicalize_ui_spec(left)
    right = _canonicalize_ui_spec(right)
    left_elements = dict(left["elements"])
    right_elements = right["elements"]
    left_root_id = left["root"]
    right_root_id = right["root"]
    left_root = dict(left_elements[left_root_id])
    right_root = right_elements[right_root_id]
    left_children = list(left_root.get("children") or [])
    right_children = list(right_root.get("children") or [])

    def unique_key(key: str) -> str:
        if key not in left_elements:
            return key
        index = 2
        while f"{key}_{index}" in left_elements:
            index += 1
        return f"{key}_{index}"

    key_map: dict[str, str] = {}
    for key, element in right_elements.items():
        if key == right_root_id:
            continue
        next_key = unique_key(key)
        key_map[key] = next_key
        left_elements[next_key] = element

    left_root["children"] = [
        *left_children,
        *[
            key_map.get(child, child)
            for child in right_children
            if isinstance(child, str)
        ],
    ]
    left_elements[left_root_id] = left_root
    return {**left, "elements": left_elements}


def _merge_tool_ui_specs_by_type(specs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    merge_indexes: dict[str, int] = {}
    for spec in specs:
        spec_type = spec.get("type")
        merge_index = (
            merge_indexes.get(spec_type) if isinstance(spec_type, str) else None
        )
        if merge_index is not None and _can_merge_ui_specs(merged[merge_index], spec):
            try:
                merged[merge_index] = _merge_ui_specs(merged[merge_index], spec)
                continue
            except ValueError as exc:
                _log_json_render_error(exc, json.dumps(spec, ensure_ascii=False))
        merged.append(spec)
        if isinstance(spec_type, str) and spec_type in _MERGEABLE_MEDIA_SPEC_TYPES:
            merge_indexes.setdefault(spec_type, len(merged) - 1)
    return merged


def _append_tool_ui_specs(content: str, specs: list[dict[str, Any]]) -> str:
    raw_text = str(content or "").strip()
    if specs and _UI_SPEC_BLOCK_RE.search(raw_text):
        return raw_text
    text = _strip_media_rendering_leaks(raw_text)
    if not specs:
        return text
    text = _strip_embedded_ui_spec_json_text(text)
    specs = _merge_tool_ui_specs_by_type(specs)
    blocks: list[str] = []
    for spec in specs:
        try:
            blocks.append(_ui_spec_block(spec))
        except ValueError as exc:
            _log_json_render_error(exc, json.dumps(spec, ensure_ascii=False))
    if not blocks:
        return text
    prefix = text or "已为你展示相关媒体。"
    return f"{prefix}\n\n" + "\n\n".join(blocks)


def _allows_mainline_media_ui_specs(tool_mode: str) -> bool:
    """Mainline media galleries are for DramaClaw chat, not Freezone canvas replies."""
    return str(tool_mode or "").strip() != "freezone_canvas"


def _split_ui_specs_from_text(content: str) -> tuple[str, list[dict[str, Any]]]:
    text = str(content or "")
    if "<ui-spec" not in text.lower():
        return text, []

    text = _UI_SPEC_FENCE_RE.sub(lambda match: match.group(1).strip(), text)
    specs: list[dict[str, Any]] = []

    def replace_block(match: re.Match[str]) -> str:
        body = match.group(1)
        try:
            value = _json_loads_with_trailing_repair(body)
            if isinstance(value, list):
                specs.extend(_canonicalize_ui_spec(item) for item in value)
            else:
                specs.append(_canonicalize_ui_spec(value))
        except ValueError as exc:
            _log_json_render_error(exc, body)
            return "（json-render 格式校验失败：模型返回的 ui-spec 不是合法 canonical JSON，已阻止展示。请重新生成。）"
        return ""

    display_text = _UI_SPEC_BLOCK_RE.sub(replace_block, text)
    display_text = re.sub(r"\n{3,}", "\n\n", display_text).strip()
    return display_text, specs


def _dedupe_tool_ui_specs(specs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for spec in specs:
        key = json.dumps(spec, ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(spec)
    return deduped


def _prompt_wants_sketch_only(prompt: str) -> bool:
    text = str(prompt or "")
    if "草图" not in text and "sketch" not in text.casefold():
        return False
    frame_terms = (
        "首帧",
        "第一帧",
        "关键帧",
        "first frame",
        "first-frame",
        "keyframe",
        "frame",
    )
    return not any(term in text.casefold() for term in frame_terms)


def _is_frame_image_element(element: Any) -> bool:
    if not isinstance(element, dict):
        return False
    props = element.get("props")
    if not isinstance(props, dict):
        return False
    fields = [
        props.get("src"),
        props.get("poster"),
        props.get("title"),
        props.get("alt"),
        props.get("description"),
        props.get("overlayTitle"),
        props.get("overlayDescription"),
    ]
    text = "\n".join(str(value or "") for value in fields).casefold()
    return (
        "首帧" in text
        or "/frames/" in text
        or "first frame" in text
        or "first-frame" in text
    )


def _filter_tool_ui_specs_for_prompt(
    prompt: str, specs: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    if not specs:
        return specs

    if _prompt_continues_video_generation_without_display(prompt):
        specs = [spec for spec in specs if not _is_beat_video_ui_spec(spec)]

    if not specs or not _prompt_wants_sketch_only(prompt):
        return specs

    filtered_specs: list[dict[str, Any]] = []
    for spec in specs:
        if not isinstance(spec, dict) or spec.get("type") != "sketch_gallery":
            filtered_specs.append(spec)
            continue
        elements = spec.get("elements")
        root_key = spec.get("root")
        if not isinstance(elements, dict) or not isinstance(root_key, str):
            filtered_specs.append(spec)
            continue
        root = elements.get(root_key)
        if not isinstance(root, dict):
            filtered_specs.append(spec)
            continue
        children = root.get("children")
        if not isinstance(children, list):
            filtered_specs.append(spec)
            continue

        kept_children: list[str] = []
        kept_elements: dict[str, Any] = {}
        for key, element in elements.items():
            if key == root_key:
                continue
            if key in children and _is_frame_image_element(element):
                continue
            kept_elements[key] = element
            if key in children:
                kept_children.append(key)

        if not kept_children:
            continue
        new_root = copy.deepcopy(root)
        new_root["children"] = kept_children
        filtered_specs.append(
            {
                **spec,
                "elements": {
                    root_key: new_root,
                    **{key: kept_elements[key] for key in kept_elements},
                },
            }
        )
    return filtered_specs


def _prompt_continues_video_generation_without_display(prompt: str) -> bool:
    text = str(prompt or "").strip()
    lower = text.casefold()
    continue_terms = ("继续", "恢复", "接着", "下一步", "继续跑", "继续做")
    video_terms = ("视频", "beat", "镜头", "成片", "生成")
    display_terms = (
        "展示",
        "显示",
        "查看",
        "看看",
        "看一下",
        "播放",
        "预览",
        "给我看",
        "show",
        "display",
        "view",
        "preview",
        "play",
    )
    return (
        any(term in lower for term in continue_terms)
        and any(term in lower for term in video_terms)
        and not any(term in lower for term in display_terms)
    )


def _is_beat_video_ui_spec(spec: dict[str, Any]) -> bool:
    if not isinstance(spec, dict) or spec.get("type") != "keyframe_video":
        return False
    elements = spec.get("elements")
    if not isinstance(elements, dict):
        return False
    for element in elements.values():
        if not isinstance(element, dict) or element.get("type") != "Video":
            continue
        props = element.get("props")
        if not isinstance(props, dict):
            continue
        title = str(props.get("title") or "")
        src = str(props.get("src") or "")
        if re.search(r"\bbeat\s*\d+\b", title, re.IGNORECASE) or "/beats/" in src:
            return True
    return False


_DISPLAY_TOOL_NAMES = {
    "dramaclaw_get_sketches",
    "dramaclaw_get_sketch_candidates",
    "dramaclaw_get_first_frames",
    "dramaclaw_get_scene_images",
    "dramaclaw_get_character_media",
    "dramaclaw_get_episode_media",
    "dramaclaw_get_final_video",
}


def _limit_display_items(
    items: list[dict[str, Any]], args: dict[str, Any], default: int
) -> list[dict[str, Any]]:
    try:
        limit = int(args.get("limit")) if args.get("limit") is not None else default
    except (TypeError, ValueError):
        limit = default
    try:
        offset = int(args.get("offset") or 0)
    except (TypeError, ValueError):
        offset = 0
    offset = max(0, offset)
    limit = max(1, min(limit, default))
    return items[offset : offset + limit]


def _requested_display_beats(args: dict[str, Any]) -> set[int] | None:
    raw = args.get("beat_indices") or args.get("beats")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("beat", "beat_num", "beat_number", "index"):
        if args.get(key) is not None:
            values.append(args[key])
    beats: set[int] = set()
    for value in values:
        try:
            beat = int(value)
        except (TypeError, ValueError):
            continue
        if beat > 0:
            beats.add(beat)
    return beats or None


def _requested_display_names(args: dict[str, Any]) -> set[str] | None:
    raw = args.get("names")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("name", "character"):
        if args.get(key) is not None:
            values.append(args[key])
    names = {str(value).strip() for value in values if str(value or "").strip()}
    return names or None


def _requested_display_queries(args: dict[str, Any]) -> set[str] | None:
    raw = args.get("queries") or args.get("keywords")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("query", "search", "keyword", "text", "identity_name"):
        if args.get(key) is not None:
            values.append(args[key])
    queries = {str(value).strip() for value in values if str(value or "").strip()}
    return queries or None


def _requested_display_scene_names(args: dict[str, Any]) -> set[str] | None:
    raw = args.get("names") or args.get("scene_names")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("name", "scene_name"):
        if args.get(key) is not None:
            values.append(args[key])
    names = {str(value).strip() for value in values if str(value or "").strip()}
    return names or None


def _requested_display_scene_indices(args: dict[str, Any]) -> set[int] | None:
    raw = args.get("scene_indices") or args.get("indices")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    if args.get("index") is not None:
        values.append(args["index"])
    indices: set[int] = set()
    for value in values:
        try:
            index = int(value)
        except (TypeError, ValueError):
            continue
        if index > 0:
            indices.add(index)
    return indices or None


def _matches_any_display_scene_name(
    scene_name: str, requested_names: set[str] | None
) -> bool:
    if requested_names is None:
        return True
    haystack = str(scene_name or "").casefold()
    return any(needle.casefold() in haystack for needle in requested_names if needle)


def _flatten_display_text_fields(fields: list[Any]) -> list[str]:
    values: list[str] = []
    for field in fields:
        if isinstance(field, dict):
            values.extend(_flatten_display_text_fields(list(field.values())))
        elif isinstance(field, list):
            values.extend(_flatten_display_text_fields(field))
        elif field is not None:
            text = str(field).strip()
            if text:
                values.append(text)
    return values


def _matches_any_display_text(fields: list[Any], queries: set[str] | None) -> bool:
    if queries is None:
        return True
    haystack = "\n".join(_flatten_display_text_fields(fields)).casefold()
    return any(query.casefold() in haystack for query in queries if query)


def _media_ui_spec(
    spec_type: str, component_type: str, items: list[dict[str, Any]]
) -> dict[str, Any]:
    elements: dict[str, Any] = {
        "root": {
            "type": "Stack",
            "props": {
                "direction": "row",
                "wrap": "wrap",
                "spacing": 16,
                "alignItems": "flex-start",
                "width": "100%",
            },
            "children": [],
        }
    }
    for index, item in enumerate(items, start=1):
        src = str(item.get("src") or item.get("url") or "").strip()
        if not src:
            continue
        key = f"media_{index}"
        title = str(item.get("title") or item.get("label") or f"媒体 {index}").strip()
        description = str(item.get("description") or "").strip()
        props: dict[str, Any] = {"src": src, "alt": title, "title": title}
        if description:
            props["description"] = description
        if component_type == "Image":
            props.update(
                {
                    "fit": item.get("fit") or "cover",
                    "aspectRatio": item.get("aspectRatio") or "3/4",
                    "overlayTitle": title,
                }
            )
            if description:
                props["overlayDescription"] = description
        elif component_type == "Video":
            poster = str(item.get("poster") or item.get("thumbnail") or "").strip()
            if poster:
                props["poster"] = poster
            props["controls"] = True
        elif component_type == "Audio":
            props["controls"] = True

        elements[key] = {"type": component_type, "props": props, "children": []}
        elements["root"]["children"].append(key)
    return {"type": spec_type, "root": "root", "elements": elements}


def _project_static_url_from_path(
    project_id: str, rel_path: str, local_path: Path | None = None
) -> str:
    return project_static_url(project_id, rel_path, local_path=local_path)


def _api_response_items(resp: Any, *keys: str) -> list[Any]:
    if not isinstance(resp, dict):
        return []
    for key in keys:
        value = resp.get(key)
        if isinstance(value, list):
            return value
    data = resp.get("data")
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if isinstance(value, list):
                return value
    return []


def _decode_tool_args(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return decoded if isinstance(decoded, dict) else {}
    return {}


def _extract_display_tool_call(raw: Any) -> tuple[str, dict[str, Any]] | None:
    if not isinstance(raw, dict):
        return None
    title = str(
        raw.get("title")
        or raw.get("kind")
        or raw.get("name")
        or raw.get("tool_name")
        or ""
    ).strip()
    tool_name = title.partition(":")[0].split()[0].strip()
    if tool_name not in _DISPLAY_TOOL_NAMES:
        for key in ("name", "tool", "toolName", "tool_name"):
            candidate = str(raw.get(key) or "").strip()
            if candidate in _DISPLAY_TOOL_NAMES:
                tool_name = candidate
                break
    if tool_name not in _DISPLAY_TOOL_NAMES:
        function = raw.get("function")
        if isinstance(function, dict):
            candidate = str(function.get("name") or "").strip()
            if candidate in _DISPLAY_TOOL_NAMES:
                tool_name = candidate
    if tool_name not in _DISPLAY_TOOL_NAMES:
        return None
    for key in ("arguments", "args", "input", "params"):
        args = _decode_tool_args(raw.get(key))
        if args:
            return tool_name, args
    content = raw.get("content")
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            nested = item.get("content")
            if isinstance(nested, dict):
                args = _decode_tool_args(nested.get("text"))
                if args:
                    return tool_name, args
    return tool_name, {}


def _display_tool_call_key(tool_name: str, args: dict[str, Any]) -> str:
    try:
        encoded_args = json.dumps(args, ensure_ascii=False, sort_keys=True, default=str)
    except TypeError:
        encoded_args = repr(args)
    return f"{tool_name}:{encoded_args}"


def _infer_display_tool_call_from_text(
    prompt: str,
    assistant_text: str,
    previous_assistant: list[str],
) -> tuple[str, dict[str, Any]] | None:
    """Recover from display promises where the model forgot to call a display tool."""
    prompt_text = str(prompt or "")
    prompt_lower = prompt_text.casefold()
    recent_context = "\n".join(previous_assistant[-2:] if previous_assistant else [])
    context_text = "\n".join([prompt_text, str(assistant_text or ""), recent_context])
    context_lower = context_text.casefold()
    progress_terms = ("进度", "状态", "任务", "做到哪", "做到哪儿", "当前情况")
    if any(term in prompt_text for term in progress_terms):
        return None
    display_terms = (
        "展示",
        "显示",
        "查看",
        "看",
        "全部显示",
        "show",
        "display",
        "view",
    )
    if not any(term in prompt_lower for term in display_terms):
        return None
    prompt_mentions_sketch = "草图" in prompt_text or "sketch" in prompt_lower
    context_mentions_sketch = "草图" in context_text or "sketch" in context_lower
    short_followup = len(prompt_text.strip()) <= 20 and any(
        term in prompt_text for term in ("全部", "继续", "下一页", "更多")
    )
    if not prompt_mentions_sketch and not (short_followup and context_mentions_sketch):
        return None

    episode = 1
    episode_match = re.search(
        r"(?:第\s*(\d+)\s*集|ep(?:isode)?\s*\.?\s*(\d+))",
        context_text,
        re.IGNORECASE,
    )
    if episode_match:
        raw_episode = episode_match.group(1) or episode_match.group(2)
        try:
            episode = max(1, int(raw_episode))
        except (TypeError, ValueError):
            episode = 1
    wants_sketch_candidates = any(
        term in context_text for term in ("草图候选", "候选草图", "图池", "备选草图")
    )
    if wants_sketch_candidates:
        beat_match = re.search(
            r"(?:beat|Beat|BEAT)\s*\.?\s*(\d+)|第\s*(\d+)\s*(?:个|张)?\s*beat|Beat\s*(\d+)",
            context_text,
            re.IGNORECASE,
        )
        raw_beat = None
        if beat_match:
            raw_beat = next((group for group in beat_match.groups() if group), None)
        if raw_beat:
            try:
                beat = max(1, int(raw_beat))
            except (TypeError, ValueError):
                beat = 0
            if beat > 0:
                return "dramaclaw_get_sketch_candidates", {
                    "episode": episode,
                    "beat": beat,
                }
        return None
    return "dramaclaw_get_sketches", {"episode": episode}


def _backend_api_get(path: str, token: str) -> dict[str, Any]:
    base_url = (
        os.environ.get("DRAMACLAW_API_URL")
        or os.environ.get("NOVELVIDEO_API_URL")
        or f"http://127.0.0.1:{os.environ.get('NOVELVIDEO_API_PORT', '19080')}"
        or os.environ.get("SUPERTALE_API_URL")
    ).strip()
    url = f"{base_url.rstrip('/')}{path}"
    req = Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "dramaclaw-chat-fallback/0.1.0",
        },
        method="GET",
    )
    with urlopen(req, timeout=30) as resp:
        text = resp.read().decode("utf-8", errors="replace")
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return {"ok": False, "error": text[:500]}
    return value if isinstance(value, dict) else {"ok": True, "data": value}


async def _fallback_display_tool_ui_specs(
    username: str,
    project: str,
    tool_name: str,
    args: dict[str, Any],
    *,
    token: str,
    project_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    if not project or tool_name not in _DISPLAY_TOOL_NAMES:
        return []

    def build() -> list[dict[str, Any]]:
        api_project = str(
            args.get("project_id") or args.get("project") or project
        ).strip()
        project_q = quote(api_project, safe="")
        if tool_name == "dramaclaw_get_final_video":
            raw_episode_indices = args.get("episode_indices")
            episode_indices: list[int] = []
            if args.get("episode") is not None and not raw_episode_indices:
                episode_indices = [int(args["episode"])]
            elif isinstance(raw_episode_indices, list):
                for value in raw_episode_indices:
                    try:
                        episode = int(value)
                    except (TypeError, ValueError):
                        continue
                    if episode > 0 and episode not in episode_indices:
                        episode_indices.append(episode)
            if not episode_indices:
                episodes_resp = _backend_api_get(
                    f"/api/v1/projects/{project_q}/episodes",
                    token,
                )
                for item in _api_response_items(episodes_resp, "episodes", "items"):
                    if not isinstance(item, dict):
                        continue
                    try:
                        episode = int(item.get("number") or 0)
                    except (TypeError, ValueError):
                        continue
                    if episode > 0 and episode not in episode_indices:
                        episode_indices.append(episode)

            media_items: list[dict[str, Any]] = []
            for episode in sorted(episode_indices):
                resp = _backend_api_get(
                    f"/api/v1/projects/{project_q}/episodes/{episode}/final",
                    token,
                )
                data = resp.get("data") if isinstance(resp, dict) else None
                video_url = (
                    str(data.get("video_url") or "").strip()
                    if isinstance(data, dict) and data.get("exists")
                    else ""
                )
                if video_url:
                    media_items.append(
                        {
                            "src": video_url,
                            "title": f"第 {episode} 集成片",
                            "description": "最终合成视频",
                        }
                    )
            if not media_items:
                return []
            page_items = _limit_display_items(media_items, args, 6)
            return [
                _media_ui_spec(
                    "keyframe_video",
                    "Video",
                    page_items,
                )
            ]
        if tool_name in {"dramaclaw_get_sketches", "dramaclaw_get_first_frames"}:
            episode = int(args.get("episode") or 1)
            media_kind = (
                "frame" if tool_name == "dramaclaw_get_first_frames" else "sketch"
            )
            resp = _backend_api_get(
                f"/api/v1/projects/{project_q}/episodes/{episode}/beats",
                token,
            )
            media_items: list[dict[str, Any]] = []
            requested_beats = _requested_display_beats(args)
            for beat in _api_response_items(resp, "beats", "items"):
                if not isinstance(beat, dict):
                    continue
                beat_number = beat.get("beat_number")
                try:
                    beat_int = int(beat_number)
                except (TypeError, ValueError):
                    beat_int = None
                if requested_beats is not None and beat_int not in requested_beats:
                    continue
                sketch_url = str(beat.get("sketch_url") or "").strip()
                frame_url = str(beat.get("frame_url") or "").strip()
                if sketch_url and media_kind == "sketch":
                    media_items.append(
                        {
                            "src": sketch_url,
                            "title": f"Beat {beat_number} 草图",
                            "description": "草图",
                            "aspectRatio": "3/4",
                        }
                    )
                if frame_url and media_kind == "frame":
                    media_items.append(
                        {
                            "src": frame_url,
                            "title": f"Beat {beat_number} 首帧",
                            "description": "首帧",
                            "aspectRatio": "3/4",
                        }
                    )
            limited = _limit_display_items(media_items, args, 12)
            return (
                [_media_ui_spec("sketch_gallery", "Image", limited)] if limited else []
            )

        if tool_name == "dramaclaw_get_sketch_candidates":
            episode = int(args.get("episode") or 1)
            try:
                beat = int(
                    args.get("beat")
                    or args.get("beat_num")
                    or args.get("beat_number")
                    or 0
                )
            except (TypeError, ValueError):
                beat = 0
            if beat <= 0:
                return []
            resp = _backend_api_get(
                f"/api/v1/projects/{project_q}/episodes/{episode}/beats/{beat}/sketch-candidates",
                token,
            )
            data = resp.get("data") if isinstance(resp, dict) else None
            candidates = data.get("candidates") if isinstance(data, dict) else []
            media_items = []
            for candidate in candidates if isinstance(candidates, list) else []:
                if not isinstance(candidate, dict):
                    continue
                src = str(candidate.get("url") or "").strip()
                if not src:
                    continue
                media_items.append(
                    {
                        "src": src,
                        "title": f"Beat {beat} 草图候选",
                        "description": (
                            "过期候选" if candidate.get("stale") else "草图候选"
                        ),
                        "aspectRatio": "3/4",
                    }
                )
            limited = _limit_display_items(media_items, args, 12)
            return (
                [_media_ui_spec("sketch_gallery", "Image", limited)] if limited else []
            )

        if tool_name == "dramaclaw_get_scene_images":
            resp = _backend_api_get(
                f"/api/v1/projects/{project_q}/scenes?summary=false", token
            )
            media_items = []
            include_reverse = bool(args.get("include_reverse", True))
            include_pano = bool(args.get("include_pano", False))
            include_custom = bool(args.get("include_custom", False))
            requested_names = _requested_display_scene_names(args)
            requested_indices = _requested_display_scene_indices(args)
            requested_type = str(args.get("scene_type") or "").strip()
            for scene_index, scene in enumerate(
                _api_response_items(resp, "scenes", "items"), start=1
            ):
                if not isinstance(scene, dict):
                    continue
                scene_name = str(scene.get("name") or "").strip()
                scene_type = str(scene.get("scene_type") or "").strip()
                if (
                    requested_indices is not None
                    and scene_index not in requested_indices
                ):
                    continue
                if not _matches_any_display_scene_name(scene_name, requested_names):
                    continue
                if requested_type and scene_type != requested_type:
                    continue
                for kind, field, enabled in (
                    ("master", "master_url", True),
                    ("reverse_master", "reverse_master_url", include_reverse),
                    ("pano", "pano_url", include_pano),
                    ("custom_scene", "custom_scene_url", include_custom),
                ):
                    src = str(scene.get(field) or "").strip()
                    if enabled and src:
                        media_items.append(
                            {
                                "src": src,
                                "title": f"{scene_name or '场景'} · {kind}",
                                "description": scene.get("description")
                                or scene.get("environment_prompt")
                                or "",
                                "aspectRatio": "16/9" if kind == "pano" else "3/4",
                            }
                        )
            limited = _limit_display_items(media_items, args, 12)
            return (
                [_media_ui_spec("sketch_gallery", "Image", limited)] if limited else []
            )

        if tool_name == "dramaclaw_get_character_media":
            resp = _backend_api_get(
                f"/api/v1/projects/{project_q}/characters?summary=false", token
            )
            media_kind = (
                str(args.get("media_kind") or args.get("kind") or "all").strip().lower()
            )
            if media_kind not in {"all", "portrait", "identity"}:
                media_kind = "all"
            include_identities = (
                bool(args.get("include_identities", True)) and media_kind != "portrait"
            )
            media_items = []
            requested_names = _requested_display_names(args)
            requested_queries = _requested_display_queries(args)
            for character in _api_response_items(resp, "characters", "items"):
                if not isinstance(character, dict):
                    continue
                name = str(character.get("name") or "").strip()
                role = str(
                    character.get("role") or character.get("description") or ""
                ).strip()
                character_name_match = _matches_any_display_text(
                    [name, character.get("aliases")],
                    requested_names,
                )
                character_query_match = _matches_any_display_text(
                    [
                        name,
                        role,
                        character.get("description"),
                        character.get("appearance"),
                        character.get("profile"),
                        character.get("aliases"),
                    ],
                    requested_queries,
                )
                character_match = character_name_match and character_query_match
                portrait_url = str(character.get("portrait_url") or "").strip()
                if portrait_url and character_match:
                    if media_kind in {"all", "portrait"}:
                        media_items.append(
                            {
                                "src": portrait_url,
                                "title": name or "角色肖像",
                                "description": role,
                                "aspectRatio": "3/4",
                            }
                        )
                identities = (
                    character.get("identities")
                    or character.get("identity_images")
                    or []
                )
                if include_identities:
                    try:
                        identities_resp = _backend_api_get(
                            f"/api/v1/projects/{project_q}/characters/{quote(name, safe='')}/identities",
                            token,
                        )
                        for key in ("data", "identities", "items"):
                            value = (
                                identities_resp.get(key)
                                if isinstance(identities_resp, dict)
                                else None
                            )
                            if isinstance(value, list):
                                identities = value
                                break
                        data = (
                            identities_resp.get("data")
                            if isinstance(identities_resp, dict)
                            else None
                        )
                        if isinstance(data, dict):
                            value = data.get("identities")
                            if isinstance(value, list):
                                identities = value
                    except Exception:
                        pass
                if include_identities and isinstance(identities, list):
                    for identity in identities:
                        if not isinstance(identity, dict):
                            continue
                        src = str(
                            identity.get("image_url")
                            or identity.get("portrait_image_url")
                            or identity.get("costume_image_url")
                            or ""
                        ).strip()
                        if src:
                            title = str(
                                identity.get("identity_name")
                                or identity.get("name")
                                or identity.get("identity_id")
                                or name
                                or "身份图"
                            )
                            identity_name_match = _matches_any_display_text(
                                [
                                    name,
                                    character.get("aliases"),
                                    title,
                                    identity.get("identity_name"),
                                    identity.get("name"),
                                    identity.get("identity_id"),
                                ],
                                requested_names,
                            )
                            identity_query_match = _matches_any_display_text(
                                [
                                    title,
                                    identity.get("identity_name"),
                                    identity.get("name"),
                                    identity.get("identity_id"),
                                    identity.get("description"),
                                    identity.get("appearance_details"),
                                    identity.get("prompt"),
                                    identity.get("role"),
                                    name,
                                    role,
                                ],
                                requested_queries,
                            )
                            identity_match = (
                                identity_name_match and identity_query_match
                            )
                            if not identity_match:
                                continue
                            media_items.append(
                                {
                                    "src": src,
                                    "title": f"{name} · {title}" if name else title,
                                    "description": role,
                                    "aspectRatio": "3/4",
                                }
                            )
            limited = _limit_display_items(media_items, args, 12)
            return (
                [_media_ui_spec("character_showcase", "Image", limited)]
                if limited
                else []
            )

        if tool_name == "dramaclaw_get_episode_media":
            episode = int(args.get("episode") or 1)
            media_type = str(args.get("media_type") or "video").strip().lower()
            resp = _backend_api_get(
                f"/api/v1/projects/{project_q}/episodes/{episode}/beats",
                token,
            )
            video_items: list[dict[str, Any]] = []
            audio_items: list[dict[str, Any]] = []
            requested_beats = _requested_display_beats(args)
            requested_queries = _requested_display_queries(args)
            for beat in _api_response_items(resp, "beats", "items"):
                if not isinstance(beat, dict):
                    continue
                beat_number = beat.get("beat_number")
                try:
                    beat_int = int(beat_number)
                except (TypeError, ValueError):
                    beat_int = None
                if requested_beats is not None and beat_int not in requested_beats:
                    continue
                if not _matches_any_display_text(
                    [
                        beat.get("title"),
                        beat.get("summary"),
                        beat.get("description"),
                        beat.get("visual_description"),
                        beat.get("image_prompt"),
                        beat.get("video_prompt"),
                        beat.get("narration"),
                        beat.get("voiceover"),
                        beat.get("dialogue"),
                        beat.get("audio_text"),
                        beat.get("speaker"),
                        beat.get("character_names"),
                        beat.get("characters"),
                        beat.get("scene_name"),
                        beat.get("location"),
                    ],
                    requested_queries,
                ):
                    continue
                video_url = str(beat.get("video_url") or "").strip()
                audio_url = str(beat.get("audio_url") or "").strip()
                frame_url = str(
                    beat.get("frame_url") or beat.get("sketch_url") or ""
                ).strip()
                if video_url:
                    video_items.append(
                        {
                            "src": video_url,
                            "poster": frame_url,
                            "title": f"Beat {beat_number} 视频",
                        }
                    )
                if audio_url:
                    audio_items.append(
                        {"src": audio_url, "title": f"Beat {beat_number} 音频"}
                    )
            if media_type == "audio":
                limited = _limit_display_items(audio_items, args, 20)
                return (
                    [_media_ui_spec("audio_list", "Audio", limited)] if limited else []
                )
            limited = _limit_display_items(video_items, args, 6)
            return (
                [_media_ui_spec("keyframe_video", "Video", limited)] if limited else []
            )

        return []

    try:
        return await asyncio.to_thread(build)
    except Exception as exc:
        logger.info(
            "display fallback failed project=%s tool=%s args=%s error=%s",
            project,
            tool_name,
            json.dumps(args, ensure_ascii=False, sort_keys=True, default=str)[:1000],
            exc,
        )
        return []


def _assistant_history_contents(
    username: str,
    project: str,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> list[str]:
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        rows = conn.execute(
            """
            SELECT content
              FROM chat_messages
             WHERE role = 'assistant'
             ORDER BY id DESC
             LIMIT ?
            """,
            (_HERMES_REPLAY_HISTORY_MESSAGES,),
        ).fetchall()
    finally:
        conn.close()
    return _bounded_replay_history(
        [str(row["content"] or "") for row in reversed(rows)]
    )


def _trace_history_contents(
    username: str,
    project: str,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> list[str]:
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        rows = conn.execute(
            """
            SELECT content
              FROM chat_messages
             WHERE role = 'trace'
             ORDER BY id DESC
             LIMIT ?
            """,
            (_HERMES_REPLAY_HISTORY_MESSAGES,),
        ).fetchall()
    finally:
        conn.close()
    return _bounded_replay_history(
        [str(row["content"] or "") for row in reversed(rows)]
    )


async def _store_history_contents_async(
    username: str,
    store_scope: Any,
    role: str,
) -> list[str]:
    try:
        from novelvideo.chat.store import chat_store

        contents = await chat_store.history_contents_async(
            username,
            store_scope,
            role,
            limit=_HERMES_REPLAY_HISTORY_MESSAGES,
        )
        return _bounded_replay_history(contents)
    except Exception:
        return []


def _replace_trace_messages(
    conn: sqlite3.Connection, messages: list[dict[str, Any]]
) -> None:
    conn.execute("DELETE FROM chat_messages WHERE role = 'trace'")
    for message in messages:
        conn.execute(
            """
            INSERT INTO chat_messages(role, content, media_json, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                str(message.get("role") or "assistant"),
                str(message.get("content") or ""),
                json.dumps(message.get("media") or [], ensure_ascii=False),
                str(message.get("created_at") or _now_iso()),
            ),
        )
    conn.commit()


def _extract_codex_user_message_text(item: Any) -> str:
    thread_item = _codex_unwrap_item(item)
    parts: list[str] = []
    for content in getattr(thread_item, "content", []) or []:
        item_type = str(getattr(content, "type", "") or "")
        if item_type == "text":
            text = str(getattr(content, "text", "") or "").strip()
            if text:
                parts.append(text)
        elif item_type == "skill":
            name = str(getattr(content, "name", "") or "").strip()
            if name:
                parts.append(f"[skill] {name}")
        elif item_type == "mention":
            name = str(getattr(content, "name", "") or "").strip()
            path = str(getattr(content, "path", "") or "").strip()
            parts.append(f"[mention] {name or path}".strip())
        elif item_type == "image":
            url = str(getattr(content, "url", "") or "").strip()
            if url:
                parts.append(f"[image] {url}")
        elif item_type == "localImage":
            path = str(getattr(content, "path", "") or "").strip()
            if path:
                parts.append(f"[image] {path}")
    return "\n".join(part for part in parts if part).strip()


def _extract_codex_history_trace(item: Any) -> str:
    from openai_codex.generated.v2_all import CommandExecutionThreadItem

    thread_item = _codex_unwrap_item(item)
    started = _codex_item_started_trace(thread_item) or ""
    completed = _codex_item_completed_trace(thread_item) or ""
    body = ""
    if isinstance(thread_item, CommandExecutionThreadItem):
        aggregated = str(thread_item.aggregated_output or "")
        if aggregated:
            body = aggregated
            if not body.endswith("\n"):
                body += "\n"
    return (started + body + completed).strip()


def _load_codex_thread_history(
    username: str,
    project: str,
    *,
    project_state_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    from openai_codex import CodexConfig
    from openai_codex.generated.v2_all import (
        AgentMessageThreadItem,
        UserMessageThreadItem,
    )
    from novelvideo.chat.codex_app_server import shared_codex

    thread_id = _get_codex_thread_id(
        username, project, project_state_dir=project_state_dir
    )
    if not thread_id:
        return []

    workspace, _codex_home = ensure_user_codex_workspace(
        username, project, project_state_dir=project_state_dir
    )
    codex_bin = _codex_bin_path()
    env = _build_codex_env(username, project, project_state_dir=project_state_dir)
    config = CodexConfig(
        codex_bin=str(codex_bin) if codex_bin is not None else None,
        cwd=str(workspace),
        env=env,
        config_overrides=(
            *_codex_gateway_config_overrides(env[_CODEX_GATEWAY_BASE_URL_ENV]),
            *_codex_mcp_config_overrides(_dramaclaw_mcp_servers()),
        ),
    )

    with shared_codex(config) as codex:
        read_response = codex._client.thread_read(thread_id, include_turns=True)
        thread = read_response.thread
        turns = list(getattr(thread, "turns", []) or [])
        if not turns or not any(getattr(turn, "items", None) for turn in turns):
            resumed = codex._client.thread_resume(
                thread_id,
                {
                    "cwd": str(workspace),
                    "model": _codex_model(),
                    "modelProvider": _CODEX_MODEL_PROVIDER,
                },
            )
            turns = list(getattr(resumed.thread, "turns", []) or [])

    history: list[dict[str, Any]] = []
    for turn_index, turn in enumerate(turns):
        for item_index, item in enumerate(getattr(turn, "items", []) or []):
            thread_item = _codex_unwrap_item(item)
            created_at = _now_iso()
            if isinstance(thread_item, UserMessageThreadItem):
                content = _extract_codex_user_message_text(thread_item)
                if content:
                    history.append(
                        {
                            "id": turn_index * 1000 + item_index,
                            "role": "user",
                            "content": content,
                            "media": _filter_markdown_duplicate_images(
                                content,
                                _extract_media(content, username, project),
                            ),
                            "created_at": created_at,
                        }
                    )
                continue
            if isinstance(thread_item, AgentMessageThreadItem):
                content = str(thread_item.text or "").strip()
                if content:
                    media = _extract_media(content, username, project)
                    history.append(
                        {
                            "id": turn_index * 1000 + item_index,
                            "role": "assistant",
                            "content": content,
                            "media": _filter_markdown_duplicate_images(content, media),
                            "created_at": created_at,
                        }
                    )
                continue

            trace = _extract_codex_history_trace(thread_item)
            if trace:
                for block_index, block in enumerate(_split_trace_contents(trace)):
                    history.append(
                        {
                            "id": turn_index * 10000 + item_index * 10 + block_index,
                            "role": "trace",
                            "content": block,
                            "media": [],
                            "created_at": created_at,
                        }
                    )

    return history


def _sync_codex_history_cache(
    username: str,
    project: str,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> None:
    history = [
        message
        for message in _load_codex_thread_history(
            username, project, project_state_dir=project_state_dir
        )
        if message.get("role") == "trace"
    ]
    if not history:
        return
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        _replace_trace_messages(conn, history)
    finally:
        conn.close()


def list_messages(
    username: str,
    project: str,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        rows = conn.execute(
            """
            SELECT id, role, content, media_json, created_at
              FROM (
                    SELECT id, role, content, media_json, created_at
                      FROM chat_messages
                     WHERE role <> 'trace'
                     ORDER BY id DESC
                     LIMIT ?
                   )
             ORDER BY id ASC
            """,
            (max(1, int(limit)),),
        ).fetchall()
        messages: list[dict[str, Any]] = []
        previous_assistants: list[str] = []
        for row in rows:
            content = str(row["content"])
            role = str(row["role"])
            if role == "assistant":
                raw_content = content
                content = _strip_replayed_assistant_prefix(content, previous_assistants)
                previous_assistants.append(raw_content)
            stored_media = _normalize_media_items(
                json.loads(row["media_json"] or "[]"),
                username,
                project,
                project_dir=project_dir,
            )
            extracted_media = _extract_media(
                content, username, project, project_dir=project_dir
            )
            merged_media = _merge_media_items(stored_media, extracted_media)
            messages.append(
                {
                    "id": int(row["id"]),
                    "role": role,
                    "content": content,
                    "media": _filter_markdown_duplicate_images(content, merged_media),
                    "created_at": str(row["created_at"]),
                }
            )
        return messages
    finally:
        conn.close()


def add_user_message(
    username: str,
    project: str,
    content: str,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> dict[str, Any]:
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        return _append_message(conn, "user", content)
    finally:
        conn.close()


def add_assistant_message(
    username: str,
    project: str,
    content: str,
    media: list[dict[str, Any]] | None = None,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> dict[str, Any]:
    content = _redact_local_filesystem_paths(content)
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        return _append_message(conn, "assistant", content, media)
    finally:
        conn.close()


def add_trace_message(
    username: str,
    project: str,
    content: str,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> dict[str, Any]:
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        return _append_message(conn, "trace", content)
    finally:
        conn.close()


def add_trace_messages(
    username: str,
    project: str,
    contents: list[str],
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        messages: list[dict[str, Any]] = []
        for content in contents:
            normalized = str(content or "").strip()
            if not normalized:
                continue
            messages.append(_append_message(conn, "trace", normalized))
        return messages
    finally:
        conn.close()


def _agent_session_state_path(username: str) -> Path:
    return _user_state_dir(username) / "agent_sessions.json"


def _load_agent_session_state(username: str) -> dict[str, str]:
    path = _agent_session_state_path(username)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        str(key): str(value).strip()
        for key, value in payload.items()
        if str(value or "").strip()
    }


def _save_agent_session_state(username: str, payload: dict[str, str]) -> None:
    path = _agent_session_state_path(username)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp_path.replace(path)


def _get_active_agent_session_id(username: str, backend: str) -> str | None:
    payload = _load_agent_session_state(username)
    active_backend = str(payload.get("backend", "") or "").strip()
    if active_backend != backend:
        return None
    return str(payload.get("thread_id", "") or "").strip() or None


def _set_active_agent_session_id(username: str, backend: str, thread_id: str) -> None:
    normalized = str(thread_id or "").strip()
    if not normalized:
        return
    _save_agent_session_state(
        username,
        {
            "backend": backend,
            "thread_id": normalized,
            "updated_at": _now_iso(),
        },
    )


def _get_claude_session_id(username: str, project: str) -> str | None:
    return _get_active_agent_session_id(username, "claude")


def _set_claude_session_id(username: str, project: str, session_id: str) -> None:
    _set_active_agent_session_id(username, "claude", session_id)


def _codex_session_state_path(
    username: str,
    project: str = "",
    *,
    project_state_dir: str | Path | None = None,
) -> Path:
    if project:
        state_dir = (
            Path(project_state_dir)
            if project_state_dir is not None
            else _project_state_dir(username, project)
        )
        return state_dir / "agents" / "codex" / "sessions.json"
    return _user_state_dir(username) / "codex_sessions.json"


def _codex_scope_key(
    project: str,
    *,
    agent_profile: str = "main",
    canvas_id: str | None = None,
) -> str:
    normalized_project = str(project or "").strip()
    profile = str(agent_profile or "main").strip() or "main"
    if profile == "main":
        # Preserve the original key so existing Director threads keep resuming.
        return f"project:{normalized_project}" if normalized_project else "home"
    scoped_canvas = str(canvas_id or "").strip() or None
    if not profile.startswith("freezone"):
        scoped_canvas = None
    scope = (
        profile,
        "project" if normalized_project else "home",
        normalized_project or None,
        scoped_canvas,
        _CODEX_FREEZONE_THREAD_PROTOCOL_VERSION,
    )
    return json.dumps(scope, ensure_ascii=False, separators=(",", ":"))


def _load_codex_session_state(
    username: str,
    project: str = "",
    *,
    project_state_dir: str | Path | None = None,
) -> dict[str, str]:
    path = _codex_session_state_path(
        username, project, project_state_dir=project_state_dir
    )
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        str(key): str(value).strip()
        for key, value in payload.items()
        if str(key).strip() and str(value or "").strip()
    }


def _save_codex_session_state(
    username: str,
    project: str,
    payload: dict[str, str],
    *,
    project_state_dir: str | Path | None = None,
) -> None:
    from novelvideo.utils.state_index_files import write_json_atomic

    path = _codex_session_state_path(
        username, project, project_state_dir=project_state_dir
    )
    write_json_atomic(path, payload)


def _get_codex_thread_id(
    username: str,
    project: str,
    *,
    agent_profile: str = "main",
    canvas_id: str | None = None,
    project_state_dir: str | Path | None = None,
) -> str | None:
    return _load_codex_session_state(
        username, project, project_state_dir=project_state_dir
    ).get(
        _codex_scope_key(
            project,
            agent_profile=agent_profile,
            canvas_id=canvas_id,
        )
    )


def _set_codex_thread_id(
    username: str,
    project: str,
    thread_id: str,
    *,
    agent_profile: str = "main",
    canvas_id: str | None = None,
    project_state_dir: str | Path | None = None,
) -> None:
    normalized = str(thread_id or "").strip()
    if not normalized:
        return
    from novelvideo.utils.state_index_files import index_file_lock

    state_path = _codex_session_state_path(
        username, project, project_state_dir=project_state_dir
    )
    with index_file_lock(state_path):
        payload = _load_codex_session_state(
            username, project, project_state_dir=project_state_dir
        )
        payload[
            _codex_scope_key(
                project,
                agent_profile=agent_profile,
                canvas_id=canvas_id,
            )
        ] = normalized
        _save_codex_session_state(
            username,
            project,
            payload,
            project_state_dir=project_state_dir,
        )


def _active_codex_turns_path(username: str) -> Path:
    return _user_state_dir(username) / "active_codex_turns.json"


def _load_active_codex_turns(username: str) -> dict[str, dict[str, str]]:
    path = _active_codex_turns_path(username)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        str(key): {str(k): str(v) for k, v in value.items()}
        for key, value in payload.items()
        if isinstance(value, dict)
    }


def _set_active_codex_turn(
    username: str,
    scope_key: str,
    value: tuple[str, str] | None,
) -> None:
    from novelvideo.utils.state_index_files import index_file_lock, write_json_atomic

    path = _active_codex_turns_path(username)
    with index_file_lock(path):
        payload = _load_active_codex_turns(username)
        if value is None:
            payload.pop(scope_key, None)
        else:
            payload[scope_key] = {"thread_id": value[0], "turn_id": value[1]}
        write_json_atomic(path, payload)


def _write_codex_turn_token(
    token_root: Path,
    *,
    scope_key: str,
    business_turn_id: str,
    token: str,
) -> Path:
    """Atomically create one credential file owned by exactly one Codex turn."""

    token_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    mode = token_root.lstat().st_mode
    if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
        raise RuntimeError(f"Unsafe Codex turn-token directory: {token_root}")
    token_root.chmod(0o700)
    scope_digest = hashlib.sha256(scope_key.encode("utf-8")).hexdigest()
    normalized_turn_id = str(business_turn_id or "").strip() or "turn"
    turn_slug = re.sub(r"[^A-Za-z0-9._-]+", "-", normalized_turn_id).strip("-._")
    turn_digest = hashlib.sha256(normalized_turn_id.encode("utf-8")).hexdigest()[:12]
    unique_suffix = uuid.uuid4().hex
    token_file = token_root / (
        f"{scope_digest}.{(turn_slug or 'turn')[:40]}.{turn_digest}.{unique_suffix}.token"
    )
    temporary_token_file = token_root / f".{token_file.name}.{uuid.uuid4().hex}.tmp"
    try:
        temporary_token_file.touch(mode=0o600, exist_ok=False)
        temporary_token_file.write_text(token, encoding="utf-8")
        temporary_token_file.chmod(0o600)
        temporary_token_file.replace(token_file)
    except Exception:
        temporary_token_file.unlink(missing_ok=True)
        raise
    return token_file


def _control_codex_thread(
    operation: Literal["interrupt", "archive", "delete"],
    thread_id: str,
    turn_id: str | None = None,
) -> bool:
    codex_bin = _codex_bin_path()
    if codex_bin is None:
        return False
    from novelvideo.chat.hermes_workspace import effective_gateway_credentials

    _key, base_url = effective_gateway_credentials()
    normalized_base_url = str(base_url or "").strip().rstrip("/")
    if not normalized_base_url:
        return False
    codex_home = _codex_node_home()
    env = os.environ.copy()
    env["CODEX_HOME"] = str(codex_home)
    env[_CODEX_GATEWAY_BASE_URL_ENV] = normalized_base_url
    return control_codex_runtime(
        codex_bin=codex_bin,
        cwd=codex_home,
        env=env,
        config_overrides=_codex_gateway_config_overrides(normalized_base_url),
        operation=operation,
        thread_id=thread_id,
        turn_id=turn_id,
    )


async def archive_codex_canvas_threads(
    username: str,
    project: str,
    canvas_id: str,
    *,
    project_state_dir: str | Path | None = None,
) -> int:
    """Archive and forget every Codex agent thread attached to one canvas."""

    state = _load_codex_session_state(
        username, project, project_state_dir=project_state_dir
    )
    matches: dict[str, str] = {}
    for key, value in state.items():
        try:
            scope_parts = json.loads(key)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(scope_parts, list)
            and len(scope_parts) in {4, 5}
            and str(scope_parts[0]).startswith("freezone")
            and scope_parts[3] == canvas_id
        ):
            matches[key] = value
    for thread_id in sorted(set(matches.values())):
        archived = await asyncio.to_thread(_control_codex_thread, "archive", thread_id)
        if not archived:
            raise RuntimeError(f"Codex thread could not be archived: {thread_id}")
    if matches:
        state_path = _codex_session_state_path(
            username, project, project_state_dir=project_state_dir
        )
        from novelvideo.utils.state_index_files import index_file_lock

        with index_file_lock(state_path):
            latest = _load_codex_session_state(
                username, project, project_state_dir=project_state_dir
            )
            for key, thread_id in matches.items():
                if latest.get(key) == thread_id:
                    latest.pop(key, None)
            _save_codex_session_state(
                username, project, latest, project_state_dir=project_state_dir
            )
    return len(set(matches.values()))


async def delete_codex_project_threads(
    username: str,
    project: str,
    *,
    project_state_dir: str | Path | None = None,
) -> int:
    state = _load_codex_session_state(
        username, project, project_state_dir=project_state_dir
    )
    threads = sorted(set(state.values()))
    for thread_id in threads:
        deleted = await asyncio.to_thread(_control_codex_thread, "delete", thread_id)
        if not deleted:
            raise RuntimeError(f"Codex thread could not be deleted: {thread_id}")
    return len(threads)


def _load_api_url() -> str:
    explicit = os.environ.get("DRAMACLAW_API_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")

    dedicated = os.environ.get("NOVELVIDEO_API_URL", "").strip()
    if dedicated:
        return dedicated.rstrip("/")

    api_port = os.environ.get("NOVELVIDEO_API_PORT", "").strip()
    if api_port:
        host = os.environ.get("NOVELVIDEO_API_HOST", "127.0.0.1").strip() or "127.0.0.1"
        if host in {"0.0.0.0", "::"}:
            host = "127.0.0.1"
        return f"http://{host}:{api_port}"

    legacy = os.environ.get("SUPERTALE_API_URL", "").strip()
    if legacy:
        return legacy.rstrip("/")

    # Chat agents call the REST API, not the legacy NiceGUI listener. Keep the
    # same self-container default used by the Hermes worker pool.
    return "http://127.0.0.1:8780"


PAGE_AGENT_SCOPES = [
    "projects:read",
    "projects:write",
    "tasks:submit",
    "tasks:poll",
    "media:read",
    "assets:read",
]
PAGE_AGENT_SESSION_TTL_SECONDS = 24 * 3600
CODEX_AGENT_SESSION_TTL_SECONDS = 2 * 3600


async def _create_page_agent_session_token(
    username: str,
    project: str,
    *,
    agent_kind: str,
    ttl_seconds: int = PAGE_AGENT_SESSION_TTL_SECONDS,
) -> str:
    token = await get_auth_session_port().create_agent_session(
        username=username,
        scopes=PAGE_AGENT_SCOPES,
        ttl_seconds=ttl_seconds,
        agent_kind=agent_kind,
        worker_id=f"page-agent:{agent_kind}:{username}",
        current_scope_kind="project" if project else "home",
        current_project_id=project or None,
        metadata={"source": "chat_service"},
    )
    return token.value


def _project_skill_settings_payload(
    username: str,
    project: str,
    agent_token: str = "",
) -> dict[str, Any]:
    env = {
        "DRAMACLAW_USERNAME": username,
        "DRAMACLAW_AGENT_SCOPE": "user",
        "DRAMACLAW_API_URL": _load_api_url(),
        "DRAMACLAW_AGENT_TOKEN": agent_token,
        "SUPERTALE_USERNAME": username,
        "SUPERTALE_AGENT_SCOPE": "user",
        "SUPERTALE_API_URL": _load_api_url(),
        "SUPERTALE_AGENT_TOKEN": agent_token,
    }
    if project:
        env["DRAMACLAW_PROJECT_ID"] = project
        env["SUPERTALE_PROJECT_ID"] = project
    return {"env": env}


def _write_user_skill_settings(
    username: str, project: str, agent_token: str = ""
) -> None:
    workspace = _user_agent_workspace(username)
    claude_dir = workspace / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    payload = _project_skill_settings_payload(username, project, agent_token)
    (claude_dir / "settings.local.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def ensure_user_claude_workspace(
    username: str, project: str, agent_token: str = ""
) -> None:
    workspace = _user_agent_workspace(username)
    claude_dir = workspace / ".claude"
    skills_dir = claude_dir / "skills"
    claude_dir.mkdir(parents=True, exist_ok=True)
    skills_dir.mkdir(parents=True, exist_ok=True)
    _write_user_skill_settings(username, project, agent_token)
    _sync_project_skills(skills_dir)


def ensure_user_codex_workspace(
    username: str,
    project: str,
    agent_token: str = "",
    *,
    agent_profile: str = "main",
    project_state_dir: str | Path | None = None,
) -> tuple[Path, Path]:
    if project:
        state_dir = (
            Path(project_state_dir)
            if project_state_dir is not None
            else _project_state_dir(username, project)
        )
        agent_root = state_dir / "agents" / "codex"
        profile = str(agent_profile or "main").strip() or "main"
        profile_slug = re.sub(r"[^A-Za-z0-9._-]+", "-", profile).strip("-._")
        profile_digest = hashlib.sha256(profile.encode("utf-8")).hexdigest()[:12]
        profile_dir = f"{(profile_slug or 'profile')[:40]}-{profile_digest}"
        workspace = agent_root / "workspaces" / profile_dir
    else:
        workspace = _user_agent_workspace(username)
    codex_dir = _codex_node_home()
    skills_dir = workspace / ".agents" / "skills"
    codex_dir.mkdir(parents=True, exist_ok=True)
    skills_dir.mkdir(parents=True, exist_ok=True)
    _sync_project_skills(skills_dir, agent_profile=agent_profile)
    return workspace, codex_dir


def _build_claude_env(
    username: str,
    project: str,
    agent_token: str = "",
    *,
    egress_context=None,
) -> dict[str, str]:
    env = os.environ.copy()
    env["DRAMACLAW_USERNAME"] = username
    env["DRAMACLAW_AGENT_SCOPE"] = "user"
    env["SUPERTALE_USERNAME"] = username
    env["SUPERTALE_AGENT_SCOPE"] = "user"
    if project:
        env["DRAMACLAW_PROJECT_ID"] = project
        env["SUPERTALE_PROJECT_ID"] = project
    env["DRAMACLAW_API_URL"] = _load_api_url()
    env["SUPERTALE_API_URL"] = _load_api_url()
    env["DRAMACLAW_AGENT_TOKEN"] = agent_token
    env["SUPERTALE_AGENT_TOKEN"] = agent_token
    from novelvideo.task_backend.subprocesses import build_model_child_env

    return build_model_child_env(env, egress_context=egress_context)


def _codex_turn_gateway_credentials(authorization=None) -> tuple[str, str]:
    """Resolve one turn's NewAPI token without crossing CE/EE config boundaries."""

    from novelvideo.chat.hermes_workspace import effective_gateway_credentials
    from novelvideo.shared.runtime_env import is_ce_effective

    configured_key, configured_base_url = effective_gateway_credentials()
    configured_base_url = str(configured_base_url or "").strip().rstrip("/")
    if not configured_base_url:
        raise RuntimeError("Codex requires a configured DramaClaw model gateway URL")

    if is_ce_effective():
        # CE owns a local SQLite settings database. UI changes to endpoint/key
        # must take effect on the next turn and must never be shadowed by the
        # EE request-authorization path.
        api_key = str(configured_key or "").strip()
    elif authorization is None:
        # EE platform traffic uses its deployment credential.
        api_key = str(configured_key or "").strip()
    else:
        # EE organization traffic uses the key belonging to that request's
        # selected channel. Only the shared gateway origin comes from env.
        credential = authorization.credential
        credential_base_url = str(credential.base_url or "").strip().rstrip("/")
        configured_origin = urlparse(configured_base_url)
        credential_origin = urlparse(credential_base_url)
        if (
            configured_origin.scheme.lower(),
            configured_origin.netloc.lower(),
        ) != (
            credential_origin.scheme.lower(),
            credential_origin.netloc.lower(),
        ):
            from novelvideo.chat import evidence_metrics
            from novelvideo.chat.hermes_pool import GatewayOriginMismatch

            evidence_metrics.observe("foreign_endpoint_refused")
            raise GatewayOriginMismatch(
                "the Codex turn credential targets a different gateway origin "
                "than the shared App Server"
            )
        api_key = str(credential.api_key or "").strip()

    if not api_key:
        raise RuntimeError("Codex requires a per-turn DramaClaw model gateway key")
    return api_key, configured_base_url


def _build_codex_env(
    username: str,
    project: str,
    agent_token: str = "",
    *,
    egress_context=None,
    authorization=None,
    agent_profile: str = "main",
    tool_mode: str = "default",
    canvas_id: str | None = None,
    project_state_dir: str | Path | None = None,
    agent_token_file: str | Path | None = None,
) -> dict[str, str]:
    env = os.environ.copy()
    agent_scope = "project" if project else "user"
    env["DRAMACLAW_USERNAME"] = username
    env["DRAMACLAW_AGENT_SCOPE"] = agent_scope
    env["SUPERTALE_USERNAME"] = username
    env["SUPERTALE_AGENT_SCOPE"] = agent_scope
    profile = str(agent_profile or "main").strip() or "main"
    env["DRAMACLAW_AGENT_PROFILE"] = profile
    if project:
        env["DRAMACLAW_PROJECT_ID"] = project
        env["SUPERTALE_PROJECT_ID"] = project
    env["DRAMACLAW_API_URL"] = _load_api_url()
    env["SUPERTALE_API_URL"] = _load_api_url()
    env.pop("DRAMACLAW_AGENT_TOKEN", None)
    env.pop("SUPERTALE_AGENT_TOKEN", None)
    if agent_token_file is not None:
        env["DRAMACLAW_AGENT_TOKEN_FILE"] = str(agent_token_file)
    env["DRAMACLAW_TOOL_MODE"] = str(tool_mode or "default").strip() or "default"
    if str(tool_mode or "").strip() == "freezone_canvas":
        # Keep Codex MCP on the same per-user/per-profile bridge directory as
        # Hermes. Without this, the MCP process writes pending commands into a
        # generic /tmp directory that the Freezone frontend never polls.
        from novelvideo.chat.hermes_pool import canvas_bridge_dir_for_profile
        from novelvideo.chat.hermes_workspace import ensure_user_hermes_workspace

        hermes_home = ensure_user_hermes_workspace(username, profile="freezone")
        env["DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR"] = str(
            canvas_bridge_dir_for_profile(hermes_home, profile)
        )
        env["DRAMACLAW_EXTERNAL_MCP"] = "1"
        env["DRAMACLAW_MCP_DIRECT_CANVAS_APPLY"] = "0"
        env["DRAMACLAW_CHAT_SURFACE"] = "freezone"
    normalized_canvas_id = str(canvas_id or "").strip()
    if normalized_canvas_id:
        env["DRAMACLAW_CANVAS_ID"] = normalized_canvas_id
    else:
        env.pop("DRAMACLAW_CANVAS_ID", None)
    workspace, codex_home = ensure_user_codex_workspace(
        username,
        project,
        agent_token,
        agent_profile=profile,
        project_state_dir=project_state_dir,
    )
    env["DRAMACLAW_SKILLS_DIR"] = str(workspace / ".agents" / "skills")
    env["CODEX_HOME"] = str(codex_home)
    from novelvideo.task_backend.subprocesses import build_model_child_env

    child_env = build_model_child_env(
        env,
        egress_context=egress_context,
        gateway_credential=(
            authorization.credential if authorization is not None else None
        ),
    )
    # Validate the request egress boundary before looking up a usable model
    # credential. An organization denial must remain fail-closed even when the
    # local platform key is absent or still being configured.
    _api_key, base_url = _codex_turn_gateway_credentials(authorization)
    # The App Server is shared across projects and organizations. No usable
    # model credential may survive into its process environment; authentication
    # is supplied in the thread configuration for one turn only.
    for name in (
        "ANTHROPIC_API_KEY",
        "DRAMACLAW_CODEX_GATEWAY_API_KEY",
        "FAL_KEY",
        "MODEL_API_KEY",
        "NEWAPI_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "ST_ORG_GATEWAY_API_KEY",
        "VOLCENGINE_API_KEY",
    ):
        child_env.pop(name, None)
    child_env[_CODEX_GATEWAY_BASE_URL_ENV] = base_url
    return child_env


def _extract_media(
    content: str,
    username: str,
    project: str,
    *,
    project_dir: str | Path | None = None,
) -> list[dict[str, str]]:
    media_project_dir = _media_project_dir(username, project, project_dir)
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    markdown_images = _collect_markdown_image_refs(content)

    def add_item(raw_url: str, path: str | None = None) -> None:
        candidate = raw_url.strip(".,;)]}")
        parsed = urlparse(candidate)
        if parsed.scheme in {"http", "https"} and parsed.path.startswith("/static/"):
            candidate = parsed.path
        if candidate.startswith("/static/"):
            canonical = _canonical_project_static_media_url(
                project, media_project_dir, candidate
            )
            if canonical is None:
                return
            candidate, path = canonical
        ext = Path(urlparse(candidate).path).suffix.lower()
        kind = _MEDIA_EXTENSIONS.get(ext)
        if not kind:
            return
        if kind == "image" and (
            candidate in markdown_images
            or (path and path in markdown_images)
            or (path and path.lstrip("./") in markdown_images)
        ):
            return
        effective_path = path or ""
        if not effective_path:
            effective_path = _media_path_from_static_url(candidate) or ""
        key = f"{kind}:{effective_path or candidate}"
        if key in seen:
            return
        seen.add(key)
        items.append(
            {
                "kind": kind,
                "url": candidate,
                "path": effective_path,
                "label": Path(effective_path or candidate).name,
            }
        )

    for match in _URL_RE.finditer(content):
        url = match.group(1)
        if url.startswith("/static/"):
            add_item(url)
        else:
            add_item(url)

    for match in _REL_PATH_RE.finditer(content):
        rel_path = match.group("path")
        full_path = media_project_dir / rel_path
        if full_path.exists():
            static_url = project_static_url(project, rel_path, local_path=full_path)
            add_item(static_url, rel_path)

    return items


def _collect_markdown_image_refs(content: str) -> set[str]:
    refs: set[str] = set()

    for match in _MARKDOWN_IMAGE_RE.finditer(content):
        raw = (match.group(1) or "").strip().strip("<>").strip(".,;)]}")
        if not raw:
            continue
        refs.add(raw)
        parsed = urlparse(raw)
        path = (
            parsed.path if parsed.scheme in {"http", "https"} else raw.split("?", 1)[0]
        )
        if path:
            refs.add(path)
        static_path = _media_path_from_static_url(raw)
        if static_path:
            refs.add(static_path)
            refs.add(static_path.lstrip("./"))
        elif parsed.scheme in {"http", "https"} and parsed.path.startswith("/static/"):
            refs.add(parsed.path)
        elif raw.startswith("/static/"):
            refs.add(raw.split("?", 1)[0])
        else:
            refs.add(path.lstrip("./") if path else raw.lstrip("./"))

    return refs


def _normalize_media_items(
    media: list[dict[str, Any]],
    username: str,
    project: str,
    *,
    project_dir: str | Path | None = None,
) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    media_project_dir = _media_project_dir(username, project, project_dir)

    for item in media:
        if not isinstance(item, dict):
            continue

        candidate = str(item.get("url", "") or "").strip()
        path = str(item.get("path", "") or "").strip()
        if not candidate and not path:
            continue

        if not candidate and path:
            canonical = _canonical_project_static_media_url(
                project, media_project_dir, path
            )
            if canonical is None:
                continue
            candidate, path = canonical

        parsed = urlparse(candidate)
        if parsed.scheme in {"http", "https"} and parsed.path.startswith("/static/"):
            candidate = parsed.path
        if candidate.startswith("/static/"):
            canonical = _canonical_project_static_media_url(
                project, media_project_dir, candidate
            )
            if canonical is None:
                continue
            candidate, path = canonical

        ext = Path(urlparse(candidate).path).suffix.lower()
        kind = _MEDIA_EXTENSIONS.get(ext)
        if not kind:
            continue

        if not path:
            path = _media_path_from_static_url(candidate) or ""

        key = f"{kind}:{path or candidate}"
        if key in seen:
            continue
        seen.add(key)

        normalized.append(
            {
                "kind": kind,
                "url": candidate,
                "path": path,
                "label": str(item.get("label", "") or Path(path or candidate).name),
            }
        )

    return normalized


def _merge_media_items(*groups: list[dict[str, str]]) -> list[dict[str, str]]:
    merged: list[dict[str, str]] = []
    seen: set[str] = set()

    for group in groups:
        for item in group:
            kind = str(item.get("kind", "") or "").strip()
            url = str(item.get("url", "") or "").strip()
            path = str(item.get("path", "") or "").strip()
            if not kind or not url:
                continue
            key = f"{kind}:{path or url}"
            if key in seen:
                continue
            seen.add(key)
            merged.append(
                {
                    "kind": kind,
                    "url": url,
                    "path": path,
                    "label": str(item.get("label", "") or Path(path or url).name),
                }
            )

    return merged


def _filter_markdown_duplicate_images(
    content: str, media: list[dict[str, str]]
) -> list[dict[str, str]]:
    markdown_images = _collect_markdown_image_refs(content)
    if not markdown_images:
        return media

    filtered: list[dict[str, str]] = []
    for item in media:
        kind = str(item.get("kind", "") or "").strip()
        if kind != "image":
            filtered.append(item)
            continue

        url = str(item.get("url", "") or "").strip()
        path = str(item.get("path", "") or "").strip()
        if (
            url in markdown_images
            or (path and path in markdown_images)
            or (path and path.lstrip("./") in markdown_images)
        ):
            continue
        filtered.append(item)

    return filtered


def _build_claude_thread(
    username: str, project: str, agent_token: str, *, egress_context=None
):
    ensure_user_claude_workspace(username, project, agent_token)
    workspace = _user_agent_workspace(username)
    client = ClaudeSdkClient(
        cli_path=_claude_cli_path(),
        cwd=workspace,
        env=_build_claude_env(
            username, project, agent_token, egress_context=egress_context
        ),
        model=_claude_model(),
    )
    session_id = _get_claude_session_id(username, project)
    return client.thread_resume(session_id) if session_id else client.thread_start()


def _dramaclaw_mcp_servers(
    tool_mode: str = "default",
) -> dict[str, dict[str, Any]]:
    servers: dict[str, dict[str, Any]] = {
        "dramaclaw": {
            "type": "stdio",
            "command": sys.executable,
            "args": ["-m", "novelvideo.chat.dramaclaw_mcp"],
            "env_vars": [
                "DRAMACLAW_API_URL",
                "DRAMACLAW_AGENT_TOKEN_FILE",
                "DRAMACLAW_CANVAS_ID",
                "DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR",
                "DRAMACLAW_CHAT_SURFACE",
                "DRAMACLAW_EXTERNAL_MCP",
                "DRAMACLAW_MCP_DIRECT_CANVAS_APPLY",
                "DRAMACLAW_AGENT_PROFILE",
                "DRAMACLAW_PROJECT_ID",
                "DRAMACLAW_SKILLS_DIR",
                "DRAMACLAW_TOOL_MODE",
                "DRAMACLAW_USERNAME",
            ],
        }
    }
    if str(tool_mode or "").strip() == "freezone_canvas":
        # The shared Workflow MCP owns portable discovery and deterministic
        # compilation only. Protected canvas writes stay on the existing
        # DramaClaw MCP server, preserving the Hermes approval boundary.
        servers["dramaclaw_workflows"] = {
            "type": "stdio",
            "command": sys.executable,
            "args": ["-m", "novelvideo.chat.workflow_mcp"],
            "env_vars": ["DRAMACLAW_USERNAME"],
        }
    return servers


def _codex_mcp_config_overrides(
    mcp_servers: dict[str, dict[str, Any]],
) -> tuple[str, ...]:
    overrides: list[str] = []
    for name, server in sorted(mcp_servers.items()):
        if str(server.get("type") or "stdio") != "stdio":
            raise ValueError(
                f"unsupported Codex MCP server type for {name}: {server.get('type')}"
            )
        command = str(server.get("command") or "").strip()
        if not command:
            raise ValueError(f"Codex MCP server {name} is missing command")
        args = server.get("args") or []
        if not isinstance(args, list):
            raise ValueError(f"Codex MCP server {name} args must be a list")
        env_vars = server.get("env_vars") or []
        if not isinstance(env_vars, list):
            raise ValueError(f"Codex MCP server {name} env_vars must be a list")
        prefix = f"mcp_servers.{name}"
        overrides.append(f"{prefix}.command={json.dumps(command, ensure_ascii=False)}")
        overrides.append(
            f"{prefix}.args={json.dumps([str(arg) for arg in args], ensure_ascii=False, separators=(',', ':'))}"
        )
        overrides.append(
            f"{prefix}.env_vars={json.dumps([str(var) for var in env_vars], ensure_ascii=False, separators=(',', ':'))}"
        )
        overrides.append(f"{prefix}.enabled=true")
        overrides.append(f"{prefix}.required=true")
        # DramaClaw MCP is the sole business write boundary. Its short-lived,
        # project-scoped bearer token remains the authority for every call;
        # pre-approving this server avoids a separate Guardian model request
        # that cannot inherit per-turn NewAPI credentials.
        overrides.append(f'{prefix}.default_tools_approval_mode="approve"')
    return tuple(overrides)


def _codex_gateway_provider_overrides(
    base_url: str,
) -> tuple[str, ...]:
    normalized_base_url = str(base_url or "").strip().rstrip("/")
    if not normalized_base_url:
        raise RuntimeError("Codex requires a configured DramaClaw model gateway URL")
    prefix = f"model_providers.{_CODEX_MODEL_PROVIDER}"
    return (
        f"{prefix}.name={json.dumps('DramaClaw Gateway')}",
        f"{prefix}.base_url={json.dumps(normalized_base_url)}",
        f"{prefix}.experimental_bearer_token={json.dumps(_CODEX_PER_TURN_CREDENTIAL_PLACEHOLDER)}",
        f'{prefix}.wire_api="responses"',
        f"{prefix}.requires_openai_auth=false",
        f"{prefix}.supports_websockets=false",
    )


def _codex_gateway_config_overrides(base_url: str) -> tuple[str, ...]:
    """Node-safe Codex config containing no usable Gateway credential."""
    overrides = [
        *_codex_gateway_provider_overrides(
            base_url,
        ),
        f'model_reasoning_effort="{_codex_reasoning_effort()}"',
        'web_search="disabled"',
        "features.apps=false",
        "features.hooks=false",
        # Native memories are CODEX_HOME-global. The shared node runtime must
        # not let one project's learned preferences bleed into another; the
        # project thread and DramaClaw project state remain authoritative.
        "features.memories=false",
        "features.multi_agent=false",
        "features.plugins=false",
        "features.shell_tool=false",
        "features.view_image=false",
        "memories.generate_memories=false",
        "memories.use_memories=false",
    ]
    # Codex only enables native deferred tool search for models present in its
    # catalog. The repository ships complete metadata for the default Gateway
    # slug; deployments may replace it with another verified catalog.
    bundled_catalog = (
        Path(__file__).resolve().parents[3]
        / "deploy"
        / "codex"
        / "dramaclaw-model-catalog.json"
    )
    catalog_file = str(
        os.environ.get("DRAMACLAW_CODEX_MODEL_CATALOG_FILE") or bundled_catalog
    ).strip()
    path = Path(catalog_file).expanduser()
    if not path.is_file() or not path.is_absolute():
        raise RuntimeError(
            "DRAMACLAW_CODEX_MODEL_CATALOG_FILE must be an existing absolute file"
        )
    try:
        catalog = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("Codex model catalog file is not valid JSON") from exc
    models = catalog.get("models") if isinstance(catalog, dict) else None
    if not isinstance(models, list):
        raise RuntimeError("Codex model catalog must contain a models array")
    configured_model = _codex_model()
    entry = next(
        (
            item
            for item in models
            if isinstance(item, dict) and item.get("slug") == configured_model
        ),
        None,
    )
    required_fields = {
        "base_instructions",
        "display_name",
        "supported_reasoning_levels",
        "shell_type",
        "visibility",
        "supported_in_api",
        "priority",
        "truncation_policy",
        "experimental_supported_tools",
        "supports_search_tool",
    }
    if entry is None or not required_fields.issubset(entry):
        raise RuntimeError(
            f"Codex model catalog has no complete entry for {configured_model}"
        )
    if entry.get("supports_search_tool") is not True:
        raise RuntimeError(
            f"Codex model catalog must enable supports_search_tool for {configured_model}"
        )
    if not str(entry.get("base_instructions") or "").strip():
        raise RuntimeError(
            f"Codex model catalog must provide base_instructions for {configured_model}"
        )
    overrides.append(f"model_catalog_json={json.dumps(str(path))}")
    return tuple(overrides)


def _build_codex_thread(
    username: str,
    project: str,
    agent_token: str,
    *,
    egress_context=None,
    authorization=None,
    control_capability: str | None = None,
    agent_profile: str = "main",
    tool_mode: str = "default",
    canvas_id: str | None = None,
    project_state_dir: str | Path | None = None,
    agent_token_file: str | Path | None = None,
) -> AgentRuntimeThreadPort:
    workspace, _codex_home = ensure_user_codex_workspace(
        username,
        project,
        agent_token,
        agent_profile=agent_profile,
        project_state_dir=project_state_dir,
    )
    env = _build_codex_env(
        username,
        project,
        agent_token,
        egress_context=egress_context,
        authorization=authorization,
        agent_profile=agent_profile,
        tool_mode=tool_mode,
        canvas_id=canvas_id,
        project_state_dir=project_state_dir,
        agent_token_file=agent_token_file,
    )
    gateway_api_key, gateway_base_url = _codex_turn_gateway_credentials(authorization)
    node_config_overrides = _codex_gateway_config_overrides(gateway_base_url)
    thread_config_overrides = _codex_mcp_config_overrides(
        _dramaclaw_mcp_servers(tool_mode)
    )
    turn_metadata = {_CODEX_GATEWAY_KEY_METADATA: gateway_api_key}
    if control_capability:
        turn_metadata[_CODEX_CONTROL_CAPABILITY_METADATA] = control_capability
    client = CodexClient(
        codex_bin=_codex_bin_path(),
        cwd=workspace,
        env=env,
        model=_codex_model(),
        model_provider=_CODEX_MODEL_PROVIDER,
        developer_instructions=_codex_developer_instructions(tool_mode),
        config_overrides=node_config_overrides,
        thread_config_overrides=thread_config_overrides,
        turn_metadata=turn_metadata,
    )
    thread_id = _get_codex_thread_id(
        username,
        project,
        agent_profile=agent_profile,
        canvas_id=canvas_id,
        project_state_dir=project_state_dir,
    )
    return client.thread_resume(thread_id) if thread_id else client.thread_start()


async def interrupt_chat_turn(
    username: str,
    project: str,
    thread_id: str,
    turn_id: str,
    *,
    backend: str | None = None,
) -> bool:
    thread_id = str(thread_id or "").strip()
    turn_id = str(turn_id or "").strip()
    backend = str(backend or "").strip() or _chat_backend()
    if backend == "claude":
        if not thread_id:
            return False
        try:
            return await interrupt_live_claude_client(thread_id)
        except Exception as exc:
            if "closed stdout" in str(exc):
                return True
            raise
    if backend == "codex":
        if not thread_id or not turn_id:
            return False
        try:
            interrupted = await asyncio.to_thread(
                interrupt_live_codex_turn, thread_id, turn_id
            )
            if interrupted:
                return True
            return await asyncio.to_thread(
                _control_codex_thread, "interrupt", thread_id, turn_id
            )
        except Exception as exc:
            if "app-server closed stdout" in str(exc):
                return True
            raise
    return False


async def interrupt_active_codex_turns(username: str) -> bool:
    """Interrupt every live Codex turn owned by one logged-in user."""

    normalized = str(username or "").strip()
    if not normalized:
        return False
    with _ACTIVE_CODEX_TURNS_LOCK:
        turns = [
            value
            for (turn_username, _project), value in _ACTIVE_CODEX_TURNS.items()
            if turn_username == normalized
        ]
    turns.extend(
        (entry.get("thread_id", ""), entry.get("turn_id", ""))
        for entry in _load_active_codex_turns(normalized).values()
    )
    turns = list({turn for turn in turns if turn[0] and turn[1]})

    async def interrupt_pair(thread_id: str, turn_id: str) -> bool:
        local = await asyncio.to_thread(interrupt_live_codex_turn, thread_id, turn_id)
        if local:
            return True
        return await asyncio.to_thread(
            _control_codex_thread, "interrupt", thread_id, turn_id
        )

    results = await asyncio.gather(
        *(interrupt_pair(thread_id, turn_id) for thread_id, turn_id in turns),
        return_exceptions=True,
    )
    return any(result is True for result in results)


async def stream_assistant_reply(
    username: str,
    project: str,
    prompt: str,
    on_event,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
    surface: str | None = None,
    surface_context: dict[str, Any] | None = None,
    store_scope: Any | None = None,
    turn_id: str | None = None,
    route_prompt: str | None = None,
    egress_context=None,
    requester_user_id: str | None = None,
    egress_project_id: str | None = None,
    backend: str | None = None,
) -> dict[str, Any]:
    tool_mode = _tool_mode_for_surface(
        surface,
        prompt=prompt,
        surface_context=surface_context,
    )
    lock_project = _chat_run_lock_project_for_turn(
        project,
        tool_mode=tool_mode,
        store_scope=store_scope,
    )
    run_lock_id = _acquire_chat_run_lock(username, lock_project)
    heartbeat_task = asyncio.create_task(
        _chat_run_lock_heartbeat_loop(username, lock_project, run_lock_id)
    )
    try:
        deterministic = _frontend_context_reply(prompt)
        if deterministic is not None:
            return await _stream_deterministic_assistant_reply(
                username,
                project,
                deterministic,
                on_event,
                project_dir=project_dir,
                project_state_dir=project_state_dir,
            )
        model_prompt = (
            _script_creation_model_reply_prompt(prompt, tool_mode=tool_mode) or prompt
        )
        backend = str(backend or "").strip() or _chat_backend()
        if backend == "codex":
            return await _stream_assistant_reply_codex(
                username,
                project,
                model_prompt,
                on_event,
                project_dir=project_dir,
                project_state_dir=project_state_dir,
                egress_context=egress_context,
                requester_user_id=requester_user_id,
                egress_project_id=egress_project_id,
                tool_mode=tool_mode,
                surface_context=surface_context,
                store_scope=store_scope,
                turn_id=turn_id,
                route_prompt=route_prompt,
            )
        if backend == "hermes":
            return await _stream_assistant_reply_hermes(
                username,
                project,
                model_prompt,
                on_event,
                project_dir=project_dir,
                project_state_dir=project_state_dir,
                tool_mode=tool_mode,
                surface_context=surface_context,
                store_scope=store_scope,
                turn_id=turn_id,
                route_prompt=route_prompt,
                egress_context=egress_context,
                requester_user_id=requester_user_id,
            )
        if backend != "claude":
            raise RuntimeError(f"Unsupported chat backend: {backend}")
        return await _stream_assistant_reply_claude(
            username,
            project,
            model_prompt,
            on_event,
            project_dir=project_dir,
            project_state_dir=project_state_dir,
            egress_context=egress_context,
        )
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        _release_chat_run_lock(username, lock_project, run_lock_id)


def _frontend_context_reply(prompt: str) -> str | None:
    confirmation = _REINGEST_CONFIRMATION_BLOCK_RE.search(prompt)
    if confirmation:
        body = confirmation.group(1)
        if re.search(r"(?m)^\s*stage:\s*confirm_clear\s*$", body):
            return (
                "覆盖会清空/重建当前项目已有角色、分集、脚本、草图、音频、视频等"
                "流水线结果。是否继续？\n\n请回复 `确定` 或 `继续` 后才会开始覆盖。"
            )
        return (
            "当前项目已有摄入内容，继续会覆盖现有项目。是否要覆盖当前项目？\n\n"
            "请回复 `覆盖` 进入下一步确认。"
        )

    return None


def _script_creation_model_reply_prompt(
    prompt: str,
    *,
    tool_mode: str = "default",
) -> str | None:
    if not prompt:
        return None
    # 虾画的动态工作流可以把一句创意展开成短视频脚本、广告文案和分镜文本节点。
    # “必须从虾料上传剧本”的限制只属于主线 NovelVideo 摄入流程，不能在进入
    # Freezone workflow Skill 前把合法的画布创作请求提前拦截。
    if tool_mode == "freezone_canvas":
        return None
    if _DRAMACLAW_INGEST_AUTOMATION_RE.search(prompt):
        return None
    if _CHAT_ATTACHMENTS_BLOCK_RE.search(prompt):
        return None

    text = _CHAT_ATTACHMENTS_BLOCK_RE.sub("", prompt).strip()
    if _CONTINUE_PIPELINE_RE.search(text):
        return None
    if _SCRIPT_CREATION_REQUEST_RE.search(text) or _STYLE_SHORT_DRAMA_REQUEST_RE.search(
        text
    ):
        return (
            f"{_DRAMACLAW_SCRIPT_UPLOAD_MODEL_REPLY_INSTRUCTIONS}"
            f"\n\n用户原话：{text}"
        )
    return None


async def _stream_deterministic_assistant_reply(
    username: str,
    project: str,
    content: str,
    on_event,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> dict[str, Any]:
    content = _redact_local_filesystem_paths(content)
    message = await asyncio.to_thread(
        add_assistant_message,
        username,
        project,
        content,
        [],
        project_dir=project_dir,
        project_state_dir=project_state_dir,
    )
    await _emit_chat_event_best_effort(
        on_event, {"type": "assistant_delta", "text": content}
    )
    await _emit_chat_event_best_effort(on_event, {"type": "done", "message": message})
    return message


async def prewarm_chat_backend(
    username: str,
    *,
    project: str | None = None,
    surface: str | None = None,
    agent_id: str | None = None,
) -> None:
    """Best-effort pre-warm of the per-user agent worker.

    Called when the user opens a chat / switches project so the first real
    message doesn't pay the full cold-start (spawn → initialize → session/new
    with startup probes). No-op unless the hermes backend is active; never
    raises — pre-warming is purely an optimization.
    """
    try:
        if _chat_backend() != "hermes":
            return
        from novelvideo.chat.hermes_pool import pool as _hermes_pool

        tool_mode = _tool_mode_for_surface(surface)
        agent_profile = (
            f"freezone:{agent_id or 'main'}"
            if tool_mode == "freezone_canvas"
            else "main"
        )
        await _hermes_pool.prewarm(
            username,
            agent_profile=agent_profile,
            tool_mode=tool_mode,
            scope_kind="project" if project else "home",
            project_id=project or None,
            surface="freezone" if tool_mode == "freezone_canvas" else None,
            canvas_id="default" if tool_mode == "freezone_canvas" else None,
        )
    except Exception:
        return


async def authorize_hermes_launch(
    *,
    egress_context,
    username: str,
    requester_user_id: str | None,
    egress_project_id: str,
    prompt: str,
):
    """Turn this request's trusted egress context into a one-shot launch authorization.

    请求路径上 project 态与 home 态是两条独立实现（home 的流式循环在
    `api/routes/chat.py` 里，完全绕开本模块），但「怎么换取 authorization」
    必须只有一份。抽在这里而不是 `hermes_egress.py`：后者刻意用依赖注入收
    `credential_resolver` / `operation_port`，把端口查找塞进去会破坏那个设计。

    `egress_context` 为 `None`（平台／个人／CE local／灰度未开）时返回 `None`，
    调用方照传给 `get_for_user`，平台路径逐字节不变。

    `egress_project_id` 是**出网身份**，不是会话身份：project 态传真实 project id，
    home 态传 `HOME_SCOPE_EGRESS_PROJECT_ID` 哨兵。它必须与绑定时
    `request_egress_scope(project_id=...)` 用的值一致——`_strict_admission` 在
    `authorize_credentialed_hermes` 与 `build_hermes_child_env` 两处各比一次。
    """

    if egress_context is None:
        return None

    # 函数内局部导入：规避循环导入（本模块被 `hermes_pool` 一侧间接引用）。
    # 这是抽 helper 之前就有的写法，原样保留，不提到模块顶层。
    from novelvideo.chat.hermes_egress import (
        EgressBoundaryError,
        authorize_credentialed_hermes,
    )
    from novelvideo.ports import get_egress_operation_port, get_model_credentials

    # 身份判定只认 user_id。缺了就拒，不得回落成登录名 username——
    # 那是两个不同的值，回落会把坏口径固化成"看起来能用"。
    if not requester_user_id:
        raise EgressBoundaryError("TASK_ENVELOPE_INVALID")
    return await authorize_credentialed_hermes(
        context=egress_context,
        username=username,
        requester_user_id=requester_user_id,
        project_id=egress_project_id,
        prompt=prompt,
        credential_resolver=get_model_credentials(),
        operation_port=get_egress_operation_port(),
    )


async def _stream_assistant_reply_hermes(
    username: str,
    project: str,
    prompt: str,
    on_event,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
    tool_mode: str = "default",
    surface_context: dict[str, Any] | None = None,
    store_scope: Any | None = None,
    turn_id: str | None = None,
    route_prompt: str | None = None,
    egress_context=None,
    requester_user_id: str | None = None,
) -> dict[str, Any]:
    """Stream via Hermes ACP subprocess (per-user, sandboxed).

    HermesPool owns the native thread lifecycle. The live worker cache remains
    per user/profile, while project sessions and memory are persisted below the
    authoritative project state directory.
    """
    from novelvideo.chat.hermes_pool import pool as _hermes_pool

    authorization = await authorize_hermes_launch(
        egress_context=egress_context,
        username=username,
        requester_user_id=requester_user_id,
        egress_project_id=project,
        prompt=prompt,
    )
    store_agent_id = str(getattr(store_scope, "agent_id", "") or "").strip()
    agent_profile = (
        f"freezone:{store_agent_id or 'main'}"
        if tool_mode == "freezone_canvas"
        else "main"
    )
    surface = "freezone" if tool_mode == "freezone_canvas" else None
    canvas_id = (
        _freezone_canvas_id_from_context(surface_context)
        if surface == "freezone"
        else None
    )
    _write_hermes_tool_mode(username, mode=tool_mode)
    agent_prompt = _prompt_with_user_context(
        username,
        project,
        prompt,
        tool_mode=tool_mode,
        surface_context=surface_context,
        route_prompt=route_prompt,
    )
    thread = await _hermes_pool.get_for_user(
        username,
        agent_profile=agent_profile,
        tool_mode=tool_mode,
        scope_kind="project" if project else "home",
        project_id=project or None,
        surface=surface,
        canvas_id=canvas_id,
        # 出网身份与会话身份分开传。这两个必须来自调用方，不得从
        # `authorization.context` 自己取——那样 `build_hermes_child_env` 里的
        # 身份复核就退化成自证。home 态的出网 project 哨兵是 S5 的事，本片不碰。
        egress_project_id=project or None,
        requester_user_id=requester_user_id,
        authorization=authorization,
    )
    if store_scope is not None:
        previous_assistant = await _store_history_contents_async(
            username,
            store_scope,
            "assistant",
        )
        previous_trace = await _store_history_contents_async(
            username,
            store_scope,
            "trace",
        )
    elif project:
        previous_assistant = await asyncio.to_thread(
            _assistant_history_contents,
            username,
            project,
            project_dir=project_dir,
            project_state_dir=project_state_dir,
        )
        previous_trace = await asyncio.to_thread(
            _trace_history_contents,
            username,
            project,
            project_dir=project_dir,
            project_state_dir=project_state_dir,
        )
    else:
        previous_assistant = []
        previous_trace = []
    assistant_prefix_candidates = _assistant_prefix_candidates(previous_assistant)
    trace_prefix_candidates = _assistant_prefix_candidates(previous_trace)
    assistant_text = ""
    tool_text = ""
    tool_ui_specs: list[dict[str, Any]] = []
    fallback_tool_ui_specs: list[dict[str, Any]] = []
    fallback_token: str | None = None
    current_tool_name: str | None = None
    current_tool_hidden = False
    persisted_message: dict[str, Any] | None = None
    seen_display_calls: set[str] = set()
    seen_tool_chat_errors: set[str] = set()

    # One claim per business turn, settled exactly once at this boundary. The
    # retries below re-send the prompt but are still this turn, so they share
    # the finalizer and must not claim again. A platform turn has no
    # authorization and therefore nothing to settle.
    turn_operation = _turn_operation_finalizer(authorization)
    turn_disposition = _DEFAULT_TURN_DISPOSITION

    async def _settle_turn_operation() -> None:
        """Close the ledger entry for this turn, whatever ended it.

        Runs from the generator's finally, so it also covers the cancellation
        path: an aclose() during streaming means the turn stopped after the
        prompt had reached the agent, which is unknown rather than rejected.
        """
        if turn_operation is None:
            return
        await turn_operation.finish(turn_disposition)

    async def hermes_events_with_session_retry():
        nonlocal thread, assistant_text, tool_text, current_tool_name, current_tool_hidden
        nonlocal turn_disposition
        from novelvideo.chat.hermes_sdk import (
            HermesSessionUnavailableError,
            _is_session_unavailable_error,
        )

        retried = False
        guard_retried = False
        stream_prompt = agent_prompt
        while True:
            saw_complete = False
            restart_stream = False
            try:
                async for stream_event in thread.stream(
                    stream_prompt,
                    current_project=project or None,
                    # Evidence identity for this turn. Raw ids: they are hashed
                    # inside DramaClaw and never leave the process as-is.
                    **_evidence_identity(project, store_scope, agent_profile),
                ):
                    if stream_event.type == "egress_submitted":
                        # The prompt reached the ACP stream. Past this point the
                        # ledger may no longer claim the request was never sent.
                        # Internal signal: it is consumed here and never
                        # forwarded to the client or the transcript.
                        if turn_operation is not None:
                            await turn_operation.submitted_to_agent()
                        continue
                    if stream_event.type == "complete":
                        saw_complete = True
                        turn_disposition = _turn_disposition_for(stream_event)
                    guard_details = (
                        stream_event.raw
                        if stream_event.type == "complete"
                        and isinstance(stream_event.raw, dict)
                        else {}
                    )
                    if (
                        tool_mode == "freezone_canvas"
                        and not guard_retried
                        and guard_details.get("reason") == "tool_call_guard"
                        and guard_details.get("guard_reason") == "repeated_read"
                        and guard_details.get("tool_name")
                        not in {
                            "freezone_prepare_workflow_draft",
                            "freezone_prepare_workflow_plan_draft",
                            "freezone_patch_workflow_draft",
                            "freezone_confirm_workflow_draft",
                        }
                        and not guard_details.get("had_write")
                    ):
                        guard_tool_name = str(
                            guard_details.get("tool_name") or ""
                        ).strip()
                        logger.warning(
                            "hermes repeated freezone read; resetting and recovering once "
                            "user=%s project=%s agent_profile=%s canvas=%s tool=%s",
                            username,
                            project or None,
                            agent_profile,
                            canvas_id,
                            guard_tool_name or None,
                        )
                        thread = await _hermes_pool.reset_for_user(
                            username,
                            agent_profile=agent_profile,
                            tool_mode=tool_mode,
                            scope_kind="project" if project else "home",
                            project_id=project or None,
                            surface=surface,
                            canvas_id=canvas_id,
                        )
                        assistant_text = ""
                        tool_text = ""
                        current_tool_name = None
                        current_tool_hidden = False
                        stream_prompt = agent_prompt + """

[FREEZONE_AUTOMATIC_RECOVERY]
上一次执行因重复读取同一份 Skill、画布上下文或节点状态而被内部守卫中止。不要要求用户改写或重发请求。
复用上一次已经获得的信息，不要再次重复读取同一项；确有必要时，同一项最多读取一次。
如果用户原始请求是创建或更新动态工作流，必须继续遵守已选 Workflow Skill 的草稿流程：
报价查询、Skill 规划包读取和工作流草稿准备各最多调用一次；不得使用 freezone_emit_canvas_command
或逐节点创建来绕过工作流草稿、用户确认与确定性校验。若仍缺少决定性信息，只询问一个有针对性的问题。
完成用户原始请求后再回复结果。
[/FREEZONE_AUTOMATIC_RECOVERY]"""
                        guard_retried = True
                        restart_stream = True
                        break
                    if (
                        not retried
                        and stream_event.type == "complete"
                        and not assistant_text.strip()
                        and not tool_text.strip()
                        and _is_session_unavailable_error(stream_event.text)
                    ):
                        logger.warning(
                            "hermes prompt completed with unavailable cached session; resetting and retrying once "
                            "user=%s project=%s agent_profile=%s canvas=%s: %s",
                            username,
                            project or None,
                            agent_profile,
                            canvas_id,
                            stream_event.text,
                        )
                        thread = await _hermes_pool.reset_for_user(
                            username,
                            agent_profile=agent_profile,
                            tool_mode=tool_mode,
                            scope_kind="project" if project else "home",
                            project_id=project or None,
                            surface=surface,
                            canvas_id=canvas_id,
                        )
                        retried = True
                        restart_stream = True
                        break
                    yield stream_event
                if restart_stream:
                    continue
                if (
                    not retried
                    and not saw_complete
                    and not assistant_text.strip()
                    and not tool_text.strip()
                ):
                    logger.warning(
                        "hermes stream ended before completion; resetting and retrying once "
                        "user=%s project=%s agent_profile=%s canvas=%s",
                        username,
                        project or None,
                        agent_profile,
                        canvas_id,
                    )
                    thread = await _hermes_pool.reset_for_user(
                        username,
                        agent_profile=agent_profile,
                        tool_mode=tool_mode,
                        scope_kind="project" if project else "home",
                        project_id=project or None,
                        surface=surface,
                        canvas_id=canvas_id,
                    )
                    retried = True
                    continue
                else:
                    return
            except HermesSessionUnavailableError as exc:
                if retried or assistant_text.strip() or tool_text.strip():
                    raise
                logger.warning(
                    "hermes cached session unavailable; resetting and retrying once "
                    "user=%s project=%s agent_profile=%s canvas=%s: %s",
                    username,
                    project or None,
                    agent_profile,
                    canvas_id,
                    exc,
                )
                thread = await _hermes_pool.reset_for_user(
                    username,
                    agent_profile=agent_profile,
                    tool_mode=tool_mode,
                    scope_kind="project" if project else "home",
                    project_id=project or None,
                    surface=surface,
                    canvas_id=canvas_id,
                )
                retried = True
                continue
            return

    async def persist_partial_reply() -> dict[str, Any] | None:
        nonlocal persisted_message, assistant_text, tool_text
        if persisted_message is not None:
            return persisted_message
        final_text = _strip_replayed_chat_response(
            assistant_text,
            previous_assistant,
            prompt,
            assistant_prefix_candidates=assistant_prefix_candidates,
        ).strip()
        if _allows_mainline_media_ui_specs(tool_mode):
            all_tool_ui_specs = _dedupe_tool_ui_specs(
                [*tool_ui_specs, *fallback_tool_ui_specs]
            )
            all_tool_ui_specs = _filter_tool_ui_specs_for_prompt(
                prompt, all_tool_ui_specs
            )
            final_text = _append_tool_ui_specs(final_text, all_tool_ui_specs)
        else:
            final_text, _discarded_ui_specs = _split_ui_specs_from_text(final_text)
            final_text = _strip_embedded_ui_spec_json_text(final_text)
            final_text = _strip_media_rendering_leaks(final_text)
        if not final_text:
            return None
        final_text = _normalize_json_render_reply(final_text)
        final_tool_text = _strip_replayed_assistant_prefix(
            tool_text,
            previous_trace,
            candidates=trace_prefix_candidates,
        )
        if final_tool_text.strip():
            if store_scope is not None:
                from novelvideo.chat.store import chat_store

                for trace_index, trace_content in enumerate(
                    _split_trace_contents(final_tool_text)
                ):
                    await chat_store.append_message_async(
                        username,
                        store_scope,
                        "trace",
                        trace_content,
                        turn_id=turn_id,
                        idempotency_key=(
                            f"trace:{turn_id}:{trace_index}" if turn_id else None
                        ),
                    )
            else:
                await asyncio.to_thread(
                    add_trace_messages,
                    username,
                    project,
                    _split_trace_contents(final_tool_text),
                    project_dir=project_dir,
                    project_state_dir=project_state_dir,
                )
        media = _extract_media(final_text, username, project, project_dir=project_dir)
        if store_scope is not None:
            from novelvideo.chat.store import chat_store

            persisted_message = await chat_store.append_message_async(
                username,
                store_scope,
                "assistant",
                final_text,
                media=media,
                turn_id=turn_id,
                idempotency_key=f"assistant:{turn_id}" if turn_id else None,
            )
        else:
            persisted_message = await asyncio.to_thread(
                add_assistant_message,
                username,
                project,
                final_text,
                media,
                project_dir=project_dir,
                project_state_dir=project_state_dir,
            )
        return persisted_message

    try:
        async for event in hermes_events_with_session_retry():
            if event.type == "thread_started":
                await _emit_chat_event_best_effort(
                    on_event,
                    {
                        "type": "thread_started",
                        "thread_id": str(event.thread_id or "").strip() or None,
                        "turn_id": str(event.turn_id or "").strip() or None,
                    },
                )
                continue
            if event.type == "turn_started":
                await on_event(
                    {
                        "type": "turn_started",
                        "thread_id": str(event.thread_id or "").strip() or None,
                        "turn_id": str(event.turn_id or "").strip() or None,
                        "status": event.status or "in_progress",
                    }
                )
                continue
            if event.type == "turn_completed":
                turn_disposition = str(
                    event.disposition or event.status or turn_disposition
                )
                await on_event(
                    {
                        "type": "turn_completed",
                        "thread_id": str(event.thread_id or "").strip() or None,
                        "turn_id": str(event.turn_id or "").strip() or None,
                        "status": event.status or "completed",
                        "error": event.error,
                        "disposition": event.disposition,
                    }
                )
                continue
            if event.type == "assistant_delta":
                assistant_text = _merge_stream_text(assistant_text, event.text)
                streamed_text = _strip_replayed_chat_response(
                    assistant_text,
                    previous_assistant,
                    prompt,
                    suppress_partial_replay=True,
                    assistant_prefix_candidates=assistant_prefix_candidates,
                )
                streamed_text = _strip_freezone_tool_lifecycle_failure_text(
                    streamed_text,
                    tool_mode=tool_mode,
                )
                streamed_text = _redact_local_filesystem_paths(streamed_text)
                await _emit_chat_event_best_effort(
                    on_event,
                    {
                        "type": "assistant_delta",
                        "text": streamed_text,
                    },
                )
                continue
            if event.type == "thought_delta":
                await _emit_chat_event_best_effort(
                    on_event,
                    {"type": "thought_delta", "text": str(event.text or "")},
                )
                continue
            if event.type == "plan_update":
                await _emit_chat_event_best_effort(
                    on_event,
                    {"type": "plan_update", "entries": event.entries or []},
                )
                continue
            if event.type == "usage_update":
                await _emit_chat_event_best_effort(
                    on_event,
                    {"type": "usage_update", "usage": event.usage or {}},
                )
                continue
            if event.type == "permission_requested":
                await _emit_chat_event_best_effort(
                    on_event,
                    {
                        "type": "permission_requested",
                        "request_id": event.request_id,
                        "text": str(event.text or "需要操作授权"),
                        "options": event.options or [],
                        "tool_call": event.raw,
                    },
                )
                continue
            if event.type in {"tool_started", "tool_updated", "tool_update"}:
                if event.raw is not None:
                    tool_chat_error = None
                    raw = event.raw
                    suppress_lifecycle_error = _suppress_freezone_tool_lifecycle_error(
                        raw,
                        tool_mode=tool_mode,
                    )
                    if not suppress_lifecycle_error:
                        tool_chat_error = _extract_tool_chat_error(raw)
                    tool_chat_error = _visible_tool_chat_error_for_mode(
                        tool_chat_error,
                        tool_mode=tool_mode,
                    )
                    if tool_chat_error and tool_chat_error not in seen_tool_chat_errors:
                        seen_tool_chat_errors.add(tool_chat_error)
                        assistant_text = _merge_stream_text(
                            assistant_text,
                            ("\n\n" if assistant_text.strip() else "")
                            + tool_chat_error,
                        )
                        await _emit_chat_event_best_effort(
                            on_event,
                            {
                                "type": "assistant_delta",
                                "text": _redact_local_filesystem_paths(tool_chat_error),
                            },
                        )
                    if _allows_mainline_media_ui_specs(tool_mode):
                        tool_ui_specs.extend(_extract_tool_ui_specs(event.raw))
                    display_call = (
                        _extract_display_tool_call(event.raw)
                        if _allows_mainline_media_ui_specs(tool_mode)
                        else None
                    )
                    if display_call is not None:
                        tool_name, tool_args = display_call
                        display_call_key = _display_tool_call_key(tool_name, tool_args)
                        if display_call_key in seen_display_calls:
                            logger.info(
                                "filtered duplicate hermes display fallback "
                                "turn_id=%s project=%s tool=%s args=%s raw_kind=%s",
                                event.turn_id,
                                project,
                                tool_name,
                                json.dumps(
                                    tool_args,
                                    ensure_ascii=False,
                                    sort_keys=True,
                                    default=str,
                                )[:1000],
                                (
                                    event.raw.get("sessionUpdate")
                                    if isinstance(event.raw, dict)
                                    else None
                                ),
                            )
                        else:
                            seen_display_calls.add(display_call_key)
                            if fallback_token is None:
                                fallback_token = await _create_page_agent_session_token(
                                    username,
                                    project,
                                    agent_kind="hermes-display-fallback",
                                )
                            fallback_tool_ui_specs.extend(
                                await _fallback_display_tool_ui_specs(
                                    username,
                                    project,
                                    tool_name,
                                    tool_args,
                                    token=fallback_token,
                                    project_dir=project_dir,
                                )
                            )
                if event.name:
                    current_tool_name = event.name
                    current_tool_hidden = _is_hidden_chat_tool_event(
                        event.name, event.text
                    )
                elif _is_anonymous_hermes_tool_call_update(event):
                    continue
                if _is_hermes_lifecycle_tool_update(event):
                    continue
                if current_tool_hidden or _is_hidden_chat_tool_event(
                    current_tool_name, event.text
                ):
                    continue
                event_tool_text = str(event.text or "")
                tool_text += event_tool_text + "\n"
                display_tool_text = _strip_replayed_assistant_prefix(
                    event_tool_text,
                    previous_trace,
                    candidates=trace_prefix_candidates,
                )
                if display_tool_text.strip():
                    await _emit_chat_event_best_effort(
                        on_event,
                        {
                            "type": (
                                event.type
                                if event.type in {"tool_started", "tool_updated"}
                                else "tool_updated"
                            ),
                            "text": str(event.text or "").strip(),
                            "name": current_tool_name,
                            "call_id": event.call_id,
                            "status": event.status
                            or (
                                "pending"
                                if event.type == "tool_started"
                                else "completed"
                            ),
                            "input": event.input,
                            "output": event.output,
                            "error": event.error,
                            "result_json": event.structured,
                        },
                    )
                continue
            if event.type == "complete":
                if seen_tool_chat_errors and assistant_text.strip():
                    continue
                assistant_text = _completion_text_or_existing(
                    event.text, assistant_text
                )

        assistant_text = _strip_freezone_tool_lifecycle_failure_text(
            assistant_text,
            tool_mode=tool_mode,
        )
        if not assistant_text.strip():
            assistant_text = "这轮操作没有收到虾导的有效回复，请稍后重试。"
        if (
            _allows_mainline_media_ui_specs(tool_mode)
            and not tool_ui_specs
            and not fallback_tool_ui_specs
        ):
            inferred_display_call = _infer_display_tool_call_from_text(
                prompt,
                assistant_text,
                previous_assistant,
            )
            if inferred_display_call is not None:
                tool_name, tool_args = inferred_display_call
                if fallback_token is None:
                    fallback_token = await _create_page_agent_session_token(
                        username,
                        project,
                        agent_kind="hermes-display-fallback",
                    )
                fallback_tool_ui_specs.extend(
                    await _fallback_display_tool_ui_specs(
                        username,
                        project,
                        tool_name,
                        tool_args,
                        token=fallback_token,
                        project_dir=project_dir,
                    )
                )
        result_message = await persist_partial_reply()
        if result_message is None:
            if store_scope is not None:
                from novelvideo.chat.store import chat_store

                result_message = await chat_store.append_message_async(
                    username,
                    store_scope,
                    "assistant",
                    "这轮操作没有收到虾导的有效回复，请稍后重试。",
                    media=[],
                    turn_id=turn_id,
                    idempotency_key=f"assistant:{turn_id}" if turn_id else None,
                )
            else:
                result_message = await asyncio.to_thread(
                    add_assistant_message,
                    username,
                    project,
                    "这轮操作没有收到虾导的有效回复，请稍后重试。",
                    [],
                    project_dir=project_dir,
                    project_state_dir=project_state_dir,
                )
            persisted_message = result_message
        await _emit_chat_event_best_effort(
            on_event,
            {"type": "assistant_message", "message": result_message},
        )
        await _emit_chat_event_best_effort(
            on_event, {"type": "done", "message": result_message}
        )
        return result_message
    except Exception:
        raise
    finally:
        # Nested so neither can prevent the other. A turn that cannot persist
        # its partial reply must still settle its ledger entry, and a ledger
        # that cannot be written must still leave the transcript intact.
        try:
            await _settle_turn_operation()
        finally:
            await persist_partial_reply()


async def _stream_assistant_reply_claude(
    username: str,
    project: str,
    prompt: str,
    on_event,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
    egress_context=None,
) -> dict[str, Any]:
    try:
        agent_token = await _create_page_agent_session_token(
            username,
            project,
            agent_kind="claude",
        )
        thread = _build_claude_thread(
            username, project, agent_token, egress_context=egress_context
        )
        agent_prompt = _prompt_with_user_context(username, project, prompt)
        assistant_text = ""
        tool_text = ""
        async for event in thread.stream(agent_prompt):
            if event.type == "thread_started":
                thread_id = str(event.thread_id or "").strip() or None
                if thread_id:
                    _set_claude_session_id(username, project, thread_id)
                await on_event(
                    {
                        "type": "thread_started",
                        "thread_id": thread_id,
                        "turn_id": str(event.turn_id or "").strip() or None,
                    }
                )
                continue
            if event.type == "assistant_delta":
                assistant_text = _merge_stream_text(assistant_text, event.text)
                streamed_text = _redact_local_filesystem_paths(assistant_text)
                await on_event(
                    {
                        "type": "assistant_delta",
                        "text": streamed_text,
                    }
                )
                continue
            if event.type == "thought_delta":
                await on_event(
                    {
                        "type": "thought_delta",
                        "text": str(event.text or ""),
                        "source": event.name,
                    }
                )
                continue
            if event.type == "plan_update":
                await on_event(
                    {
                        "type": "plan_update",
                        "text": str(event.text or ""),
                        "entries": event.entries or [],
                    }
                )
                continue
            if event.type == "usage_update":
                await on_event({"type": "usage_update", "usage": event.usage or {}})
                continue
            if event.type in {"tool_started", "tool_updated"}:
                event_tool_text = str(event.text or "")
                if event_tool_text:
                    tool_text += event_tool_text
                await on_event(
                    {
                        "type": event.type,
                        "text": event_tool_text.strip(),
                        "name": event.name,
                        "call_id": event.call_id,
                        "status": event.status,
                        "input": event.input,
                        "output": event.output,
                        "error": event.error,
                        "result_json": event.structured,
                    }
                )
                continue
            if event.type == "tool_update":
                tool_text = str(event.text or "")
                await on_event(
                    {
                        "type": "tool_update",
                        "text": tool_text,
                        "name": event.name,
                        "result_json": event.structured,
                    }
                )
                continue
            if event.type == "complete":
                thread_id = str(event.thread_id or "").strip() or None
                if thread_id:
                    _set_claude_session_id(username, project, thread_id)
                assistant_text = _completion_text_or_existing(
                    event.text, assistant_text
                )

        assistant_text = assistant_text.strip() or "已执行，但没有返回正文。"
        assistant_text = _normalize_json_render_reply(assistant_text)
        if tool_text.strip():
            await asyncio.to_thread(
                add_trace_messages,
                username,
                project,
                _split_trace_contents(tool_text),
                project_dir=project_dir,
                project_state_dir=project_state_dir,
            )
        media = _extract_media(
            assistant_text, username, project, project_dir=project_dir
        )
        result_message = await asyncio.to_thread(
            add_assistant_message,
            username,
            project,
            assistant_text,
            media,
            project_dir=project_dir,
            project_state_dir=project_state_dir,
        )
        await on_event({"type": "done", "message": result_message})
        return result_message
    except Exception:
        raise


async def _stream_assistant_reply_codex(
    username: str,
    project: str,
    prompt: str,
    on_event,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
    egress_context=None,
    requester_user_id: str | None = None,
    egress_project_id: str | None = None,
    tool_mode: str = "default",
    surface_context: dict[str, Any] | None = None,
    store_scope: Any | None = None,
    turn_id: str | None = None,
    route_prompt: str | None = None,
) -> dict[str, Any]:
    assistant_text = ""
    tool_text = ""
    requires_canvas_write_receipt = str(
        tool_mode or ""
    ).strip() == "freezone_canvas" and _freezone_canvas_write_requested(prompt)
    canvas_write_attempted = False
    canvas_write_succeeded = False
    canvas_write_failure = ""
    ready_workflow_draft: dict[str, Any] | None = None
    authorization = await authorize_hermes_launch(
        egress_context=egress_context,
        username=username,
        requester_user_id=requester_user_id,
        egress_project_id=egress_project_id or project,
        prompt=prompt,
    )
    turn_operation = _turn_operation_finalizer(authorization)
    turn_disposition = _DEFAULT_TURN_DISPOSITION
    store_agent_id = str(getattr(store_scope, "agent_id", "") or "").strip()
    agent_profile = (
        f"freezone:{store_agent_id or 'main'}"
        if tool_mode == "freezone_canvas"
        else "main"
    )
    canvas_id = str(getattr(store_scope, "canvas_id", "") or "").strip() or None
    business_turn_id = str(turn_id or "").strip() or uuid.uuid4().hex
    evidence_identity = _evidence_identity(project, store_scope, agent_profile)
    from novelvideo.chat.hermes_sdk import _issue_turn_capability

    control_capability = _issue_turn_capability(
        trajectory_id=evidence_identity["trajectory_id"],
        project_id=evidence_identity["project_id"],
        turn_id=business_turn_id,
    )
    codex_scope_key = _codex_scope_key(
        project,
        agent_profile=agent_profile,
        canvas_id=canvas_id,
    )
    active_turn_key = (username, codex_scope_key)
    active_turn_value: tuple[str, str] | None = None
    agent_token: str | None = None
    token_file: Path | None = None
    logger.info(
        "codex turn start user=%s project=%s profile=%s tool_mode=%s canvas=%s turn=%s",
        username,
        project or "<home>",
        agent_profile,
        tool_mode,
        canvas_id or "-",
        business_turn_id,
    )
    try:
        agent_token = await _create_page_agent_session_token(
            username,
            project,
            agent_kind="codex",
            ttl_seconds=CODEX_AGENT_SESSION_TTL_SECONDS,
        )
        token_root = _runtime_root() / "codex" / "turn_tokens"
        token_file = _write_codex_turn_token(
            token_root,
            scope_key=f"{username}\0{codex_scope_key}",
            business_turn_id=business_turn_id,
            token=agent_token,
        )
        thread = _build_codex_thread(
            username,
            project,
            agent_token,
            egress_context=egress_context,
            authorization=authorization,
            control_capability=control_capability,
            agent_profile=agent_profile,
            tool_mode=tool_mode,
            canvas_id=canvas_id,
            project_state_dir=project_state_dir,
            agent_token_file=token_file,
        )
        agent_prompt = _prompt_with_user_context(
            username,
            project,
            prompt,
            tool_mode=tool_mode,
            surface_context=surface_context,
            route_prompt=route_prompt,
            turn_id=business_turn_id,
            require_generation_parameter_preflight=tool_mode == "freezone_canvas",
        )
        async for event in thread.stream(agent_prompt):
            logger.debug(
                "codex event user=%s project=%s profile=%s type=%s thread=%s turn=%s",
                username,
                project or "<home>",
                agent_profile,
                event.type,
                str(getattr(event, "thread_id", "") or "") or "-",
                str(getattr(event, "turn_id", "") or "") or "-",
            )
            if event.type == "egress_submitted":
                if turn_operation is not None:
                    await turn_operation.submitted_to_agent()
                continue
            if event.type == "egress_disposition":
                turn_disposition = str(event.disposition or _DEFAULT_TURN_DISPOSITION)
                continue
            if event.type == "thread_started":
                codex_thread_id = str(event.thread_id or "").strip() or None
                codex_turn_id = str(event.turn_id or "").strip() or None
                if codex_thread_id:
                    _set_codex_thread_id(
                        username,
                        project,
                        codex_thread_id,
                        agent_profile=agent_profile,
                        canvas_id=canvas_id,
                        project_state_dir=project_state_dir,
                    )
                if codex_thread_id and codex_turn_id:
                    active_turn_value = (codex_thread_id, codex_turn_id)
                    with _ACTIVE_CODEX_TURNS_LOCK:
                        _ACTIVE_CODEX_TURNS[active_turn_key] = active_turn_value
                    _set_active_codex_turn(username, codex_scope_key, active_turn_value)
                await on_event(
                    {
                        "type": "thread_started",
                        "thread_id": codex_thread_id,
                        "turn_id": codex_turn_id,
                    }
                )
                continue
            if event.type == "turn_started":
                await on_event(
                    {
                        "type": "turn_started",
                        "thread_id": str(event.thread_id or "").strip() or None,
                        "turn_id": str(event.turn_id or "").strip() or None,
                        "status": event.status or "in_progress",
                    }
                )
                continue
            if event.type == "turn_completed":
                turn_disposition = str(
                    event.disposition or event.status or turn_disposition
                )
                await on_event(
                    {
                        "type": "turn_completed",
                        "thread_id": str(event.thread_id or "").strip() or None,
                        "turn_id": str(event.turn_id or "").strip() or None,
                        "status": event.status or "completed",
                        "error": event.error,
                        "disposition": event.disposition,
                    }
                )
                continue
            if event.type == "assistant_delta":
                assistant_text = _merge_stream_text(assistant_text, event.text)
                if not requires_canvas_write_receipt:
                    streamed_text = _redact_local_filesystem_paths(assistant_text)
                    await on_event(
                        {
                            "type": "assistant_delta",
                            "text": streamed_text,
                        }
                    )
                continue
            if event.type == "thought_delta":
                await on_event(
                    {
                        "type": "thought_delta",
                        "text": str(event.text or ""),
                        "source": event.name,
                    }
                )
                continue
            if event.type == "plan_update":
                await on_event(
                    {
                        "type": "plan_update",
                        "text": str(event.text or ""),
                        "entries": event.entries or [],
                    }
                )
                continue
            if event.type == "usage_update":
                await on_event({"type": "usage_update", "usage": event.usage or {}})
                continue
            if event.type in {"tool_started", "tool_updated"}:
                if event.type == "tool_updated":
                    prepared_draft = _codex_freezone_ready_workflow_draft(event)
                    if prepared_draft is not None:
                        ready_workflow_draft = prepared_draft
                if _codex_freezone_tool_name(event) in _FREEZONE_CANVAS_WRITE_TOOLS:
                    canvas_write_attempted = True
                    if (
                        event.type == "tool_updated"
                        and _codex_freezone_write_result_succeeded(event)
                    ):
                        canvas_write_succeeded = True
                    elif event.type == "tool_updated":
                        failure = _codex_freezone_write_result_error(event)
                        if failure:
                            canvas_write_failure = failure
                event_tool_text = str(event.text or "")
                if event_tool_text:
                    tool_text += event_tool_text
                await on_event(
                    {
                        "type": event.type,
                        "text": event_tool_text.strip(),
                        "name": event.name,
                        "call_id": event.call_id,
                        "status": event.status,
                        "input": event.input,
                        "output": event.output,
                        "error": event.error,
                        "result_json": event.structured,
                    }
                )
                continue
            if event.type == "tool_update":
                tool_text += str(event.text or "")
                await on_event({"type": "tool_update", "text": tool_text})
                continue
            if event.type == "complete":
                codex_thread_id = str(event.thread_id or "").strip() or None
                if codex_thread_id:
                    _set_codex_thread_id(
                        username,
                        project,
                        codex_thread_id,
                        agent_profile=agent_profile,
                        canvas_id=canvas_id,
                        project_state_dir=project_state_dir,
                    )
                assistant_text = _completion_text_or_existing(
                    event.text, assistant_text
                )
                if turn_disposition == _DEFAULT_TURN_DISPOSITION:
                    turn_disposition = "completed"
                if not str(event.text or assistant_text or "").strip():
                    logger.warning(
                        "codex completed without assistant text user=%s project=%s profile=%s",
                        username,
                        project or "<home>",
                        agent_profile,
                    )
    finally:
        logger.info(
            "codex turn cleanup user=%s project=%s profile=%s disposition=%s had_text=%s had_tool=%s",
            username,
            project or "<home>",
            agent_profile,
            turn_disposition,
            bool(assistant_text.strip()),
            bool(tool_text.strip()),
        )
        if active_turn_value is not None:
            with _ACTIVE_CODEX_TURNS_LOCK:
                if _ACTIVE_CODEX_TURNS.get(active_turn_key) == active_turn_value:
                    _ACTIVE_CODEX_TURNS.pop(active_turn_key, None)
            try:
                _set_active_codex_turn(username, codex_scope_key, None)
            except OSError:
                logger.warning(
                    "failed to remove persisted active Codex turn",
                    exc_info=True,
                )
        if token_file is not None:
            try:
                token_file.unlink(missing_ok=True)
            except OSError:
                logger.warning("failed to remove Codex turn token file", exc_info=True)
        if agent_token:
            try:
                await get_auth_session_port().revoke_agent_session(agent_token)
            except Exception:
                logger.warning("failed to revoke Codex turn token", exc_info=True)
        if turn_operation is not None:
            await turn_operation.finish(turn_disposition)

    # A transport timeout/cancellation is not a canvas receipt failure. Keep
    # the runtime's actionable reason instead of replacing it with the
    # misleading "no canvas write" postcondition message.
    canvas_postcondition_applies = turn_disposition not in {"timeout", "cancelled"}
    if (
        requires_canvas_write_receipt
        and not canvas_write_succeeded
        and canvas_postcondition_applies
    ):
        if canvas_write_attempted:
            failure_detail = (
                canvas_write_failure or "没有收到成功的画布写入回执，请重试。"
            )
        elif _FREEZONE_CANVAS_NO_WRITE_FAILURE_RE.search(assistant_text):
            failure_detail = assistant_text.strip()
        elif ready_workflow_draft is not None:
            failure_detail = "工作流草稿已准备完成，但本轮未提交确认创建，请重试。"
        else:
            failure_detail = "本轮没有执行画布写入，请重试。"
        assistant_text = "画布操作未完成：" + failure_detail
    assistant_text = assistant_text.strip() or "已执行，但没有返回正文。"
    assistant_text = _normalize_json_render_reply(assistant_text)
    if requires_canvas_write_receipt:
        await on_event(
            {
                "type": "assistant_delta",
                "text": _redact_local_filesystem_paths(assistant_text),
            }
        )
    if tool_text.strip():
        if store_scope is not None:
            from novelvideo.chat.store import chat_store

            for trace_index, trace_content in enumerate(
                _split_trace_contents(tool_text)
            ):
                await chat_store.append_message_async(
                    username,
                    store_scope,
                    "trace",
                    trace_content,
                    turn_id=turn_id,
                    idempotency_key=(
                        f"trace:{turn_id}:{trace_index}" if turn_id else None
                    ),
                )
        else:
            await asyncio.to_thread(
                add_trace_messages,
                username,
                project,
                _split_trace_contents(tool_text),
                project_dir=project_dir,
                project_state_dir=project_state_dir,
            )
    media = _extract_media(assistant_text, username, project, project_dir=project_dir)
    if store_scope is not None:
        from novelvideo.chat.store import chat_store

        result_message = await chat_store.append_message_async(
            username,
            store_scope,
            "assistant",
            assistant_text,
            media=media,
            turn_id=turn_id,
            idempotency_key=f"assistant:{turn_id}" if turn_id else None,
        )
    else:
        result_message = await asyncio.to_thread(
            add_assistant_message,
            username,
            project,
            assistant_text,
            media,
            project_dir=project_dir,
            project_state_dir=project_state_dir,
        )
    await on_event({"type": "done", "message": result_message})
    return result_message


async def generate_assistant_reply(
    username: str, project: str, prompt: str
) -> dict[str, Any]:
    async def _ignore(_event: dict[str, Any]) -> None:
        return None

    return await stream_assistant_reply(username, project, prompt, _ignore)
