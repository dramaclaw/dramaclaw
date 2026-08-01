"""NovelVideo 生成器模块。

包含图像生成、语音合成、视频合成等功能。
"""

from .image_generator import (
    ImageGenParams,
    ImageGenResult,
    MockImageGenerator,
    VolcengineImageGenerator,
    create_image_generator,
    generate_character_reference_unified,
    generate_identity_image_unified,
)
from .tts_generator import (
    EdgeTTSGenerator,
    MockTTSGenerator,
    RECOMMENDED_VOICES,
    TTSParams,
    TTSResult,
    VoiceInfo,
    create_tts_generator,
    get_voice_by_style,
)
from .video_composer import (
    KenBurnsEffect,
    MoviePyComposer,
    SceneAsset,
    VideoComposer,
    VideoResult,
    create_video_composer,
    adjust_video_duration,
    get_video_duration,
)
from .video_generator import (
    MockVideoGenerator,
    VideoBackend,
    VideoGenResult,
    VideoGenStatus,
    VideoGeneratorBase,
    SeedanceVideoGenerator,
    ComfyUIVideoGenerator,
    create_video_generator,
)
from .nanobanana_grid import (
    GridGenerationRequest,
    GridGenerationResult,
    NanoBananaGridGenerator,
    create_grid_generator,
    get_optimal_grid_size,
)
from .prompt_builder import (
    PromptMode,
    GridConfig,
    CharacterConfig,
    StyleConfig,
    PromptContext,
    PromptComponents,
    UnifiedPromptBuilder,
    create_prompt_context,
)
from .grid_splitter import (
    split_grid,
    split_grid_with_padding,
    detect_grid_layout,
    resize_frames_to_portrait,
    combine_to_grid,
)

__all__ = [
    # Image Generator
    "ImageGenParams",
    "ImageGenResult",
    "VolcengineImageGenerator",
    "MockImageGenerator",
    "create_image_generator",
    "generate_character_reference_unified",
    "generate_identity_image_unified",
    # TTS Generator
    "TTSParams",
    "TTSResult",
    "VoiceInfo",
    "EdgeTTSGenerator",
    "MockTTSGenerator",
    "create_tts_generator",
    "get_voice_by_style",
    "RECOMMENDED_VOICES",
    # Video Composer
    "SceneAsset",
    "VideoResult",
    "KenBurnsEffect",
    "VideoComposer",
    "MoviePyComposer",
    "create_video_composer",
    "adjust_video_duration",
    "get_video_duration",
    # Video Generator
    "VideoBackend",
    "VideoGenStatus",
    "VideoGenResult",
    "VideoGeneratorBase",
    "MockVideoGenerator",
    "SeedanceVideoGenerator",
    "ComfyUIVideoGenerator",
    "create_video_generator",
    # NanoBananaPro Grid Generator
    "GridGenerationRequest",
    "GridGenerationResult",
    "NanoBananaGridGenerator",
    "create_grid_generator",
    "get_optimal_grid_size",
    # Grid Splitter
    "split_grid",
    "split_grid_with_padding",
    "detect_grid_layout",
    "resize_frames_to_portrait",
    "combine_to_grid",
    # Unified Prompt Builder
    "PromptMode",
    "GridConfig",
    "CharacterConfig",
    "StyleConfig",
    "PromptContext",
    "PromptComponents",
    "UnifiedPromptBuilder",
    "create_prompt_context",
]
