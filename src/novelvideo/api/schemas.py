"""API 请求/响应 Pydantic 模型。"""

from typing import Any, Literal, Optional

from fastapi import HTTPException
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator

from novelvideo.models import SceneRef
from novelvideo.freezone.slots import PushTarget

ProjectStatus = Literal["active", "archived", "deleted"]
ProjectStatusFilter = Literal["all", "active", "archived", "deleted", "visible"]
FREEZONE_DEFAULT_IMAGE_SELECTION = "newapi_gpt_image2"
FREEZONE_DEFAULT_IMAGE_MODEL = FREEZONE_DEFAULT_IMAGE_SELECTION
CANVAS_MAX_NODES = 50_000
CANVAS_MAX_EDGES = 200_000


# ── 通用响应 ──────────────────────────────────────────────────────────────────


class OkResponse(BaseModel):
    ok: bool = True
    data: Any = None


class TaskResponse(BaseModel):
    ok: bool = True
    task_id: str = ""
    task_type: str = ""
    message: str = ""


class ErrorResponse(BaseModel):
    ok: bool = False
    error: str = ""


# ── 项目 ──────────────────────────────────────────────────────────────────────


class ProjectCreate(BaseModel):
    name: str


class ProjectSummary(BaseModel):
    id: str = ""
    name: str
    owner_type: str = "user"
    owner_id: str = ""
    owner_username: str = ""
    effective_role: str = ""
    home_node_id: str = ""
    status: ProjectStatus
    archived_at: Optional[str] = None
    deleted_at: Optional[str] = None
    purged_at: Optional[str] = None
    updated_at: Optional[str] = None
    episode_count: Optional[int] = None
    beat_count: Optional[int] = None


class ProjectGrantCreate(BaseModel):
    principal_type: Literal["user", "team"] = "user"
    principal_id: Optional[str] = None
    principal_username: Optional[str] = None
    role: Literal["viewer", "editor", "admin"]


class ProjectGrantUpdate(BaseModel):
    role: Literal["viewer", "editor", "admin"]


class ProjectGrantSummary(BaseModel):
    id: str
    project_id: str
    principal_type: str
    principal_id: str
    principal_username: Optional[str] = None
    role: str
    created_at: Optional[str] = None


class ProjectUpdate(BaseModel):
    spine_template: Optional[Literal["drama", "narrated"]] = None
    aspect_ratio: Optional[Literal["2:3", "9:16", "16:9"]] = None
    visual_style: Optional[str] = None
    narration_style: Optional[str] = None
    ethnicity: Optional[str] = None
    rhythm: Optional[str] = None
    tts_provider: Optional[str] = None
    tts_model: Optional[str] = None
    tts_voice: Optional[str] = None
    grid_mode: Optional[str] = None
    grid_model: Optional[str] = None
    video_backend: Optional[str] = None
    use_director_render: Optional[bool] = None
    video_resolution: Optional[str] = None
    add_subtitles: Optional[bool] = None
    sketch_image_selection: Optional[str] = None
    render_image_selection: Optional[str] = None
    sketch_aspect_padding: Optional[bool] = None


class RenderSettingsUpdate(BaseModel):
    render_image_selection: Optional[str] = None
    sketch_aspect_padding: Optional[bool] = None


class SketchSettingsUpdate(BaseModel):
    sketch_image_selection: Optional[str] = None


class BeatBackgroundAnchorUpdate(BaseModel):
    anchor_id: str


# ── 导入 ──────────────────────────────────────────────────────────────────────


class IngestStart(BaseModel):
    filename: str
    rebuild: bool = False
    spine_template: Optional[Literal["drama", "narrated"]] = None


# ── 角色 ──────────────────────────────────────────────────────────────────────


class PortraitGenRequest(BaseModel):
    style: Optional[str] = None
    ethnicity: str = "Chinese"
    model: Optional[str] = None


# ── 分集 ──────────────────────────────────────────────────────────────────────


class EpisodePlanRequest(BaseModel):
    target_episodes: int = 10
    planning_mode: str = "chapters"


# ── 剧本 ──────────────────────────────────────────────────────────────────────


class ContentUpdateRequest(BaseModel):
    content: str


class RewriteGenerateRequest(BaseModel):
    target_beats: int = 18
    beat_chars_min: int = 14
    beat_chars_max: int = 20
    narration_style: Optional[str] = None


class ScriptGenerateRequest(BaseModel):
    pass


class BeatUpdate(BaseModel):
    narration_segment: Optional[str] = None
    visual_description: Optional[str] = None
    scene_ref: Optional[SceneRef] = None
    time_of_day: Optional[str] = None
    video_prompt: Optional[str] = None
    keyframe_prompt: Optional[str] = None
    video_mode: Optional[str] = None  # "first_frame" | "keyframe"
    seedance2_config_json: Optional[str] = None
    audio_type: Optional[str] = None  # "silence" | "narration" | "dialogue"
    speaker: Optional[str] = None  # 说话人身份ID（dialogue 时必填）
    detected_identities: Optional[list[str]] = None
    detected_props: Optional[list[str]] = None


class Seedance2PromptGenerateRequest(BaseModel):
    manual_prompt_reference: Optional[str] = None
    prompt_guidance: Optional[str] = None


class BeatVideoPromptGenerateRequest(BaseModel):
    language: str = "zh"


class Seedance2AssetDeleteRequest(BaseModel):
    media_kind: Literal["images", "audios"]
    path: str


class Seedance2AssetCropRequest(BaseModel):
    asset_key: str
    source_path: str
    target: Literal["reference_image", "first_frame", "last_frame"] = "reference_image"
    x: float = 0
    y: float = 0
    width: float
    height: float


class Seedance2AssetAudioTrimRequest(BaseModel):
    asset_key: str
    source_path: str
    start_seconds: float = 0
    duration_seconds: float = 4


# ── 图片池选择 ────────────────────────────────────────────────────────────────


class PoolSelectRequest(BaseModel):
    pool_id: str
    force: bool = False


class VideoPoolSelectRequest(BaseModel):
    pool_id: str


class GlobalOptimizeRequest(BaseModel):
    language: str = "en"  # "zh" 中文 / "en" SuperPower英文(Gemini)


class VideoGenerateRequest(BaseModel):
    resolution: str = "720x1280"
    video_backend: str = "newapi_seedance-1.0-pro-fast"
    use_director_render: bool = False


class VideoBackendOption(BaseModel):
    value: str
    label: str
    is_default: bool = False
    is_seedance2: bool = False
    is_happyhorse: bool = False
    is_grok_video: bool = False
    dialogue_only: bool = False
    min_duration: Optional[int] = None
    max_duration: Optional[int] = None
    resolution_options: Optional[list[str]] = None
    ratio_options: Optional[list[str]] = None
    supported_modes: Optional[list[str]] = None
    reference_image_max: Optional[int] = None
    reference_video_max: Optional[int] = None
    reference_audio_max: Optional[int] = None


class VideoComposeRequest(BaseModel):
    add_subtitles: bool = True
    add_bgm: bool = False
    resolution: str = "720x1280"


# ── TTS ───────────────────────────────────────────────────────────────────────


class TTSGenerateRequest(BaseModel):
    provider: Optional[str] = None
    voice: Optional[str] = None
    model: Optional[str] = None
    rate: Optional[str] = None
    mode: Optional[str] = None
    beat_numbers: Optional[list[int]] = None


class TTSPreviewRequest(BaseModel):
    text: str
    provider: Optional[str] = None
    voice: Optional[str] = None
    model: Optional[str] = None


# ── 草图 & 首帧 ──────────────────────────────────────────────────────────────


class SketchGenerateRequest(BaseModel):
    style: Optional[str] = None
    model: str = "nanobanana"
    grid_index: int = 0
    sketch_scene_grouping: bool = True
    aspect_ratio: Literal["2:3", "16:9"] = "2:3"
    image_generation_selection: Optional[str] = None


# ── 再生 ──────────────────────────────────────────────────────────────────────


class GridRegenerateRequest(BaseModel):
    style: Optional[str] = None
    model: str = "nanobanana"
    scene_grouping: bool = False
    character_grouping: bool = False
    image_generation_selection: Optional[str] = None
    sketch_aspect_padding: Optional[bool] = None


class BeatsRegenerateRequest(BaseModel):
    beat_indices: list[int]
    style: Optional[str] = None
    model: str = "nanobanana"
    mode_key: str = "1x1_2-3"
    image_generation_selection: Optional[str] = None
    sketch_aspect_padding: Optional[bool] = None


class SketchRegenerateRequest(BaseModel):
    beat_indices: list[int]
    style: Optional[str] = None
    model: str = "nanobanana"
    mode_key: str = "1x1_2-3"
    image_generation_selection: Optional[str] = None


class SketchRegenQueueItem(BaseModel):
    id: str
    modeKey: str
    modeLabel: str
    beatNumbers: list[int] = Field(default_factory=list)
    sceneIds: list[str] = Field(default_factory=list)
    createdAt: str
    taskScope: Optional[str] = None


class SketchRegenQueueUpdate(BaseModel):
    items: list[SketchRegenQueueItem] = Field(default_factory=list)


class OperatorPasswordVerifyRequest(BaseModel):
    password: str = ""


class InsertManualShotRequest(BaseModel):
    # None means insert before the first beat. Otherwise insert after this beat_number.
    after_beat_number: Optional[int] = None
    visual_description: str
    duration_seconds: Optional[float] = None
    scene_ref: Optional[SceneRef] = None
    time_of_day: Optional[str] = None
    detected_identities: Optional[list[str]] = None
    detected_props: Optional[list[str]] = None
    audio_type: Literal["silence", "narration", "dialogue"] = "silence"
    speaker: Optional[str] = None
    narration_segment: Optional[str] = None


class SingleVideoRequest(BaseModel):
    resolution: str = "720x1280"
    video_backend: str = "newapi_seedance-1.0-pro-fast"
    use_director_render: bool = False
    seedance2_config_json: Optional[str] = None
    mode: Optional[str] = None
    duration: Optional[int] = None
    ratio: Optional[str] = None
    generate_audio: Optional[bool] = None
    return_last_frame: Optional[bool] = None
    human_review: Optional[bool] = None
    scene_optimize: Optional[str] = None
    final_prompt: Optional[str] = None
    audio_setting: Optional[str] = None
    prompt_guidance: Optional[str] = None
    text_overlay: Optional[dict[str, Any]] = None


# ── 风格 ──────────────────────────────────────────────────────────────────────


class StyleCreateRequest(BaseModel):
    id: str
    name: str
    label: str
    config: dict


# ── 剧集编辑 ─────────────────────────────────────────────────────────────────


class EpisodeUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    title: Optional[str] = None
    content_summary: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("summary", "content_summary"),
        serialization_alias="summary",
    )
    character_names: Optional[list[str]] = None
    key_events: Optional[list[str]] = None
    cliffhanger: Optional[str] = None
    identity_ids: Optional[list[str]] = None
    beat_source_text: Optional[str] = None
    identity_default_map: Optional[dict[str, str]] = None


# ── 角色编辑 ─────────────────────────────────────────────────────────────────


class CharacterCreate(BaseModel):
    name: str
    role: str = ""
    is_main: bool = False
    gender: str = ""
    age_group: str = "youth"
    description: str = ""
    face_prompt: str = ""


# ── Freezone ─────────────────────────────────────────────────────────────────


class FreezoneImageCameraConfig(BaseModel):
    """图片节点摄像机参数。"""

    camera_body: str = Field(default="", description="相机机身，例如 Panavision DXL2")
    lens: str = Field(default="", description="镜头型号，例如 Arri Signature Prime")
    focal_length_mm: Optional[int] = Field(
        default=None,
        description="焦距，单位 mm，例如 35",
    )
    aperture: str = Field(default="", description="光圈，例如 f/4")


class FreezoneImageStyleConfig(BaseModel):
    """图片节点风格模板参数。"""

    template_id: str = Field(description="风格模板 id")


class FreezoneGenRequest(BaseModel):
    prompt: str
    aspect_ratio: str = "1:1"
    image_size: str = "2K"
    reference_urls: list[str] = Field(default_factory=list)
    canvas_id: str = Field(
        default="",
        description="可选来源画布 id。用于后端按节点记录生成历史；为空时不记录节点历史。",
    )
    node_id: str = Field(
        default="",
        description="可选来源节点 id。用于后端按节点记录生成历史；为空时不记录节点历史。",
    )
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="可选摄像机参数，用于把机身 / 镜头 / 焦距 / 光圈注入图片提示词",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="可选风格模板参数，用于把内置风格模板注入图片提示词",
    )
    provider: Optional[str] = None
    model: Optional[str] = None
    quality: Optional[str] = Field(default="medium", description="图片画质档位，默认 medium")
    model_id: Optional[str] = Field(
        default=None, description="可选：注册表模型 id，用于还原节点时回填 model"
    )
    gen_mode: Optional[str] = Field(default=None, description="可选：生成模式，用于还原节点时回填 genMode")


class FreezoneEditRequest(BaseModel):
    prompt: str
    base_url: str
    extra_reference_urls: list[str] = Field(default_factory=list)
    aspect_ratio: str = "2:3"
    image_size: str = "2K"
    canvas_id: str = Field(
        default="",
        description="可选来源画布 id。用于后端按节点记录生成历史；为空时不记录节点历史。",
    )
    node_id: str = Field(
        default="",
        description="可选来源节点 id。用于后端按节点记录生成历史；为空时不记录节点历史。",
    )
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="可选摄像机参数，用于把机身 / 镜头 / 焦距 / 光圈注入图片提示词",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="可选风格模板参数，用于把内置风格模板注入图片提示词",
    )
    provider: Optional[str] = None
    model: Optional[str] = None
    quality: Optional[str] = Field(default="medium", description="图片画质档位，默认 medium")
    model_id: Optional[str] = Field(
        default=None, description="可选：注册表模型 id，用于还原节点时回填 model"
    )
    gen_mode: Optional[str] = Field(default=None, description="可选：生成模式，用于还原节点时回填 genMode")


class FreezoneSketchFromContextRequest(BaseModel):
    episode: int
    beat: int
    aspect_ratio: Literal["2:3", "16:9"] = "2:3"
    source_kind: Literal[
        "beat",
        "selected_background",
        "director_combined",
        "background_candidate",
    ] = "beat"
    source_url: Optional[str] = None
    canvas_id: str = Field(default="")
    node_id: str = Field(default="")
    provider: Optional[str] = None
    model: Optional[str] = None
    quality: Optional[str] = Field(default="medium", description="图片画质档位，默认 medium")


class FreezoneFrameFromContextRequest(BaseModel):
    episode: int
    beat: int
    aspect_ratio: Literal["2:3", "16:9"] = "2:3"
    sketch_url: str
    background_url: Optional[str] = None
    identity_urls: list[str] = Field(default_factory=list)
    prop_urls: list[str] = Field(default_factory=list)
    canvas_id: str = Field(default="")
    node_id: str = Field(default="")
    provider: Optional[str] = None
    model: Optional[str] = None
    quality: Literal["low", "medium", "high"] = Field(
        default="medium",
        description="图片画质档位，默认 medium",
    )


class FreezoneScene360Request(BaseModel):
    """场景 360 全景生成请求。

    约定只接收一张场景源图 `master.png` 作为参考输入。
    """

    reference_url: str = Field(
        description="场景源图静态地址，通常指向 assets/scenes/<scene_id>/master.png"
    )
    reverse_reference_url: Optional[str] = Field(
        default=None,
        description=("可选反向场景源图静态地址，通常指向 assets/scenes/<scene_id>/reverse.png"),
    )
    canvas_id: str = Field(default="")
    node_id: str = Field(default="")
    image_size: str = Field(default="2K", description="输出分辨率档位，默认 2K")
    mode: Literal["candidate", "commit"] = Field(
        default="candidate",
        description="candidate 只生成画布候选；commit 明确写回主线 360 slot",
    )
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"图片模型名，默认 {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    quality: Optional[str] = Field(default="medium", description="图片画质档位，默认 medium")


class FreezoneImageTo3GSRequest(BaseModel):
    """从 Freezone 图片节点启动 SHARP，生成压缩 3GS SOG。"""

    source_url: str = Field(description="源图静态地址，通常来自 Freezone 图片节点")
    source_kind: Literal["master", "reverse", "pano"] = Field(
        default="master",
        description=("3GS 来源类型；master/reverse 生成单面 SOG，pano 使用 360 全景生成 pano SOG"),
    )
    canvas_id: str = Field(default="", description="可选：来源画布 id，用于记录节点生成历史")
    node_id: str = Field(default="", description="可选：来源节点 id，用于记录节点生成历史")


class FreezoneThreeDViewerScreenshotRequest(BaseModel):
    """保存 Freezone 内置 3D viewer 的普通截图。"""

    data_url: str = Field(description="canvas.toDataURL('image/png') 得到的 data URL")
    node_id: Optional[str] = Field(default=None, description="来源 3D 世界节点 id")
    label: Optional[str] = Field(default=None, description="可选显示名")


class ViewerBeatContextManifest(BaseModel):
    episode: int
    beat: int
    visual_description: Optional[str] = None
    detected_identities: list[str] = Field(default_factory=list)
    detected_props: list[str] = Field(default_factory=list)


class PanoViewerSource(BaseModel):
    slot_kind: Literal["scene_director_pano_360", "scene_360_candidate"] = "scene_director_pano_360"
    url: str
    fs: Optional[str] = None


class PanoSphereCorrection(BaseModel):
    roll: float = 0.0
    pitch: float = 0.0
    yaw: float = 0.0


class PanoViewerCorrection(BaseModel):
    front_yaw_deg: float = 0.0
    sphere_correction_deg: PanoSphereCorrection = Field(default_factory=PanoSphereCorrection)


class PanoViewerManifest(BaseModel):
    viewer_kind: Literal["pano360"] = "pano360"
    mode: Literal["scene", "beat"]
    project: str
    scene_id: str
    display_name: str
    source: PanoViewerSource
    correction: PanoViewerCorrection = Field(default_factory=PanoViewerCorrection)
    beat_context: Optional[ViewerBeatContextManifest] = None
    allowed_destinations: list[
        Literal["view", "download", "canvas_screenshot_node", "beat_selected_background"]
    ] = Field(default_factory=list)


class DirectorStageSource(BaseModel):
    source_type: Literal["sog", "pano360"] = "sog"
    ply_url: str
    splat_url: str
    splat_format: Literal["ply", "sog", "splat", "ksplat", "unknown"] = "unknown"
    pano_url: Optional[str] = None
    slot_kind: Optional[Literal["scene_director_pano_360", "scene_360_candidate"]] = None
    collision_glb_url: Optional[str] = None
    source_kind: Literal["master", "reverse", "pano", "uploaded", "custom"] = "custom"


class DirectorStageSourceOption(BaseModel):
    kind: Literal["active", "master", "reverse", "pano", "uploaded", "custom"]
    label: str
    source_type: Literal["sog", "pano360"] = "sog"
    ply_url: Optional[str] = None
    splat_url: Optional[str] = None
    splat_format: Literal["ply", "sog", "splat", "ksplat", "unknown"] = "unknown"
    pano_url: Optional[str] = None
    slot_kind: Optional[Literal["scene_director_pano_360", "scene_360_candidate"]] = None
    fs: Optional[str] = None
    current: bool = False


class DirectorPaletteActor(BaseModel):
    identity_id: str
    label: str
    color: str


class DirectorPaletteProp(BaseModel):
    prop_id: str
    label: str
    color: str


class DirectorStagePalette(BaseModel):
    actors: list[DirectorPaletteActor] = Field(default_factory=list)
    props: list[DirectorPaletteProp] = Field(default_factory=list)
    anonymous_colors: list[str] = Field(default_factory=list)
    anonymous_prop_colors: list[str] = Field(default_factory=list)


class DirectorStageManifest(BaseModel):
    viewer_kind: Literal["three_d_director"] = "three_d_director"
    mode: Literal["scene", "beat"]
    project: str
    scene_id: str
    display_name: str
    active_source_id: Optional[str] = None
    scene: Optional[dict[str, Any]] = None
    scenes_by_source_id: dict[str, dict[str, Any]] = Field(default_factory=dict)
    source: DirectorStageSource
    source_options: list[DirectorStageSourceOption] = Field(default_factory=list)
    source_orientation_mode: Literal["supersplat_auto", "identity", "lcc_legacy", "flip_z"] = (
        "supersplat_auto"
    )
    blockings_dir_fs: Optional[str] = None
    control_frames_dir_fs: Optional[str] = None
    slate_beat: Optional[int] = None
    beat_context: Optional[ViewerBeatContextManifest] = None
    palette: DirectorStagePalette = Field(default_factory=DirectorStagePalette)
    allowed_destinations: list[
        Literal[
            "view",
            "download",
            "canvas_screenshot_node",
            "beat_director_combined",
            "beat_director_env_only",
            "beat_selected_background",
        ]
    ] = Field(default_factory=list)


class FreezoneCharacterMultiViewRequest(BaseModel):
    """多角度编辑器请求。

    基于一张源图做机位重定位或视角重构，输出单张结果图。
    """

    source_url: str = Field(description="源图静态地址，作为图生图的 base 图")
    preset: Literal[
        "custom",
        "fisheye",
        "oblique",
        "front",
        "front_up",
        "full_body",
        "back",
    ] = Field(default="custom", description="视角预设。custom 表示完全按 yaw/pitch 自定义")
    yaw_degrees: float = Field(
        default=0.0, description="水平旋转角度，单位为度；正负方向由前端约定"
    )
    pitch_degrees: float = Field(
        default=0.0, description="垂直俯仰角度，单位为度；正负方向由前端约定"
    )
    shot_size: Literal[
        "extreme_close_up",
        "close_up",
        "medium_close",
        "medium",
        "full_body",
        "wide",
        "extreme_wide",
    ] = Field(
        default="medium",
        description="景别档位：大特写 / 特写 / 近景 / 中景 / 全身 / 远景 / 大远景",
    )
    prompt: str = Field(default="", description="用户补充提示词，可为空")
    image_size: str = Field(default="2K", description="输出分辨率档位，默认 2K")
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="可选摄像机参数，用于补充镜头语言和摄影机规格",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="可选风格模板参数，用于把内置风格模板注入图片提示词",
    )
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"图片模型名，默认 {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    quality: Optional[str] = Field(default="medium", description="图片画质档位，默认 medium")


class FreezoneTemplateEditRequest(BaseModel):
    """九宫格下拉能力统一请求。

    本质上都是基于一张源图，叠加不同的提示词模板后走同一条图编辑链路。
    """

    source_url: str = Field(description="源图静态地址，作为图生图的 base 图")
    mode: Literal[
        "multi_camera_nine_grid",
        "story_pitch_four_grid",
        "character_face_three_view",
        "product_three_view",
        "storyboard_25_grid",
        "cinematic_light_correction",
        "character_three_view_generation",
        "image_projection_after_3s",
        "image_projection_before_5s",
    ] = Field(
        description=(
            "模板模式。分别对应：多机位九宫格 / 剧情推演四宫格 / 角色脸部三视图 / "
            "产品三视图 / 25宫格连贯分镜 / 电影级光影校正 / 角色三视图生成 / "
            "画面推演-3秒后 / 画面推演-5秒前"
        )
    )
    prompt: str = Field(default="", description="用户补充提示词，可为空")
    image_size: str = Field(default="2K", description="输出分辨率档位，默认 2K")
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="可选摄像机参数，用于补充镜头语言和摄影机规格",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="可选风格模板参数，用于把内置风格模板注入图片提示词",
    )
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"图片模型名，默认 {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    quality: Optional[str] = Field(default="medium", description="图片画质档位，默认 medium")


class FreezoneExtractFramesRequest(BaseModel):
    video_url: str
    max_frames: int = 20
    scene_threshold: float = 0.3


class FreezoneAnalyzeShotsRequest(BaseModel):
    frame_urls: list[str]
    provider: Optional[str] = None
    model: Optional[str] = None
    analysis_mode: Literal["shots", "video_story"] = "shots"
    duration_sec: Optional[float] = None


class FreezoneAnalyzeVideoStoryRequest(BaseModel):
    video_url: str = Field(
        description=("视频静态地址。必须是当前项目下真实存在的 /static/... 视频 URL"),
        examples=["/static/admin/58/freezone/_uploads/example.mp4"],
    )
    max_frames: int = Field(
        default=20,
        ge=3,
        le=50,
        description=("最多抽取多少张关键帧。建议 12-20；" "越多分析越细，但耗时和 token 成本更高"),
    )
    scene_threshold: float = Field(
        default=0.3,
        ge=0.0,
        le=1.0,
        description=(
            "ffmpeg 场景切换阈值，范围 0-1。越低越容易抽到帧；"
            "长镜头/剧情片建议 0.2-0.3，快剪视频建议 0.4-0.5"
        ),
    )
    duration_sec: Optional[float] = Field(
        default=None,
        gt=0,
        description=(
            "视频总时长，单位秒。可选；" "传入后视频故事表的 start_time/end_time 会更准确"
        ),
        examples=[15],
    )


class FreezoneUpscaleRequest(BaseModel):
    """高清放大请求。

    使用图片模型 + 提示词方式做高清放大与修复。
    """

    source_url: str = Field(description="待高清放大的源图静态地址")
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"图片模型名，默认 {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    quality: Optional[str] = Field(default="medium", description="图片画质档位，默认 medium")
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="可选摄像机参数，用于补充镜头语言和摄影机规格",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="可选风格模板参数，用于把内置风格模板注入图片提示词",
    )
    scale_factor: Literal[2, 4, 6] = Field(
        default=2,
        description="放大倍数，可选 2 / 4 / 6",
    )
    image_size: str = Field(default="2K", description="输出分辨率档位，默认 2K")


class FreezoneOutpaintRequest(BaseModel):
    """扩图请求。

    基于一张源图向外补画，保留中心主体和原始构图。
    """

    source_url: str = Field(description="待扩图的源图静态地址，作为图生图的 base 图")
    target_aspect_ratio: Literal["original", "1:1", "4:3", "3:4", "16:9", "9:16"] = Field(
        default="original",
        description="目标比例。original 表示保持原图比例，其余值表示扩展到指定比例",
    )
    num_images: int = Field(
        default=1,
        ge=1,
        le=4,
        description="目标生成图片数量。当前后端单次任务只支持 1 张，预留该字段用于前端协议对齐",
    )
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="可选摄像机参数，用于补充镜头语言和摄影机规格",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="可选风格模板参数，用于把内置风格模板注入图片提示词",
    )
    image_size: str = Field(default="2K", description="输出分辨率档位，默认 2K")
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"图片模型名，默认 {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    quality: Optional[str] = Field(default="medium", description="图片画质档位，默认 medium")


class FreezoneRedrawRequest(BaseModel):
    """重绘请求。

    统一承接整体重绘和局部擦除：
    - 不传 mask_url：整体/局部自由重绘
    - 传 mask_url：仅在 mask 透明区域内按 prompt 执行局部编辑
    """

    source_url: str = Field(description="待重绘的源图静态地址，作为图生图的 base 图")
    mask_url: Optional[str] = Field(
        default=None,
        description="可选的遮罩图静态地址。传入后表示走局部擦除/局部重绘模式",
    )
    aspect_ratio: Literal["original", "1:1", "4:3", "3:4", "16:9", "9:16"] = Field(
        default="original",
        description="目标比例。original 表示保持原图比例，其余值表示按指定比例重绘",
    )
    num_images: int = Field(
        default=1,
        ge=1,
        le=4,
        description="目标生成图片数量。当前后端单次任务只支持 1 张，预留该字段用于前端协议对齐",
    )
    prompt: str = Field(default="", description="重绘要求或补充提示词")
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="可选摄像机参数，用于补充镜头语言和摄影机规格",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="可选风格模板参数，用于把内置风格模板注入图片提示词",
    )
    image_size: str = Field(default="2K", description="输出分辨率档位，默认 2K")
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"图片模型名，默认 {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    quality: Optional[str] = Field(default="medium", description="图片画质档位，默认 medium")


class FreezoneRelightRequest(BaseModel):
    """打光参考图编辑请求。

    基于一张源图和一张打光参考图，重塑当前画面的光照氛围。
    """

    source_url: str = Field(description="待打光的源图静态地址，作为图生图的 base 图")
    lighting_reference_url: Optional[str] = Field(
        default=None,
        description="打光参考图静态地址，用于提供光照方向、强弱和氛围参考",
    )
    scope: Literal["global", "local"] = Field(
        default="global",
        description="打光作用范围：global 表示整体打光，local 表示局部打光",
    )
    smart_mode: bool = Field(default=True, description="是否启用智能模式")
    brightness: int = Field(default=50, ge=0, le=100, description="亮度强度，0-100")
    color_hex: str = Field(
        default="#ffffff",
        description="用于控制主光源颜色或整体画面色调的十六进制色值，例如 #ffffff",
    )
    color_temperature_kelvin: Optional[int] = Field(
        default=None,
        ge=1500,
        le=12000,
        description="主光源色温 Kelvin 值，适用于可拖动色温轴",
    )
    key_light_direction: Literal["left", "top", "right", "front", "bottom", "back"] = Field(
        default="front",
        description="主光源方向",
    )
    rim_light: bool = Field(default=False, description="是否添加轮廓光")
    prompt: str = Field(default="", description="用户补充提示词，可为空")
    image_size: str = Field(default="2K", description="输出分辨率档位，默认 2K")
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"图片模型名，默认 {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    quality: Optional[str] = Field(default="medium", description="图片画质档位，默认 medium")


class FreezoneVideoCharacterLibraryItemRequest(BaseModel):
    """视频节点角色库录入请求。

    角色图片先通过通用 upload 上传，再把静态地址登记到视频角色库。
    """

    name: str = Field(description="角色名称，用于前端角色库展示")
    image_urls: list[str] = Field(
        default_factory=list,
        description="角色参考图静态地址列表，至少一张",
    )


class FreezoneVideoGenRequest(BaseModel):
    """文生视频请求。

    运镜通过模板库和补充提示词控制；角色库通过 `character_ids` 引用已上传的人物参考图。
    """

    prompt: str = Field(description="用户输入的视频内容描述")
    camera_template_id: Optional[str] = Field(
        default=None,
        description="运镜模板 id，例如 locked_off / follow_tracking / orbit_up",
    )
    character_ids: list[str] = Field(
        default_factory=list,
        description="视频角色库条目 id 列表，用于追加角色参考图",
    )
    marks: list["FreezoneVideoMark"] = Field(
        default_factory=list,
        description="局部元素标记列表。来自前端点击图片选中的主体/物体局部区域，不是普通 tags",
    )
    aspect_ratio: Literal["auto", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"] = Field(
        default="16:9",
        description="视频比例；auto 当前回退为 16:9",
    )
    resolution: Literal["480p", "720p", "1080p"] = Field(
        default="720p",
        description="输出清晰度档位",
    )
    duration_seconds: int = Field(
        default=5,
        ge=1,
        description="视频时长，至少 1 秒；不同模型支持的时长范围可能不同",
    )
    generate_audio: bool = Field(default=False, description="是否生成原生音频")
    human_review: bool = Field(
        default=False,
        description="是否开启 HuiMeng 真人素材审核/加白流程，用于可能包含真人人脸的素材",
    )
    scene_optimize: Optional[Literal["anime", "realistic"]] = Field(
        default=None,
        description="Seedance 2.0 Value 系列的场景风格优化参数",
    )
    model: str = Field(
        default="newapi_seedance-2.0-fast",
        description="视频模型名称。请传 `/api/v1/projects/{project}/freezone/video/models` 返回值之一。",
    )
    canvas_id: str = Field(default="", description="可选：来源画布 id，用于记录节点生成历史")
    node_id: str = Field(default="", description="可选：来源节点 id，用于记录节点生成历史")
    gen_mode: Optional[str] = Field(default=None, description="可选：生成模式，用于还原节点时回填 genMode")


class FreezoneImageToVideoRequest(BaseModel):
    """图片参考视频请求。

    统一承接图生视频和图片参考视频：
    - 1 张图片：首帧图生视频
    - 2-9 张图片：多图图片参考视频
    """

    image_urls: list[str] = Field(
        default_factory=list,
        description="图片参考静态地址列表，支持 1-9 张。第一张默认作为主参考图/首帧参考图",
    )
    prompt: str = Field(default="", description="用户补充视频描述，可为空")
    camera_template_id: Optional[str] = Field(
        default=None,
        description="运镜模板 id，例如 locked_off / follow_tracking / pedestal_up",
    )
    marks: list["FreezoneVideoMark"] = Field(
        default_factory=list,
        description="局部元素标记列表。来自前端点击图片选中的主体/物体局部区域，不是普通 tags",
    )
    aspect_ratio: Literal["auto", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"] = Field(
        default="16:9",
        description="视频比例；auto 当前回退为 16:9",
    )
    resolution: Literal["480p", "720p", "1080p"] = Field(
        default="720p",
        description="输出清晰度档位",
    )
    duration_seconds: int = Field(
        default=5,
        ge=1,
        description="视频时长，至少 1 秒；不同模型支持的时长范围可能不同",
    )
    generate_audio: bool = Field(default=False, description="是否生成原生音频")
    human_review: bool = Field(
        default=False,
        description="是否开启 HuiMeng 真人素材审核/加白流程，用于可能包含真人人脸的素材",
    )
    scene_optimize: Optional[Literal["anime", "realistic"]] = Field(
        default=None,
        description="Seedance 2.0 Value 系列的场景风格优化参数",
    )
    model: str = Field(
        default="newapi_seedance-2.0-fast",
        description="视频模型或模型选项 id。请传 /freezone/video/models 返回值之一",
    )
    canvas_id: str = Field(default="", description="可选：来源画布 id，用于记录节点生成历史")
    node_id: str = Field(default="", description="可选：来源节点 id，用于记录节点生成历史")
    gen_mode: Optional[str] = Field(default=None, description="可选：生成模式，用于还原节点时回填 genMode")


class FreezoneKeyframeVideoRequest(BaseModel):
    """首尾帧视频请求。

    接受首帧 / 尾帧两个输入，至少需要提供一个。
    """

    first_frame_url: Optional[str] = Field(
        default=None,
        description="首帧参考图静态地址，可为空；与尾帧至少提供一个",
    )
    last_frame_url: Optional[str] = Field(
        default=None,
        description="尾帧参考图静态地址，可为空；与首帧至少提供一个",
    )
    prompt: str = Field(default="", description="用户补充视频描述，可为空")
    camera_template_id: Optional[str] = Field(
        default=None,
        description="运镜模板 id，例如 locked_off / follow_tracking / pedestal_up",
    )
    marks: list["FreezoneVideoMark"] = Field(
        default_factory=list,
        description="局部元素标记列表。来自前端点击图片选中的主体/物体局部区域，不是普通 tags",
    )
    aspect_ratio: Literal["auto", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"] = Field(
        default="16:9",
        description="视频比例；auto 当前回退为 16:9",
    )
    resolution: Literal["480p", "720p", "1080p"] = Field(
        default="720p",
        description="输出清晰度档位",
    )
    duration_seconds: int = Field(
        default=5,
        ge=1,
        description="视频时长，至少 1 秒；不同模型支持的时长范围可能不同",
    )
    generate_audio: bool = Field(default=False, description="是否生成原生音频")
    human_review: bool = Field(
        default=False,
        description="是否开启 HuiMeng 真人素材审核/加白流程，用于可能包含真人人脸的素材",
    )
    scene_optimize: Optional[Literal["anime", "realistic"]] = Field(
        default=None,
        description="Seedance 2.0 Value 系列的场景风格优化参数",
    )
    model: str = Field(
        default="newapi_seedance-2.0-fast",
        description="视频模型或模型选项 id。请传 /freezone/video/models 返回值之一",
    )
    canvas_id: str = Field(default="", description="可选：来源画布 id，用于记录节点生成历史")
    node_id: str = Field(default="", description="可选：来源节点 id，用于记录节点生成历史")
    gen_mode: Optional[str] = Field(default=None, description="可选：生成模式，用于还原节点时回填 genMode")


class FreezoneVideoReferenceItem(BaseModel):
    """全能参考单条素材。"""

    type: Literal["image", "video", "audio"] = Field(description="素材类型")
    url: str = Field(description="素材静态地址")
    role: str = Field(default="", description="素材角色，例如 角色参考 / 场景参考 / 配乐参考")
    label: str = Field(default="", description="前端展示标签，可为空")


class FreezoneVideoMark(BaseModel):
    """视频节点局部元素标记。"""

    label: str = Field(description="标记出的元素名称，例如 老人 / 氧气管 / 病床")
    source_url: str = Field(default="", description="标记来源图片静态地址，可为空")
    point_x: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="点击点的归一化横坐标，范围 0-1",
    )
    point_y: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="点击点的归一化纵坐标，范围 0-1",
    )
    box_x: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="局部框左上角归一化横坐标，范围 0-1",
    )
    box_y: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="局部框左上角归一化纵坐标，范围 0-1",
    )
    box_width: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="局部框归一化宽度，范围 0-1",
    )
    box_height: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="局部框归一化高度，范围 0-1",
    )
    note: str = Field(default="", description="前端补充说明，可为空")


class FreezoneMarkDetectRequest(BaseModel):
    """局部元素标记识别请求。"""

    source_url: str = Field(description="待识别图片静态地址")
    point_x: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="点击点归一化横坐标，范围 0-1"
    )
    point_y: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="点击点归一化纵坐标，范围 0-1"
    )
    box_x: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="框选左上角归一化横坐标，范围 0-1"
    )
    box_y: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="框选左上角归一化纵坐标，范围 0-1"
    )
    box_width: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="框选归一化宽度，范围 0-1"
    )
    box_height: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="框选归一化高度，范围 0-1"
    )


class FreezoneMarkDetectData(BaseModel):
    """局部元素标记识别结果。"""

    mark: FreezoneVideoMark
    provider: str
    model: str


class FreezoneMarkDetectResponse(BaseModel):
    ok: bool
    data: FreezoneMarkDetectData


class FreezoneImageReversePromptRequest(BaseModel):
    """图反推提示词请求。"""

    source_url: str = Field(description="待分析图片静态地址")
    canvas_id: str = Field(default="", description="可选：来源画布 id，用于记录节点生成历史")
    node_id: str = Field(default="", description="可选：来源节点 id，用于记录节点生成历史")


class FreezoneImageReversePromptData(BaseModel):
    """图反推提示词结果。"""

    prompt: str


class FreezoneImageReversePromptResponse(BaseModel):
    ok: bool
    data: FreezoneImageReversePromptData


class FreezoneVideoOmniGenRequest(BaseModel):
    """全能参考视频请求。

    支持文本、图像、视频、音频混合输入。
    """

    prompt: str = Field(description="用户输入的视频内容描述")
    theme: str = Field(default="", description="主题参数，用于额外补充镜头主题、风格或叙事方向")
    camera_template_id: Optional[str] = Field(
        default=None,
        description="运镜模板 id，例如 locked_off / follow_tracking / orbit_up",
    )
    references: list[FreezoneVideoReferenceItem] = Field(
        default_factory=list,
        description="混合参考素材列表。总数最多 12，图像≤9、视频≤3、音频≤3",
    )
    marks: list[FreezoneVideoMark] = Field(
        default_factory=list,
        description="局部元素标记列表。来自前端点击图片选中的主体/物体局部区域，不是普通 tags",
    )
    aspect_ratio: Literal["auto", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"] = Field(
        default="16:9",
        description="视频比例；auto 当前回退为 16:9",
    )
    resolution: Literal["480p", "720p", "1080p"] = Field(
        default="720p",
        description="输出清晰度档位",
    )
    duration_seconds: int = Field(
        default=5,
        ge=1,
        description="视频时长，至少 1 秒；不同模型支持的时长范围可能不同",
    )
    generate_audio: bool = Field(default=False, description="是否生成原生音频")
    human_review: bool = Field(
        default=False,
        description="是否开启 HuiMeng 真人素材审核/加白流程，用于可能包含真人人脸的素材",
    )
    scene_optimize: Optional[Literal["anime", "realistic"]] = Field(
        default=None,
        description="Seedance 2.0 Value 系列的场景风格优化参数",
    )
    model: str = Field(
        default="newapi_seedance-2.0-fast",
        description="视频模型或模型选项 id。请传 /freezone/video/models 返回值之一",
    )
    canvas_id: str = Field(default="", description="可选：来源画布 id，用于记录节点生成历史")
    node_id: str = Field(default="", description="可选：来源节点 id，用于记录节点生成历史")
    gen_mode: Optional[str] = Field(default=None, description="可选：生成模式，用于还原节点时回填 genMode")


class FreezoneVideoEraseRequest(BaseModel):
    """视频擦除请求。

    统一承接：
    - smart_subtitle: 智能去字幕（自动估计底部字幕框）
    - box: 框选擦除（前端传固定框）
    """

    source_url: str = Field(description="待处理视频的静态地址")
    mode: Literal["smart_subtitle", "box"] = Field(
        default="smart_subtitle",
        description="擦除模式：smart_subtitle 为智能去字幕，box 为框选擦除",
    )
    box_x: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="框选左上角 x，归一化 0-1"
    )
    box_y: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="框选左上角 y，归一化 0-1"
    )
    box_width: Optional[float] = Field(
        default=None,
        gt=0.0,
        le=1.0,
        description="框选宽度，归一化 0-1",
    )
    box_height: Optional[float] = Field(
        default=None,
        gt=0.0,
        le=1.0,
        description="框选高度，归一化 0-1",
    )


class FreezoneVideoUpscaleRequest(BaseModel):
    """视频高清请求。

    基础版使用 ffmpeg 做传统缩放、降噪和锐化，不调用 AI 超分模型。
    """

    source_url: str = Field(description="待高清处理视频的静态地址")
    resolution: Literal["1080p", "2k", "4k"] = Field(
        default="1080p",
        description="目标清晰度档位。按长边缩放：1080p=1920，2k=2560，4k=3840",
    )
    frame_interpolation: Literal["none"] = Field(
        default="none",
        description="补帧模式。基础版仅支持 none，不改变原视频帧率",
    )
    denoise_strength: Literal["none", "1x", "2x"] = Field(
        default="1x",
        description="降噪强度。none 不降噪；1x 轻度降噪；2x 中等降噪",
    )


class FreezoneAudioSeparateRequest(BaseModel):
    """音视频分离请求。

    当前仅实现轻量版：
    - 提取纯音频
    - 导出无声视频
    """

    source_url: str = Field(description="待处理视频的静态地址")
    target_episode: Optional[int] = Field(
        default=None,
        ge=1,
        description="可选：目标主线集数。提供后，任务结果会返回 beat_audio 推送目标",
    )
    target_beat: Optional[int] = Field(
        default=None,
        ge=1,
        description="可选：目标主线 beat。提供后，任务结果会返回 beat_audio 推送目标",
    )


class FreezoneAudioVoiceRef(BaseModel):
    """Freezone 音频节点声线引用。

    推荐先调用 `GET /freezone/audio/references` 获取可选声线，再把其中
    `available[]` 项目的 scope / voice_id / character_name / identity_id / slot 传回来。
    后端只信任这些标识，会重新从账号或项目数据解析真实音频文件，不使用前端传入的 path/url。
    """

    scope: Literal[
        "project_narrator",
        "user_custom",
        "character_default",
        "character_age_group",
        "identity",
        "identity_resolved",
    ] = Field(
        description=(
            "声线类型：project_narrator=项目解说人；user_custom=账号级我的音色；"
            "character_default=角色默认声线；"
            "character_age_group=角色年龄段声线；identity=身份自己的声线；"
            "identity_resolved=按身份声线→年龄段声线→角色默认声线兜底后的实际声线"
        ),
        examples=["identity_resolved"],
    )
    character_name: str = Field(
        default="",
        description="角色名。scope 为 character_* 或 identity* 时必填，需匹配项目角色名。",
        examples=["林小满"],
    )
    identity_id: str = Field(
        default="",
        description="身份 ID。scope 为 identity 或 identity_resolved 时必填。",
        examples=["林小满_青年"],
    )
    slot: str = Field(
        default="",
        description="年龄段声线槽位。scope=character_age_group 时必填，可选 child/youth/middle/elder。",
        examples=["youth"],
    )
    voice_id: str = Field(
        default="",
        description=(
            "账号级我的音色 ID。scope=user_custom 时必填，来自 "
            "GET /freezone/audio/references 的 user_voices[]/available[]，"
            "或 POST /freezone/audio/voices 的返回值。"
        ),
        examples=["fv_abc123"],
    )


class FreezoneAudioSpeechRequest(BaseModel):
    """Freezone 音频节点：文本生成语音请求。"""

    text: str = Field(
        description=("要合成的台词/旁白文本。"),
        examples=["她低声说：终于等到这一天了。"],
    )
    emotion_prompt: str = Field(
        default="",
        description=(
            "可选情绪提示词，会传给 IndexTTS2 的 emotion_prompt。为空时使用项目解说风格。"
            "示例：紧张、压低声音、带一点恐惧感。"
        ),
        examples=["紧张、压低声音、带一点恐惧感"],
    )
    voice_ref: Optional[FreezoneAudioVoiceRef] = Field(
        default=None,
        description=(
            "可选声线引用。为空时使用项目默认解说/解说主角声线；传入时后端会按 scope 和角色/身份标识"
            "重新解析账号级或项目内参考音频。"
        ),
    )
    target_episode: Optional[int] = Field(
        default=None,
        ge=1,
        description="可选：目标主线集数。提供后，任务结果会返回 beat_audio 推送目标",
    )
    target_beat: Optional[int] = Field(
        default=None,
        ge=1,
        description="可选：目标主线 beat。提供后，任务结果会返回 beat_audio 推送目标",
    )


class FreezoneAudioMusicRequest(BaseModel):
    """Freezone 音频节点：文本生成音乐请求。"""

    input: str = Field(
        description="音乐描述 prompt。",
        examples=["cinematic rain-soaked suspense music"],
    )
    model: str = Field(default="eleven-music", description="音乐模型，默认 eleven-music。")
    response_format: Literal["mp3", "opus", "pcm", "ulaw", "alaw"] = Field(
        default="mp3",
        description="音频返回格式。mp3 会自动映射为 mp3_44100_128。",
    )
    music_length_ms: int = Field(
        default=30_000,
        ge=3000,
        le=600000,
        description="生成长度，毫秒，范围 3000 到 600000。",
    )
    force_instrumental: bool = Field(
        default=True,
        description="是否强制生成纯音乐。",
    )
    respect_sections_durations: bool = Field(
        default=True,
        description="是否严格遵循分段时长。对 prompt 生成通常由模型忽略。",
    )
    output_format: str = Field(
        default="mp3_44100_128",
        description="fal 原生音频格式，例如 mp3_44100_128、opus_48000_128。",
    )


class FreezoneVideoComposeItem(BaseModel):
    item_id: str = Field(description="前端片段唯一标识")
    source_url: str = Field(description="源媒体静态地址")
    timeline_start: float = Field(default=0.0, ge=0.0, description="片段在时间线上的开始秒数")
    source_start: float = Field(default=0.0, ge=0.0, description="源媒体裁剪起始秒")
    source_end: float = Field(gt=0.0, description="源媒体裁剪结束秒，必须大于 source_start")
    volume: float = Field(default=1.0, ge=0.0, le=2.0, description="音量倍率")
    muted: bool = Field(default=False, description="是否静音")


class FreezoneVideoComposeTrack(BaseModel):
    track_id: str = Field(description="前端轨道唯一标识")
    kind: Literal["video", "audio"] = Field(description="轨道类型")
    items: list[FreezoneVideoComposeItem] = Field(default_factory=list, description="轨道片段列表")


class FreezoneVideoComposeRequest(BaseModel):
    title: str = Field(default="", description="合成任务标题，可为空")
    canvas_id: str = Field(default="", description="来源画布 id，可为空")
    resolution: Literal["720p", "1080p"] = Field(default="1080p", description="目标输出分辨率")
    fps: int = Field(default=30, ge=1, le=60, description="输出帧率")
    background_color: str = Field(default="#000000", description="补边或空隙使用的背景色")
    keep_original_audio: bool = Field(default=True, description="是否保留视频片段自带音频")
    tracks: list[FreezoneVideoComposeTrack] = Field(
        default_factory=list, description="时间线轨道列表"
    )


FreezoneVideoGenRequest.model_rebuild()
FreezoneImageToVideoRequest.model_rebuild()
FreezoneKeyframeVideoRequest.model_rebuild()
FreezoneVideoOmniGenRequest.model_rebuild()


class FreezoneTextTranslateRequest(BaseModel):
    """Freezone 文本工具：中英文互译请求。"""

    text: str = Field(description="待翻译的原始文本或提示词")
    node_type: Literal["generic", "image", "video", "audio", "text"] = Field(
        default="generic",
        description="使用场景。用于帮助翻译器按节点类型保留合适的提示词语气",
    )
    canvas_id: str = Field(default="", description="可选：来源画布 id，用于记录节点生成历史")
    node_id: str = Field(default="", description="可选：来源节点 id，用于记录节点生成历史")


class FreezoneTextTranslateData(BaseModel):
    translated_text: str
    source_language: Literal["zh", "en"]
    target_language: Literal["zh", "en"]
    node_type: Literal["generic", "image", "video", "audio", "text"]


class FreezoneTextTranslateResponse(BaseModel):
    ok: Literal[True] = True
    data: FreezoneTextTranslateData


class FreezoneStoryScriptGenerateRequest(BaseModel):
    """Freezone 文本节点：故事脚本生成请求。"""

    source_text: str = Field(
        default="",
        description="已上传剧本的文本内容。与 source_url 至少提供一个",
    )
    source_url: Optional[str] = Field(
        default=None,
        description="已上传剧本文本文件的静态 URL。与 source_text 至少提供一个",
    )
    prompt: str = Field(
        default="根据我上传的剧本生成一个完整的故事脚本",
        description="用户补充要求，会和源剧本内容一起交给模型",
    )
    model: str = Field(
        default="newapi_gemini_flash",
        description="文本模型选项 id 或展示名",
    )
    canvas_id: str = Field(default="", description="可选：来源画布 id，用于记录节点生成历史")
    node_id: str = Field(default="", description="可选：来源节点 id，用于记录节点生成历史")


class FreezoneStoryScriptRow(BaseModel):
    shot_no: int = Field(description="镜号")
    duration: int = Field(description="时长，单位秒")
    visual_description: str = Field(description="画面描述")
    character_1: str = Field(default="", description="角色1")
    character_description_1: str = Field(default="", description="角色描述1")
    character_image_1: str = Field(default="", description="角色图1，占位字段")
    reference: str = Field(default="", description="参考")
    shot: str = Field(default="", description="景别")
    character_action: str = Field(default="", description="角色动作")
    emotion: str = Field(default="", description="情绪")
    scene_tags: str = Field(default="", description="场景标签")
    lighting_mood: str = Field(default="", description="光影氛围")
    sound: str = Field(default="", description="音效")
    dialogue: str = Field(default="", description="对白")
    shot_prompt: str = Field(default="", description="分镜提示词")
    video_motion_prompt: str = Field(default="", description="视频运动提示词")


class FreezoneStoryScriptGenerateData(BaseModel):
    title: str = Field(default="", description="故事脚本标题")
    rows: list[FreezoneStoryScriptRow] = Field(default_factory=list, description="结构化故事脚本行")


class FreezoneStoryScriptGenerateResponse(BaseModel):
    ok: Literal[True] = True
    data: FreezoneStoryScriptGenerateData


class FreezoneJobAcceptedData(BaseModel):
    task_type: str
    job_id: str
    task_key: str


class FreezoneJobAcceptedResponse(BaseModel):
    ok: Literal[True] = True
    data: FreezoneJobAcceptedData


class FreezoneStageAssetAcceptedData(BaseModel):
    task_type: str
    job_id: str
    task_key: str
    scope: str
    scene_id: str
    step: str


class FreezoneStageAssetAcceptedResponse(BaseModel):
    ok: Literal[True] = True
    data: FreezoneStageAssetAcceptedData


class CanvasPayload(BaseModel):
    schema_version: Optional[Literal[2]] = None
    canvas_id: Optional[str] = None
    project_id: Optional[str] = None
    canvas_scope: Optional[Literal["default", "episode", "beat", "asset"]] = None
    owner_principal_type: Optional[Literal["user", "team"]] = None
    owner_principal_id: Optional[str] = None
    access_model: Optional[Literal["project_role"]] = None
    min_project_role: Optional[Literal["viewer", "editor", "admin"]] = None
    episode: Optional[int] = None
    beat: Optional[int] = None
    asset_target: Optional[dict] = None
    revision: Optional[int] = None
    base_revision: Optional[int] = None
    created_by: Optional[str] = None
    updated_by: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    client_save_id: Optional[str] = None
    save_source: Literal[
        "autosave",
        "manual_save",
        "manual_clear",
        "restore",
        "from_preset",
        "projection_remove",
        "import",
    ] = "autosave"
    allow_empty_overwrite: bool = False
    nodes: list[dict] = Field(default_factory=list)
    edges: list[dict] = Field(default_factory=list)
    viewport: Optional[dict] = None
    metadata: Optional[dict] = None

    @model_validator(mode="after")
    def _check_payload_size(self) -> "CanvasPayload":
        # Raise HTTPException directly so the response carries a stable,
        # machine-readable code instead of Pydantic's default
        # "List should have at most N items" message (which echoes the
        # entire offending list and is unparseable client-side).
        if len(self.nodes) > CANVAS_MAX_NODES:
            raise HTTPException(
                422,
                {
                    "code": "canvas_payload_too_large",
                    "field": "nodes",
                    "limit": CANVAS_MAX_NODES,
                    "got": len(self.nodes),
                },
            )
        if len(self.edges) > CANVAS_MAX_EDGES:
            raise HTTPException(
                422,
                {
                    "code": "canvas_payload_too_large",
                    "field": "edges",
                    "limit": CANVAS_MAX_EDGES,
                    "got": len(self.edges),
                },
            )
        return self


class PresetCanvasRequest(BaseModel):
    """Stateless factory input for a project-scoped preset canvas."""

    scope: Literal["episode", "beat", "asset", "blank"] = "beat"
    episode: Optional[int] = None
    beat: Optional[int] = None
    primary_slot: str = "render"
    asset_kind: Optional[str] = None
    character: Optional[str] = None
    identity_id: Optional[str] = None
    asset_id: Optional[str] = None
    canvas_id: Optional[str] = None
    overwrite_existing: bool = False
    base_revision: Optional[int] = None


class ProjectionPresetCanvasRequest(BaseModel):
    """Project one preset subgraph into an existing user canvas."""

    scope: Literal["episode", "beat", "asset", "blank"] = "beat"
    projection_key: str = Field(min_length=1, max_length=160)
    episode: Optional[int] = None
    beat: Optional[int] = None
    primary_slot: str = "render"
    asset_kind: Optional[str] = None
    character: Optional[str] = None
    identity_id: Optional[str] = None
    asset_id: Optional[str] = None
    base_revision: int
    force_refresh: bool = False


class ProjectionStatusRequest(BaseModel):
    """Check whether projected preset subgraphs are stale."""

    projection_keys: Optional[list[str]] = None


class ProjectionRemoveRequest(BaseModel):
    """Remove one projected preset subgraph from an existing user canvas."""

    projection_key: str = Field(min_length=1, max_length=160)
    base_revision: int


class PushRequest(BaseModel):
    source_url: str
    target: PushTarget = Field(discriminator="kind")
    mark_stale: bool = False


class ImpactRequest(BaseModel):
    target: PushTarget = Field(discriminator="kind")


class CreateIdentityAssetRequest(BaseModel):
    source_url: str
    character: str
    identity_name: str
    appearance_details: str = ""
    face_prompt: str = ""
    age_group: str = ""


class CharacterUpdate(BaseModel):
    name: Optional[str] = None
    face_prompt: Optional[str] = None
    description: Optional[str] = None
    gender: Optional[str] = None
    age_group: Optional[str] = None
    is_main: Optional[bool] = None
    role: Optional[str] = None  # "主角" / "配角" / "反派"
    body_type: Optional[str] = None  # "纤细高挑" / "健壮魁梧" 等
    fish_voice_id: Optional[str] = None  # Fish Audio S2 声线 ID
    aliases: Optional[list[str]] = None


# ── 场景资产 ─────────────────────────────────────────────────────────────────


class SceneCreate(BaseModel):
    name: str
    aliases: list[str] = Field(default_factory=list)
    scene_type: str = "interior"
    base_scene_id: str = ""
    variant_id: str = ""
    time_of_day: str = ""
    environment_prompt: str = ""
    variant_prompt: str = ""
    description: str = ""
    spatial_layout_image: str = ""
    notes: str = ""


class SceneUpdate(BaseModel):
    name: Optional[str] = None
    aliases: Optional[list[str]] = None
    scene_type: Optional[str] = None
    base_scene_id: Optional[str] = None
    variant_id: Optional[str] = None
    time_of_day: Optional[str] = None
    environment_prompt: Optional[str] = None
    variant_prompt: Optional[str] = None
    description: Optional[str] = None
    spatial_layout_image: Optional[str] = None
    notes: Optional[str] = None


class ScenePanoGenerateRequest(BaseModel):
    source: Literal["master", "text"] = "master"
    style: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    image_size: Optional[str] = None
    quality: Optional[str] = None
    timeout_seconds: int = 1800


class SceneReferenceGenerateRequest(BaseModel):
    model: Optional[str] = None


# ── 道具资产 ─────────────────────────────────────────────────────────────────


class PropCreate(BaseModel):
    name: str
    aliases: list[str] = Field(default_factory=list)
    prop_type: str = "object"
    visual_prompt: str = ""
    description: str = ""
    owner: str = ""
    notes: str = ""


class PropUpdate(BaseModel):
    name: Optional[str] = None
    aliases: Optional[list[str]] = None
    prop_type: Optional[str] = None
    visual_prompt: Optional[str] = None
    description: Optional[str] = None
    owner: Optional[str] = None
    notes: Optional[str] = None


class PropReferenceGenerateRequest(BaseModel):
    style: Optional[str] = None
    model: Optional[str] = None


# ── 身份 CRUD ────────────────────────────────────────────────────────────────


class IdentityCreate(BaseModel):
    identity_name: str
    age_group: str = ""
    appearance_details: str = ""


class IdentityImageGenRequest(BaseModel):
    style: Optional[str] = None
    model: Optional[str] = None


CharacterAssetKind = Literal["portrait", "identity", "identity_costume", "identity_portrait"]


class CharacterAssetRestoreRequest(BaseModel):
    kind: CharacterAssetKind
    history_id: str
    identity_id: Optional[str] = None


class CharacterImageSelectionRequest(BaseModel):
    character_image_selection: str


class AssetImageSourceSelectionRequest(BaseModel):
    image_source_selection: str


class CharacterVoiceRecordRequest(BaseModel):
    data_url: str


class NarratorVoiceCopyRequest(BaseModel):
    source_path: str


class NarratorVoiceTrimRequest(BaseModel):
    start_seconds: float = 0.0
    duration_seconds: float = 4.0


class CharacterVoiceTrimRequest(BaseModel):
    source_path: str
    start_seconds: float = 0.0
    duration_seconds: float = 4.0


class IdentityUpdate(BaseModel):
    identity_name: Optional[str] = None
    appearance_details: Optional[str] = None
    face_prompt: Optional[str] = None
    age_group: Optional[str] = None
    body_type: Optional[str] = None
    fish_voice_id: Optional[str] = None


# ── 脚本保存 ─────────────────────────────────────────────────────────────────


class ScriptSaveRequest(BaseModel):
    beats: list[dict]


# ── 草图切割 ─────────────────────────────────────────────────────────────────


class GridCutRequest(BaseModel):
    grid_type: Literal["render", "sketch"] = "sketch"
    mode_key: str | None = None
    rows: int
    cols: int
    beat_start: int
    beat_end: int
    beat_numbers: list[int] | None = None


class GridSketchPreviewRequest(BaseModel):
    rows: int = Field(..., ge=1)
    cols: int = Field(..., ge=1)
    beat_numbers: list[int] = Field(..., min_length=1)


# ── 渲染计划 ─────────────────────────────────────────────────────────────────


class RenderPlanRequest(BaseModel):
    beat_indices: list[int] = Field(..., min_length=1)
    strategy: Literal["location", "naive"] = "naive"
    force_one_by_one: bool = False
    aspect_mode: str = Field(..., description="e.g. '9:16', '1:1', '16:9'")
    image_generation_selection: Optional[str] = None
    sketch_aspect_padding: Optional[bool] = None


class PlanEntryOut(BaseModel):
    mode_key: str
    rows: int
    cols: int
    beat_numbers: list[int]
    location: str = ""
    padding_count: int = 0
    reasons: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class RenderPlanResponse(BaseModel):
    plan: list[PlanEntryOut]
    plan_hash: str
    input_fingerprint: str
    strategy: str
    total_beats: int
    total_grids: int


class RenderPlanExecuteRequest(BaseModel):
    plan: list[PlanEntryOut]
    plan_hash: str
    input_fingerprint: str
    strategy: Literal["location", "naive"]
    aspect_mode: str
    force_one_by_one: bool = False
    custom_plan: bool = False
    beat_indices: list[int] = Field(..., min_length=1)
    image_generation_selection: Optional[str] = None
    sketch_aspect_padding: Optional[bool] = None


class RenderPlanExecuteResponse(BaseModel):
    task_type: str
    message: str
    scope: str
    resolved_grids: list[PlanEntryOut]


# ── 风格预览 ─────────────────────────────────────────────────────────────────


class StylePreviewRequest(BaseModel):
    project: Optional[str] = None
    prompt: str = "A beautiful woman standing in a garden"
    model: str = "nanobanana"
