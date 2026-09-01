import { describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { buildCanvasActionCatalog } from "@/features/freezone/context/canvasActionCatalog";
import { buildCanvasNodeActionCatalog } from "@/features/freezone/canvasNodeActionCatalog";

function node(partial: Partial<CanvasNode> & { id: string; type: CanvasNode["type"] }): CanvasNode {
  return {
    id: partial.id,
    type: partial.type,
    position: partial.position ?? { x: 0, y: 0 },
    data: partial.data ?? {},
  } as CanvasNode;
}

describe("canvas action catalog", () => {
  it("lets upload nodes open the local upload picker through a manual UI action", () => {
    const upload = node({
      id: "upload-a",
      type: CANVAS_NODE_TYPES.upload,
      data: {
        displayName: "上传资源",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(upload);

    expect(catalog.editable_fields).toEqual(["displayName"]);
    expect(catalog.actions).toContainEqual(
      expect.objectContaining({
        action: "open_upload_picker",
        execution: "manual_ui",
        command_type: "run_node_action",
        parameters: {
          node_id: "upload-a",
          accept: "image/*,video/*,audio/*",
        },
      }),
    );
  });

  it("does not expose direct delete for mainline projection nodes", () => {
    const projectionNode = node({
      id: "projection-node-a",
      type: CANVAS_NODE_TYPES.textAnnotation,
      data: {
        preset_managed: true,
        projection_key: "asset:scene:master",
        title: "主线场景",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(projectionNode);

    expect(catalog.actions).not.toContainEqual(
      expect.objectContaining({
        action: "delete_node",
      }),
    );
  });

  it("describes audio voice updates with voiceRef instead of voiceId", () => {
    const audio = node({
      id: "audio-a",
      type: CANVAS_NODE_TYPES.audio,
      data: {
        audioKind: "speech",
        text: "广告词",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(audio);

    expect(catalog.editable_fields).toContain("voiceRef");
    expect(catalog.editable_fields).toContain("voiceLanguage");
    expect(catalog.editable_fields).not.toContain("voiceId");
    expect(catalog.editable_schema.voiceRef).toMatchObject({
      type: "object",
      source: "canvas_context_request.v1 audio_voice_options",
      context_request: {
        schema_version: "canvas_context_request.v1",
        requests: [{ type: "audio_voice_options", node_id: "audio-a" }],
      },
    });
  });

  it("keeps audio generation available when an audio node already has uploaded audio", () => {
    const audio = node({
      id: "audio-uploaded",
      type: CANVAS_NODE_TYPES.audio,
      data: {
        audioKind: "speech",
        audioUrl: "/static/projects/demo/freezone/_uploads/reference.mp3",
        text: "请生成新的口播音频",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(audio);

    expect(catalog.actions).toContainEqual(
      expect.objectContaining({
        action: "generate_audio",
        execution: "frontend_node",
        command_type: "run_node_action",
      }),
    );
  });

  it("exposes the voice picker upload flow for speech audio nodes only", () => {
    const speechAudio = node({
      id: "audio-speech-a",
      type: CANVAS_NODE_TYPES.audio,
      data: {
        audioKind: "speech",
        text: "广告词",
      },
    });
    const musicAudio = node({
      id: "audio-music-a",
      type: CANVAS_NODE_TYPES.audio,
      data: {
        audioKind: "music",
        text: "温暖的背景音乐",
      },
    });

    const speechCatalog = buildCanvasNodeActionCatalog(speechAudio);
    const musicCatalog = buildCanvasNodeActionCatalog(musicAudio);

    expect(speechCatalog.actions).toContainEqual(
      expect.objectContaining({
        action: "open_voice_picker",
        execution: "manual_ui",
        command_type: "run_node_action",
        parameters: {
          node_id: "audio-speech-a",
          supports_upload: true,
          result_fields: ["voiceRef", "voiceLabel", "voiceLanguage"],
        },
      }),
    );
    const openVoicePicker = speechCatalog.actions.find(
      (action) => action.action === "open_voice_picker",
    );
    expect(openVoicePicker?.description).toContain("upload");
    expect(openVoicePicker?.description).toContain("call this action again");
    expect(musicCatalog.actions).not.toContainEqual(
      expect.objectContaining({ action: "open_voice_picker" }),
    );
  });

  it("exposes audio download as a runnable node action with format options", () => {
    const audio = node({
      id: "audio-download-a",
      type: CANVAS_NODE_TYPES.audio,
      data: {
        audioUrl: "/static/projects/demo/freezone/audio.m4a",
        sourceFileName: "demo_audio",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(audio);

    expect(catalog.actions).toContainEqual(
      expect.objectContaining({
        action: "download_audio",
        execution: "frontend_node",
        command_type: "run_node_action",
        description: expect.stringContaining("Trigger a browser download"),
        parameters: {
          node_id: "audio-download-a",
          format_schema: {
            type: "enum",
            options: ["source", "mp3", "m4a", "wav"],
            default: "source",
          },
        },
      }),
    );
  });

  it("exposes image download as a runnable node action when an image has media", () => {
    const image = node({
      id: "image-download-a",
      type: CANVAS_NODE_TYPES.imageGen,
      data: {
        imageUrl: "/static/projects/demo/freezone/image.png",
        sourceFileName: "demo.png",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(image);

    expect(catalog.actions).toContainEqual(
      expect.objectContaining({
        action: "download_image",
        execution: "frontend_node",
        command_type: "run_node_action",
        description: expect.stringContaining("Trigger a browser download"),
        parameters: { node_id: "image-download-a" },
      }),
    );
  });

  it("exposes scene 360 as a direct generation action", () => {
    const image = node({
      id: "scene-source-a",
      type: CANVAS_NODE_TYPES.imageGen,
      data: {
        imageUrl: "/static/projects/demo/freezone/source.png",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(image);

    expect(catalog.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "run_scene360_tool",
          execution: "frontend_node",
          command_type: "run_node_action",
          description: expect.stringContaining("全景"),
        }),
      ]),
    );
    expect(catalog.actions).not.toContainEqual(
      expect.objectContaining({ action: "open_scene360_tool" }),
    );
  });

  it("describes video node editable schema with aspect ratio options", () => {
    const video = node({
      id: "video-aspect-a",
      type: CANVAS_NODE_TYPES.video,
      data: {
        prompt: "公益广告短片",
        genMode: "imageToVideo",
        model: "newapi_seedance-2.0-fast",
        aspectRatio: "9:16",
        quality: "720P",
        durationSec: 5,
      },
    });

    const catalog = buildCanvasNodeActionCatalog(video);

    expect(catalog.editable_fields).toEqual(
      expect.arrayContaining([
        "genMode",
        "aspectRatio",
        "quality",
        "durationSec",
        "generateAudio",
        "humanReview",
        "count",
      ]),
    );
    expect(catalog.editable_schema.humanReview).toMatchObject({
      type: "boolean",
      current_value: false,
    });
    expect(catalog.editable_schema.genMode).toMatchObject({
      type: "enum",
      current_value: "imageToVideo",
      options: expect.arrayContaining(["textToVideo", "imageToVideo", "allReference"]),
      option_labels: expect.objectContaining({
        textToVideo: "文生视频",
        imageToVideo: "图生视频",
      }),
    });
    expect(catalog.editable_schema.aspectRatio).toMatchObject({
      type: "enum",
      options: expect.arrayContaining(["auto", "16:9", "9:16"]),
      current_value: "9:16",
    });
    expect(catalog.editable_schema.quality).toMatchObject({
      type: "enum",
      options: expect.arrayContaining(["480P", "720P"]),
    });
  });

  it("explains generator prompt fields are combined with upstream prompt text and reference mentions", () => {
    const image = node({
      id: "image-prompt-a",
      type: CANVAS_NODE_TYPES.imageGen,
      data: { prompt: "Poster prompt" },
    });
    const video = node({
      id: "video-prompt-a",
      type: CANVAS_NODE_TYPES.video,
      data: { prompt: "Video prompt" },
    });

    const imagePrompt = buildCanvasNodeActionCatalog(image).editable_schema.prompt;
    const videoPrompt = buildCanvasNodeActionCatalog(video).editable_schema.prompt;

    expect(imagePrompt.description).toContain("combined with upstream prompt_for text");
    expect(imagePrompt.description).toContain("avoid duplicating");
    expect(imagePrompt.description).toContain("@图片1");
    expect(imagePrompt.description).toContain("top reference thumbnails");
    expect(imagePrompt.description).toContain("declare each referenced image's role");
    expect(videoPrompt.description).toContain("combined with upstream prompt_for text");
    expect(videoPrompt.description).toContain("avoid duplicating");
    expect(videoPrompt.description).toContain("@图片1");
    expect(videoPrompt.description).toContain("top reference thumbnails");
    expect(videoPrompt.description).toContain("declare each referenced image's role");
  });

  it("reminds generator actions to bind upstream references before running", () => {
    const image = node({
      id: "image-action-a",
      type: CANVAS_NODE_TYPES.imageGen,
      data: { prompt: "@图片1 作为构图参考" },
    });
    const video = node({
      id: "video-action-a",
      type: CANVAS_NODE_TYPES.video,
      data: { prompt: "@图片1 作为角色参考", genMode: "imageReference" },
    });

    const imageAction = buildCanvasNodeActionCatalog(image).actions.find(
      (action) => action.action === "generate_image",
    );
    const videoAction = buildCanvasNodeActionCatalog(video).actions.find(
      (action) => action.action === "generate_video",
    );

    expect(imageAction?.description).toContain("@图片N");
    expect(imageAction?.description).toContain("Before running");
    expect(videoAction?.description).toContain("@图片N");
    expect(videoAction?.description).toContain("imageReference");
    expect(videoAction?.description).toContain("Before running");
  });

  it("exposes video download as a runnable node action when a video has media", () => {
    const video = node({
      id: "video-download-a",
      type: CANVAS_NODE_TYPES.video,
      data: {
        videoUrl: "/static/projects/demo/freezone/video.mp4",
        sourceFileName: "demo.mp4",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(video);

    expect(catalog.actions).toContainEqual(
      expect.objectContaining({
        action: "download_video",
        execution: "frontend_node",
        command_type: "run_node_action",
        description: expect.stringContaining("Trigger a browser download"),
        parameters: { node_id: "video-download-a" },
      }),
    );
  });

  it("describes video upscale as a downstream tool action, not source node parameters", () => {
    const video = node({
      id: "video-upscale-a",
      type: CANVAS_NODE_TYPES.video,
      data: {
        videoUrl: "/static/projects/demo/freezone/video.mp4",
        quality: "720P",
        durationSec: 5,
      },
    });

    const catalog = buildCanvasNodeActionCatalog(video);
    const action = catalog.actions.find(
      (item) => item.action === "open_video_upscale_tool",
    );

    expect(action).toMatchObject({
      action: "open_video_upscale_tool",
      execution: "manual_ui",
      command_type: "run_node_action",
      parameters: {
        node_id: "video-upscale-a",
        parameter_schema: {
          resolution: expect.objectContaining({
            options: ["1080p", "2k", "4k"],
          }),
          denoise: expect.objectContaining({
            options: ["none", "1x", "2x"],
          }),
        },
      },
      result_effect: {
        target: "downstream video upscale node",
      },
    });
    expect(action?.description).toContain("downstream video upscale node");
    expect(action?.description).toContain("source video node's editable parameters");
  });

  it("exposes automatic and manual video compose actions", () => {
    const compose = node({
      id: "compose-a",
      type: CANVAS_NODE_TYPES.videoCompose,
      data: {
        displayName: "合成视频",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(compose);

    expect(catalog.downstream_spawn_types).toEqual([]);
    expect(catalog.actions).not.toContainEqual(
      expect.objectContaining({ action: "add_next_node" }),
    );
    expect(catalog.actions).toContainEqual(
      expect.objectContaining({
        action: "auto_compose_video",
        execution: "frontend_node",
        command_type: "run_node_action",
        parameters: { node_id: "compose-a" },
      }),
    );
    expect(catalog.actions).toContainEqual(
      expect.objectContaining({
        action: "open_video_compose_modal",
        execution: "manual_ui",
        command_type: "run_node_action",
        parameters: { node_id: "compose-a" },
      }),
    );
  });

  it("treats director world nodes as terminal 3GS/viewer endpoints", () => {
    const world = node({
      id: "world-a",
      type: CANVAS_NODE_TYPES.threeDWorld,
      data: {
        displayName: "导演世界",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(world);

    expect(catalog.downstream_spawn_types).toEqual([]);
    expect(catalog.actions).not.toContainEqual(
      expect.objectContaining({ action: "add_next_node" }),
    );
    expect(catalog.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "open_director_world",
          execution: "manual_ui",
          command_type: "run_node_action",
        }),
      ]),
    );
    expect(catalog.actions).not.toContainEqual(
      expect.objectContaining({ action: "generate_3gs_world" }),
    );
  });

  it("exposes 3GS generation only when a director world has an image upstream", () => {
    const image = node({
      id: "image-a",
      type: CANVAS_NODE_TYPES.imageGen,
      data: {
        imageUrl: "/static/image.png",
      },
    });
    const world = node({
      id: "world-a",
      type: CANVAS_NODE_TYPES.threeDWorld,
      data: {
        displayName: "导演世界",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(world, {
      nodes: [image, world],
      edges: [{ id: "edge-a", source: image.id, target: world.id }],
    });

    expect(catalog.actions).toContainEqual(
      expect.objectContaining({
        action: "generate_3gs_world",
        execution: "frontend_node",
        command_type: "run_node_action",
        description: expect.stringContaining("single connected upstream image"),
      }),
    );
  });

  it("describes skill nodes without exposing run_skill until required inputs are connected", () => {
    const skill = node({
      id: "skill-sketch-a",
      type: CANVAS_NODE_TYPES.skill,
      data: {
        displayName: "根据当前背景生成草图",
        skill_id: "freezone.sketch_from_context",
        parameters: { style: "rough" },
      },
    });

    const catalog = buildCanvasNodeActionCatalog(skill);

    expect(catalog).toMatchObject({
      node_id: "skill-sketch-a",
      node_type: CANVAS_NODE_TYPES.skill,
      skill_id: "freezone.sketch_from_context",
    });
    expect(catalog.downstream_spawn_types).toEqual([CANVAS_NODE_TYPES.imageGen]);
    expect(catalog.actions).not.toContainEqual(
      expect.objectContaining({ action: "run_skill" }),
    );
  });

  it("exposes run_skill when a skill node has its required inputs connected", () => {
    const beat = node({
      id: "beat-a",
      type: CANVAS_NODE_TYPES.beatContext,
      data: {
        displayName: "镜头上下文",
        beat_context: { episode: 1, beat: 2 },
      },
    });
    const background = node({
      id: "background-a",
      type: CANVAS_NODE_TYPES.imageGen,
      data: {
        displayName: "背景",
        imageUrl: "/static/background.png",
      },
    });
    const skill = node({
      id: "skill-sketch-a",
      type: CANVAS_NODE_TYPES.skill,
      data: {
        displayName: "根据当前背景生成草图",
        skill_id: "freezone.sketch_from_context",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(skill, {
      nodes: [beat, background, skill],
      edges: [
        {
          id: "edge-beat",
          source: beat.id,
          target: skill.id,
          targetHandle: "beat_context",
          data: { role: "beat_context" },
        },
        {
          id: "edge-background",
          source: background.id,
          target: skill.id,
          targetHandle: "background",
          data: { role: "background" },
        },
      ],
    });

    expect(catalog.actions).toContainEqual(
      expect.objectContaining({
        action: "run_skill",
        execution: "frontend_node",
        command_type: "run_node_action",
        can_run_now: true,
        blocked_reasons: [],
        description: expect.stringContaining("Run this skill node"),
        parameters: {
          node_id: "skill-sketch-a",
          skill_id: "freezone.sketch_from_context",
          result_policy: "spawn_outputs",
        },
      }),
    );
  });

  it("marks run_skill blocked when connected sketch inputs have not produced imageUrl", () => {
    const beat = node({
      id: "beat-a",
      type: CANVAS_NODE_TYPES.beatContext,
      data: {
        displayName: "镜头上下文",
        beat_context: { episode: 1, beat: 2 },
      },
    });
    const pendingSketch = node({
      id: "sketch-a",
      type: CANVAS_NODE_TYPES.imageGen,
      data: {
        displayName: "正在生成的草图",
      },
    });
    const skill = node({
      id: "skill-frame-a",
      type: CANVAS_NODE_TYPES.skill,
      data: {
        displayName: "根据草图生成分镜",
        skill_id: "freezone.frame_from_context",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(skill, {
      nodes: [beat, pendingSketch, skill],
      edges: [
        {
          id: "edge-beat",
          source: beat.id,
          target: skill.id,
          targetHandle: "beat_context",
          data: { role: "beat_context" },
        },
        {
          id: "edge-sketch",
          source: pendingSketch.id,
          target: skill.id,
          targetHandle: "sketch",
          data: { role: "sketch" },
        },
      ],
    });

    expect(catalog.actions).toContainEqual(
      expect.objectContaining({
        action: "run_skill",
        command_type: "run_node_action",
        can_run_now: false,
        blocked_reasons: ["sketch 输入尚未就绪：上游草图节点缺少 imageUrl。"],
        instruction: expect.stringContaining("不要 emit run_node_action"),
        preconditions: [
          expect.objectContaining({
            type: "required_upstream_output",
            role: "sketch",
            node_ids: ["sketch-a"],
            required_field: "imageUrl",
            status: "missing",
          }),
        ],
      }),
    );
  });

  it("derives skill downstream types from the backend output node type contract", () => {
    const reviewSkill = node({
      id: "skill-review-a",
      type: CANVAS_NODE_TYPES.skill,
      data: {
        displayName: "审核分镜",
        skill_id: "agent.review_frame",
      },
    });
    const unknownSkill = node({
      id: "skill-unknown-a",
      type: CANVAS_NODE_TYPES.skill,
      data: {
        displayName: "未知技能",
        skill_id: "custom.unknown",
      },
    });

    const reviewCatalog = buildCanvasNodeActionCatalog(reviewSkill);
    const unknownCatalog = buildCanvasNodeActionCatalog(unknownSkill);

    expect(reviewCatalog.downstream_spawn_types).toEqual([CANVAS_NODE_TYPES.textAnnotation]);
    expect(unknownCatalog.downstream_spawn_types).toEqual([]);
  });

  it("exposes runnable pano viewer actions only when the 360 node has panorama media", () => {
    const pano = node({
      id: "pano-a",
      type: CANVAS_NODE_TYPES.pano360Viewer,
      data: {
        displayName: "360 全景",
        imageUrl: "/static/projects/demo/freezone/pano.png",
      },
    });
    const emptyPano = node({
      id: "pano-empty",
      type: CANVAS_NODE_TYPES.pano360Viewer,
      data: {
        displayName: "空 360 全景",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(pano);
    const emptyCatalog = buildCanvasNodeActionCatalog(emptyPano);

    expect(catalog.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "capture_pano_current_view",
          execution: "frontend_node",
          command_type: "run_node_action",
          parameters: { node_id: "pano-a" },
        }),
        expect.objectContaining({
          action: "capture_pano_2x2_views",
          execution: "frontend_node",
          command_type: "run_node_action",
          parameters: { node_id: "pano-a" },
        }),
        expect.objectContaining({
          action: "capture_pano_4x3_views",
          execution: "frontend_node",
          command_type: "run_node_action",
          parameters: { node_id: "pano-a" },
        }),
        expect.objectContaining({
          action: "set_pano_current_view_as_background",
          execution: "frontend_node",
          command_type: "run_node_action",
          parameters: { node_id: "pano-a" },
        }),
        expect.objectContaining({
          action: "reset_pano_view",
          execution: "frontend_node",
          command_type: "run_node_action",
          parameters: { node_id: "pano-a" },
        }),
      ]),
    );
    expect(emptyCatalog.actions).not.toContainEqual(
      expect.objectContaining({ action: "capture_pano_current_view" }),
    );
  });

  it("describes split-storyboard extraction as a manual UI action distinct from 25-frame generation", () => {
    const image = node({
      id: "image-a",
      type: CANVAS_NODE_TYPES.imageGen,
      data: {
        imageUrl: "/static/image.png",
        prompt: "A storyboard sheet",
      },
    });

    const catalog = buildCanvasNodeActionCatalog(image);
    const splitAction = catalog.actions.find(
      (action) => action.action === "open_split_storyboard_tool",
    );
    const serialStoryboardAction = catalog.actions.find(
      (action) => action.action === "run_grid_serial_storyboard_25",
    );

    expect(splitAction).toMatchObject({
      execution: "manual_ui",
      command_type: "run_node_action",
      description: expect.stringContaining("分格抽取"),
      parameters: {
        node_id: "image-a",
        tool_type: "split-storyboard",
      },
    });
    expect(serialStoryboardAction?.description).toContain("不是分格抽取");
  });

  it("combines frontend UI command capabilities with business action capabilities", () => {
    const image = node({
      id: "image-a",
      type: CANVAS_NODE_TYPES.imageGen,
      data: {
        imageUrl: "/static/image.png",
        prompt: "A moonlit street",
      },
    });
    const video = node({
      id: "video-a",
      type: CANVAS_NODE_TYPES.video,
      data: {
        videoUrl: "/static/video.mp4",
        prompt: "A moonlit street moves slowly",
      },
    });
    const audio = node({
      id: "audio-a",
      type: CANVAS_NODE_TYPES.audio,
      data: {
        text: "月光下的街道",
        audioKind: "speech",
      },
    });
    const text = node({
      id: "text-a",
      type: CANVAS_NODE_TYPES.textAnnotation,
      data: {
        content: "一段需要翻译的文案",
        mode: "writing",
      },
    });
    const script = node({
      id: "script-a",
      type: CANVAS_NODE_TYPES.script,
      data: {
        prompt: "生成一个广告短片脚本",
      },
    });
    const world = node({
      id: "world-a",
      type: CANVAS_NODE_TYPES.threeDWorld,
      data: {
        displayName: "导演世界",
      },
    });

    const catalog = buildCanvasActionCatalog(
      [image, video, audio, text, script, world],
      [{ id: "edge-world", source: image.id, target: world.id }],
    );

    expect(catalog.schema_version).toBe("canvas_action_catalog.v1");
    expect(catalog.node_action_catalogs).toHaveLength(6);
    expect(catalog.node_action_catalogs[0]?.actions).toContainEqual(
      expect.objectContaining({
        action: "generate_image",
        execution: "frontend_node",
        command_type: "run_node_action",
      }),
    );
    expect(catalog.node_action_catalogs[1]?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "generate_video",
          execution: "frontend_node",
          command_type: "run_node_action",
        }),
        expect.objectContaining({
          action: "open_video_upscale_tool",
          command_type: "run_node_action",
        }),
        expect.objectContaining({
          action: "run_video_analyze_story",
          execution: "frontend_node",
          command_type: "run_node_action",
        }),
        expect.objectContaining({
          action: "run_audio_separate",
          execution: "frontend_node",
          command_type: "run_node_action",
        }),
        expect.objectContaining({
          action: "open_video_subtitle_erase_smart",
          command_type: "run_node_action",
        }),
      ]),
    );
    expect(catalog.node_action_catalogs[2]?.actions).toContainEqual(
      expect.objectContaining({
        action: "generate_audio",
        execution: "frontend_node",
        command_type: "run_node_action",
      }),
    );
    expect(catalog.node_action_catalogs[2]?.actions).toContainEqual(
      expect.objectContaining({
        action: "translate_text",
        execution: "frontend_node",
        command_type: "run_node_action",
      }),
    );
    expect(catalog.node_action_catalogs[3]?.actions).toContainEqual(
      expect.objectContaining({
        action: "translate_text",
        execution: "frontend_node",
        command_type: "run_node_action",
      }),
    );
    expect(catalog.node_action_catalogs[4]?.actions).toContainEqual(
      expect.objectContaining({
        action: "generate_story_script",
        execution: "frontend_node",
        command_type: "run_node_action",
      }),
    );
    expect(catalog.node_action_catalogs[5]?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "open_director_world",
          execution: "manual_ui",
          command_type: "run_node_action",
        }),
        expect.objectContaining({
          action: "generate_3gs_world",
          execution: "frontend_node",
          command_type: "run_node_action",
        }),
      ]),
    );
    expect(catalog.frontend_command_catalog.map((item) => item.id)).toContain("ui.run_upscale_tool");
    expect(catalog.frontend_command_catalog.map((item) => item.id)).toContain("ui.run_matting_tool");
    const mattingCapability = catalog.frontend_command_catalog.find(
      (item) => item.id === "ui.run_matting_tool",
    );
    expect(mattingCapability?.frontend_mapping?.description).toContain("去背景");
    expect(mattingCapability?.frontend_mapping?.description).toContain("透明背景");
    expect(catalog.frontend_command_catalog.map((item) => item.id)).toContain("ui.run_grid_product_three_view");
    expect(catalog.frontend_command_catalog.map((item) => item.id)).toContain("ui.generate_video");
    expect(catalog.frontend_command_catalog.map((item) => item.id)).toContain("ui.generate_audio");
    expect(catalog.frontend_command_catalog.map((item) => item.id)).toContain("ui.translate_text");
    expect(catalog.frontend_command_catalog.map((item) => item.id)).toContain("ui.generate_story_script");
    expect(catalog.frontend_command_catalog.map((item) => item.id)).toContain("ui.open_director_world");
    expect(catalog.frontend_command_catalog.map((item) => item.id)).toContain("ui.generate_3gs_world");
    expect(catalog.frontend_command_catalog.map((item) => item.id)).toContain("ui.open_video_upscale_tool");
    expect(catalog.frontend_command_catalog).toContainEqual(
      expect.objectContaining({
        id: "ui.generate_image",
        execution: "frontend_node",
        command_type: "run_node_action",
      }),
    );
    expect(catalog.canvas_action_catalog.map((item) => item.id)).toContain("freezone.image.generate");
    expect(catalog.canvas_action_catalog.map((item) => item.id)).toContain("freezone.audio.generate");
    expect(catalog.canvas_action_catalog.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "freezone.text.translate",
        "freezone.image.reverse_prompt",
        "freezone.text.to_video",
        "freezone.text.story_script",
        "freezone.director_world.open",
        "freezone.image.to_3gs",
      ]),
    );
    expect(catalog.canvas_action_catalog.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "freezone.image.edit.reference",
        "ui.open_crop_tool",
        "ui.open_annotate_tool",
        "ui.open_split_storyboard_tool",
        "ui.run_matting_tool",
        "ui.run_upscale_tool",
        "ui.open_redraw_tool",
        "ui.open_erase_tool",
        "ui.run_outpaint_tool",
        "ui.run_scene360_tool",
        "ui.open_multi_angle_tool",
        "ui.open_light_tool",
        "ui.open_rotate_tool",
        "ui.run_grid_multi_camera",
        "ui.run_grid_product_three_view",
        "ui.open_video_viewer",
        "ui.open_video_clip_tool",
        "ui.open_video_upscale_tool",
        "ui.run_video_analyze_story",
        "ui.run_audio_separate",
        "ui.open_video_subtitle_erase_smart",
        "ui.open_video_subtitle_erase_box",
      ]),
    );
    expect(catalog.canvas_action_catalog.find((item) => item.id === "freezone.image.generate")).toMatchObject({
      execution: "frontend_node",
      node_type: CANVAS_NODE_TYPES.imageGen,
    });
    expect(catalog.canvas_action_catalog.find((item) => item.id === "freezone.video.generate")).toMatchObject({
      execution: "frontend_node",
      node_type: CANVAS_NODE_TYPES.video,
      frontend_mapping: expect.objectContaining({
        run_action: "generate_video",
      }),
    });
    expect(catalog.canvas_action_catalog.find((item) => item.id === "freezone.audio.generate")).toMatchObject({
      execution: "frontend_node",
      node_type: CANVAS_NODE_TYPES.audio,
      frontend_mapping: expect.objectContaining({
        run_action: "generate_audio",
        modes: ["speech", "music"],
      }),
    });
    expect(catalog.canvas_action_catalog.find((item) => item.id === "freezone.text.translate")).toMatchObject({
      execution: "frontend_node",
      node_type: CANVAS_NODE_TYPES.textAnnotation,
      frontend_mapping: expect.objectContaining({
        run_action: "translate_text",
      }),
    });
    expect(catalog.canvas_action_catalog.find((item) => item.id === "freezone.text.story_script")).toMatchObject({
      execution: "frontend_node",
      node_type: CANVAS_NODE_TYPES.script,
      frontend_mapping: expect.objectContaining({
        run_action: "generate_story_script",
      }),
    });
    expect(catalog.canvas_action_catalog.find((item) => item.id === "freezone.director_world.open")).toMatchObject({
      execution: "manual_ui",
      node_type: CANVAS_NODE_TYPES.threeDWorld,
      frontend_mapping: expect.objectContaining({
        run_action: "open_director_world",
      }),
    });
    expect(catalog.canvas_action_catalog.find((item) => item.id === "ui.open_multi_angle_tool")).toMatchObject({
      display_name: expect.stringContaining("多维度"),
      frontend_mapping: expect.objectContaining({
        description: expect.stringContaining("多维度"),
      }),
    });
    expect(catalog.canvas_action_catalog.find((item) => item.id === "ui.run_scene360_tool")).toMatchObject({
      display_name: expect.stringContaining("全景"),
      execution: "frontend_node",
      frontend_mapping: expect.objectContaining({
        action: "run_scene360_tool",
        description: expect.stringContaining("全景"),
      }),
    });
    expect(catalog.canvas_action_catalog.find((item) => item.id === "freezone.image.to_3gs")).toMatchObject({
      execution: "frontend_node",
      node_type: CANVAS_NODE_TYPES.threeDWorld,
      frontend_mapping: expect.objectContaining({
        run_action: "generate_3gs_world",
      }),
    });
  });
});
