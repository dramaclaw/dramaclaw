"""freezone leaf 分发：判据是「是否出网」，不是「签名长什么样」。

`_call_freezone_leaf` 原先用 `inspect.signature` 判 leaf 是否接受
`egress_context`，不接受且信封属组织即抛 `InvalidTaskEnvelope`。签名形状不是
出网与否的证据，于是两个方向同时错：

- **误拦**：5 个纯本地 ffmpeg leaf（`run_freezone_extract_frames` /
  `run_freezone_video_upscale` / `run_freezone_video_compose` /
  `run_freezone_video_erase` / `run_freezone_audio_separate`，均为
  `egress-inventory.md:54` 的 EG-20a `service/local`，不出网、不取凭证）没有
  该形参，组织成员一律撞 `invalid task envelope`——用户报的「上传视频接脚本
  生成器、任务停在 ffmpeg 抽取关键帧」就是这条。
- **漏放**：`VAR_KEYWORD` 被算作「接受 context」，`**kwargs` leaf 会被判合规，
  context 被吞进 kwargs 袋子里静默失效。

改法是分发器内一张显式表，键由**调用点**提供。不能用「函数对象 → 分类」：
19 个调用点的 import 都在 runner 函数体内，测试 monkeypatch 后拿到的是假对象，
模块级建的对象表必然查不中；`leaf.__name__` 同理。

未列入表的 leaf 在组织上下文下**照旧抛**——默认仍 fail-closed（OI-47 护栏 a，
OI-32 已裁定同族 fail-closed 为有意设计）。
"""

from __future__ import annotations

import ast
import importlib
import inspect
from pathlib import Path

import pytest

from novelvideo.egress_context import (
    TRUSTED_EGRESS_CONTEXT_KEY,
    TrustedEgressContext,
    TrustedRunnerEnvelope,
)
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.envelope import InvalidTaskEnvelope

# `egress-inventory.md:54` EG-20a `service/local`——ffmpeg/subprocess，无凭证。
# 与 EE `feature_billing.py:389-399` 的计费豁免集逐条对应（同一批本地任务）。
AUDITED_LOCAL_LEAVES = frozenset(
    {
        "run_freezone_audio_separate",
        "run_freezone_extract_frames",
        "run_freezone_video_compose",
        "run_freezone_video_erase",
        "run_freezone_video_upscale",
    }
)


def _organization_context(task_type: str = "freezone_extract") -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-1",
        project_id="project-1",
        task_type=task_type,
        requester_user_id="user-1",
        root_task_id="task-1",
        admission_id="admission-1",
        admitted_at="2026-08-11T04:05:00Z",
        membership_id="membership-1",
        authz_version=11,
        billing_principal=BillingPrincipal(kind="organization", id="org-1"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-1",
            key_version=7,
            org_id="org-1",
        ),
    )


def _organization_envelope(
    tmp_path: Path,
    *,
    task_type: str = "freezone_extract",
    payload: dict | None = None,
) -> TrustedRunnerEnvelope:
    base = {
        "job_id": "job-1",
        "project_dir": str(tmp_path / "output"),
        "video_path": str(tmp_path / "output" / "source.mp4"),
    }
    base.update(payload or {})
    return TrustedRunnerEnvelope(
        {
            "task_type": task_type,
            "payload": base,
            TRUSTED_EGRESS_CONTEXT_KEY: _organization_context(task_type),
        }
    )


def _project_context(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="project-1",
        project_name="project",
        owner_type="user",
        owner_id="user-1",
        owner_username="user",
        requester_user_id="user-1",
        requester_username="user",
        requester_principals=(("user", "user-1"),),
        effective_role="editor",
        home_node_id="local",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


class _TaskManager:
    def update_progress_for_project(self, *_args, **_kwargs) -> None:
        return None


@pytest.mark.asyncio
async def test_local_ffmpeg_leaf_runs_under_an_organization_context(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """本地抽帧对组织必须放行——这条红的时候就是用户报的那个故障。

    假 leaf 刻意照抄真实签名（`jobs.py:1412` 无 `egress_context` 形参）。用带
    `egress_context` 的假 leaf 测不出这个缺陷：既有 seam 用例正是那样写的，所以
    它全绿而线上在拒人。
    """

    from novelvideo.task_backend.runners import freezone

    project_dir = tmp_path / "output"
    project_dir.mkdir(parents=True, exist_ok=True)
    frame = project_dir / "frame_001.png"
    frame.write_bytes(b"frame")
    calls: list[dict] = []

    async def extract_frames_leaf(
        *,
        project_dir,
        job_id,
        video_path,
        max_frames,
        scene_threshold,
    ):
        calls.append({"job_id": job_id, "max_frames": max_frames})
        return [frame]

    monkeypatch.setattr(freezone, "get_task_manager", lambda: _TaskManager())
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.run_freezone_extract_frames", extract_frames_leaf
    )
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.ensure_freezone_dirs", lambda *_a, **_k: None
    )
    monkeypatch.setattr(
        "novelvideo.api.deps.make_static_url_for_context",
        lambda _ctx, rel, **_k: f"/static/{rel}",
    )

    result = await freezone._run_freezone_extract_async(
        _organization_envelope(tmp_path),
        _project_context(tmp_path),
    )

    assert result["frame_count"] == 1
    assert len(calls) == 1


@pytest.mark.parametrize("leaf_shape", ["explicit", "var_keyword"])
@pytest.mark.asyncio
async def test_unclassified_leaf_is_denied_under_an_organization_context(
    tmp_path: Path,
    leaf_shape: str,
) -> None:
    """表外 leaf 照旧抛：默认 fail-closed 没有被历次改动放松（护栏 a）。

    样本刻意用一个**表里不存在的名字**直接打分发器，而不是借某个真实 leaf 的
    DENIED 分类——借真实 leaf 时，那条 leaf 一旦被接上出网上下文改判 NETWORK
    （OI-56 ① 就是），这条护栏用例会跟着失去覆盖。现在它只依赖「未分类」本身。

    两种签名形状都必须拒。`var_keyword` 那条是原判据的漏洞所在：`inspect.signature`
    把 `**kwargs` 算作「接受 context」，于是把一个未分类的出网 leaf 放行，context
    被吞进袋子里静默失效。分类判据不看签名，两条同拒。
    """

    from novelvideo.task_backend.runners.freezone import (
        FREEZONE_LEAF_EGRESS,
        _call_freezone_leaf,
    )

    leaf_calls = 0

    if leaf_shape == "explicit":

        async def unclassified_leaf(*, project_dir, job_id):
            nonlocal leaf_calls
            leaf_calls += 1
            return project_dir / "out.png"

    else:

        async def unclassified_leaf(**kwargs):
            nonlocal leaf_calls
            leaf_calls += 1
            return kwargs["project_dir"] / "out.png"

    assert "leaf_not_in_the_table" not in FREEZONE_LEAF_EGRESS

    with pytest.raises(InvalidTaskEnvelope):
        await _call_freezone_leaf(
            _organization_envelope(tmp_path),
            unclassified_leaf,
            "leaf_not_in_the_table",
            project_dir=tmp_path / "output",
            job_id="job-1",
        )

    assert leaf_calls == 0


@pytest.mark.asyncio
async def test_mask_edit_leaf_receives_the_organization_egress_context(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """图像擦除对组织必须**到达** leaf，且 leaf 手里拿到的是组织身份（OI-56 ①）。

    它真出网（`jobs.py:190` 调 `generate_reference_edit_image`），此前因没有
    `egress_context` 形参而被判 DENIED，组织下落 `_call_freezone_leaf` 兜底分支抛
    `InvalidTaskEnvelope`。「到达」不够——断言必须落到 leaf 收到的 context 上，
    否则等于复制 OI-48 那种「有形参没接住」的形状。
    """

    from novelvideo.task_backend.runners import freezone

    project_dir = tmp_path / "output"
    project_dir.mkdir(parents=True, exist_ok=True)
    out = project_dir / "freezone_mask_edit" / "job-1.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(b"png")
    seen: list[TrustedEgressContext | None] = []

    async def mask_edit_leaf(
        *,
        project_dir,
        job_id,
        base_path,
        mask_path,
        prompt,
        aspect_ratio,
        image_size,
        quality,
        provider,
        model,
        egress_context=None,
    ):
        seen.append(egress_context)
        return out

    monkeypatch.setattr(freezone, "get_task_manager", lambda: _TaskManager())
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.run_freezone_mask_edit", mask_edit_leaf
    )
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.ensure_freezone_dirs", lambda *_a, **_k: None
    )
    monkeypatch.setattr(
        "novelvideo.api.deps.make_static_url_for_context",
        lambda _ctx, rel, **_k: f"/static/{rel}",
    )

    result = await freezone._run_freezone_mask_edit_async(
        _organization_envelope(
            tmp_path,
            task_type="freezone_mask_edit",
            payload={
                "base_path": str(project_dir / "in.png"),
                "mask_path": str(project_dir / "mask.png"),
                "prompt": "prompt",
            },
        ),
        _project_context(tmp_path),
    )

    assert result["job_id"] == "job-1"
    assert len(seen) == 1
    assert seen[0] is not None and seen[0].is_organization


@pytest.mark.asyncio
async def test_analyze_shots_leaf_receives_the_organization_egress_context(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """Vision 分析对组织必须到达 leaf，且拿到组织身份（OI-56 ②）。

    它有两个入口：`freezone_analyze` 与 `freezone_video_story`，后者会先跑完
    ffmpeg 抽帧再撞上拒绝——白烧一遍算力。
    """

    from novelvideo.task_backend.runners import freezone

    project_dir = tmp_path / "output"
    out_dir = project_dir / "freezone_analyze" / "job-1"
    out_dir.mkdir(parents=True, exist_ok=True)
    analysis = out_dir / "analysis.json"
    analysis.write_text("{}", encoding="utf-8")
    seen: list[TrustedEgressContext | None] = []

    async def analyze_leaf(
        *,
        project_dir,
        job_id,
        frame_paths,
        provider,
        model,
        analysis_mode,
        duration_sec,
        egress_context=None,
    ):
        seen.append(egress_context)
        return {"output_path": str(analysis), "model": "m", "analysis_mode": "shots"}

    monkeypatch.setattr(freezone, "get_task_manager", lambda: _TaskManager())
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.run_freezone_analyze_shots", analyze_leaf
    )
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.ensure_freezone_dirs", lambda *_a, **_k: None
    )
    monkeypatch.setattr(
        "novelvideo.api.deps.make_static_url_for_context",
        lambda _ctx, rel, **_k: f"/static/{rel}",
    )

    result = await freezone._run_freezone_analyze_async(
        _organization_envelope(
            tmp_path,
            task_type="freezone_analyze",
            payload={"frame_paths": [str(project_dir / "frame_001.png")]},
        ),
        _project_context(tmp_path),
    )

    assert result["job_id"] == "job-1"
    assert len(seen) == 1
    assert seen[0] is not None and seen[0].is_organization


def test_local_table_is_exactly_the_five_audited_leaves() -> None:
    """本地表严格 5 个，不得凭「看起来像本地」扩表（护栏 b）。

    每一条都对到 EG-20a，且与 EE 计费豁免集 `feature_billing.py:389-399` 同源。
    """

    from novelvideo.task_backend.runners.freezone import (
        FREEZONE_LEAF_EGRESS,
        LeafEgress,
    )

    local = {
        name
        for name, rule in FREEZONE_LEAF_EGRESS.items()
        if rule.egress is LeafEgress.LOCAL
    }

    assert local == AUDITED_LOCAL_LEAVES
    assert all(
        FREEZONE_LEAF_EGRESS[name].eg_id == "EG-20a" for name in AUDITED_LOCAL_LEAVES
    )

    # DENIED 桶同样锁死：它不是「待办清单」，往里塞新名字等于悄悄扩大拒绝面。
    # OI-56 把最后两条（mask_edit / analyze_shots）接上出网上下文后，这个桶空了——
    # 未分类的 leaf 照旧走 `_call_freezone_leaf` 的兜底拒绝，不需要在表里挂名字。
    denied = {
        name
        for name, rule in FREEZONE_LEAF_EGRESS.items()
        if rule.egress is LeafEgress.DENIED
    }
    assert denied == set()


def test_every_rule_names_a_well_formed_atomic_eg_id() -> None:
    """`eg_id` 必须长得像清单里的原子 ID，占位串一律不许过。

    `generate_freezone_audio_eleven_music` 曾挂着 `"EG-未登记"` 活过一整轮：唯一
    断言到字面量的只有 5 个本地 leaf 的 `"EG-20a"`，别的写什么都没人管（OI-56 ③）。
    这条只做形状校验——跨仓核对 EE `egress-inventory.md` 不是单测能干的事。
    """

    import re

    from novelvideo.task_backend.runners.freezone import FREEZONE_LEAF_EGRESS

    malformed = {
        name: rule.eg_id
        for name, rule in FREEZONE_LEAF_EGRESS.items()
        if not re.fullmatch(r"EG-\d+[a-z]?", rule.eg_id)
    }
    assert not malformed, f"这些 eg_id 不是原子 ID：{malformed}"


def test_classification_matches_the_real_leaf_signatures() -> None:
    """遍历**真实** leaf 对象断言其分类自洽——用假 leaf 挡不住同类回潮。

    「声明 `egress_context`」与「判为 NETWORK」必须双向等价：NETWORK 不声明则
    分发器塞不进去（TypeError）；LOCAL／DENIED 声明了则说明它其实会出网、分类错。
    DENIED 一旦补上形参就该改判 NETWORK，这条会在那时逼人改表（OI-56 的出口）。

    `**kwargs` 一律不算数：吞进袋子里的 context 等于没传，这正是原判据
    `VAR_KEYWORD` 分支的漏洞。
    """

    from novelvideo.task_backend.runners.freezone import (
        FREEZONE_LEAF_EGRESS,
        LeafEgress,
    )

    for name, rule in sorted(FREEZONE_LEAF_EGRESS.items()):
        module = importlib.import_module(rule.module)
        leaf = getattr(module, name)
        parameters = inspect.signature(leaf).parameters
        declares_context = "egress_context" in parameters
        has_var_keyword = any(
            parameter.kind is inspect.Parameter.VAR_KEYWORD
            for parameter in parameters.values()
        )

        assert not has_var_keyword, f"{rule.module}.{name} 用 **kwargs 吞掉了分类契约"
        if rule.egress is LeafEgress.NETWORK:
            assert declares_context, f"{rule.module}.{name} 判为出网却不收 egress_context"
        else:
            assert not declares_context, (
                f"{rule.module}.{name} 判为 {rule.egress.value} 却收 egress_context"
            )


def test_every_dispatch_site_names_a_classified_leaf() -> None:
    """20 个调用点逐个对到表里；新增未分类的调用点即红。

    `leaf_name` 是必填位置参数，不是可选项——漏传是 `TypeError`，不是静默放行。
    """

    from novelvideo.task_backend.runners import freezone
    from novelvideo.task_backend.runners.freezone import FREEZONE_LEAF_EGRESS

    source = Path(inspect.getsourcefile(freezone)).read_text(encoding="utf-8")
    tree = ast.parse(source)

    named: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, ast.Name):
            continue
        if node.func.id != "_call_freezone_leaf":
            continue
        assert len(node.args) >= 3, "调用点没有显式声明 leaf_name"
        leaf_name = node.args[2]
        assert isinstance(leaf_name, ast.Constant) and isinstance(
            leaf_name.value, str
        ), "leaf_name 必须是字面量，间接取值等于没有分类"
        named.append(leaf_name.value)

    # 19 → 20：`origin/staging` 的 f33ac189（#279）带进来的
    # `generate_freezone_text`，正是上一条用例点名预言的那个形状。
    assert len(named) == 20
    assert set(named) <= set(FREEZONE_LEAF_EGRESS)


# `novelvideo.freezone.jobs` / `.text_node` 里唯二被 runner 直接调用的非 leaf：
# `ensure_freezone_dirs`（`jobs.py:358-378`，只 mkdir）与 `bind_story_script_assets`
# （`text_node.py:606-`，只回填 URL 字符串）。两个都不出网、不取凭证，逐个核过。
NON_LEAF_HELPERS = frozenset({"ensure_freezone_dirs", "bind_story_script_assets"})


def test_no_leaf_module_import_reaches_the_network_around_the_dispatcher() -> None:
    """凡从 leaf 所在模块引进来的名字，要么已分类、要么是核过的本地助手。

    上一条用例数的是**调用点**，挡不住新 leaf 干脆不走分发器：直接
    `from novelvideo.freezone.text_node import generate_freezone_text` 然后
    `await generate_freezone_text(...)`，调用点计数纹丝不动，分类表也不必改，
    而组织身份就这么绕过了闸门。`origin/staging` 的 `f33ac189`
    （Freezone AI text generation, #279）正是这个形状，合并进来当天就会发生。

    判据不写死模块清单——leaf 所在模块由分类表自己的 `rule.module` 给出，表长
    出新模块，覆盖面自动跟上。
    """

    from novelvideo.task_backend.runners import freezone
    from novelvideo.task_backend.runners.freezone import FREEZONE_LEAF_EGRESS

    leaf_modules = {rule.module for rule in FREEZONE_LEAF_EGRESS.values()}
    tree = ast.parse(Path(inspect.getsourcefile(freezone)).read_text(encoding="utf-8"))

    imported: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module in leaf_modules:
            for alias in node.names:
                imported[alias.asname or alias.name] = node.module

    unclassified = {
        name: module
        for name, module in imported.items()
        if name not in FREEZONE_LEAF_EGRESS and name not in NON_LEAF_HELPERS
    }
    assert not unclassified, (
        f"这些名字来自 leaf 模块却没有分类，组织身份到不了它们的出网点：{unclassified}"
    )

    # 已分类的 leaf 只许作为 `_call_freezone_leaf` 的实参出现，不许被直接调用。
    called_directly = sorted(
        {
            node.func.id
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in FREEZONE_LEAF_EGRESS
        }
    )
    assert not called_directly, f"这些 leaf 绕过了分发器：{called_directly}"


def test_organization_identity_reaches_the_image_egress_gate_through_the_scope() -> None:
    """`convert_control_frame_to_sketch` 判为 NETWORK 的依据，必须由用例证实。

    它补了 `egress_context` 形参，但**不**继续穿进 `generate_grid`——那是 39 个
    参数的方法且无该形参，穿进去等于对整条内部链路做 OI-48 式扫荡（护栏 c）。
    不需要穿：OI-48 已在 `run_core.py:695` 对所有 runner 派发做了中心绑定，而
    `nanobanana_grid.py:128-137` 的组织闸门在显式参数为 None 时读作用域。这条钉
    住那个前提；它若红，说明「不穿参数」的收窄不成立，得回头做显式下传。
    """

    import asyncio

    from novelvideo.generators.nanobanana_grid import (
        _prepare_organization_image_egress,
    )
    from novelvideo.model_gateway_runtime import model_gateway_scope_for_runner
    from novelvideo.ports.egress import EgressError

    envelope = TrustedRunnerEnvelope(
        {
            "task_type": "mainline_director_control_sketch",
            "payload": {},
            TRUSTED_EGRESS_CONTEXT_KEY: _organization_context(
                "mainline_director_control_sketch"
            ),
        }
    )

    async def probe() -> None:
        await _prepare_organization_image_egress(
            egress_context=None,
            provider="openai",
            capability="image.director.control_sketch",
            request={"beat": 1},
        )

    with model_gateway_scope_for_runner(envelope):
        with pytest.raises(EgressError) as excinfo:
            asyncio.run(probe())

    assert excinfo.value.code == "ORG_EGRESS_DENIED"
