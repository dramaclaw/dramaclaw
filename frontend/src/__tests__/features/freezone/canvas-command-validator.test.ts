import { describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { validateCanvasChatCommandEnvelopes } from "@/features/freezone/context/canvasCommandValidator";
import { CANVAS_CHAT_COMMANDS_SCHEMA_VERSION, type CanvasChatCommandEnvelope } from "@/features/freezone/canvasChatCommands";
import { canvasLinkTypeCatalogJson, canvasLinkTypeCatalogText } from "@/features/freezone/canvasEdgeSemantics";

function node(partial: Partial<CanvasNode> & { id: string; type: CanvasNode["type"] }): CanvasNode {
  return {
    id: partial.id,
    type: partial.type,
    position: partial.position ?? { x: 0, y: 0 },
    data: partial.data ?? {},
  } as CanvasNode;
}

describe("canvas command validator", () => {
  it("describes context_for as a text planning relationship only", () => {
    const contextLinkType = canvasLinkTypeCatalogJson().find((item) => item.link_type === "context_for");

    expect(contextLinkType).toMatchObject({
      source_object_types: ["TextNode", "ScriptNode"],
      target_object_types: ["TextNode", "ScriptNode"],
      description: "文本/剧本规划节点之间的背景、约束或说明关系，用于组织创作思路，不直接驱动媒体生成。",
      instruction: expect.stringContaining("Never use context_for for image/video/audio generation targets"),
    });
  });

  it("distinguishes consumed inputs and execution dependencies from visual association lines", () => {
    const catalogText = canvasLinkTypeCatalogText();
    const promptLinkType = canvasLinkTypeCatalogJson().find((item) => item.link_type === "prompt_for");

    expect(catalogText).toContain(
      "Edges are data, semantic input, or explicit execution-order relationships",
    );
    expect(catalogText).toContain(
      "Use dependency_for only when the target must wait without consuming the source output",
    );
    expect(catalogText).toContain("use group_nodes or layout_nodes instead of create_edge");
    expect(promptLinkType?.source_object_types).toEqual(["TextNode"]);
    expect(promptLinkType?.instruction).toContain("upstream text is direct generation input");
    expect(promptLinkType?.instruction).toContain("no semanticOutputRole may be connected with prompt_for");
    expect(promptLinkType?.instruction).toContain("group it with the generator instead of connecting it directly");
  });

  it("describes composition inputs as video or audio assets only", () => {
    const compositionLinkType = canvasLinkTypeCatalogJson().find((item) => item.link_type === "composition_input_for");

    expect(compositionLinkType?.source_object_types).toEqual(["VideoNode", "AudioNode"]);
  });

  it("accepts valid commands with client ids in the same envelope", () => {
    const source = node({
      id: "source-image",
      type: CANVAS_NODE_TYPES.imageGen,
      data: { imageUrl: "/static/source.png", prompt: "" },
    });
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "add_next_node",
          source_node_id: "source-image",
          client_id: "next-video",
          node_type: CANVAS_NODE_TYPES.video,
          connect: true,
        },
        {
          type: "select_nodes",
          node_ids: ["next-video"],
          focus: true,
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [source], []);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("accepts human review updates for a newly created video workflow node", () => {
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "create_node",
          client_id: "video-a",
          node_type: CANVAS_NODE_TYPES.video,
          data: { genMode: "imageToVideo" },
        },
        {
          type: "update_node_data",
          node_id: "video-a",
          data: { humanReview: true },
        },
        {
          type: "run_workflow",
          node_ids: ["video-a"],
          scope: "selection",
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [], []);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("accepts unreferenced new nodes without client ids", () => {
    const source = node({
      id: "source-image",
      type: CANVAS_NODE_TYPES.imageGen,
      data: { imageUrl: "/static/source.png", prompt: "" },
    });
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "create_node",
          node_type: CANVAS_NODE_TYPES.textAnnotation,
          data: { prompt: "brief" },
        },
        {
          type: "add_next_node",
          source_node_id: "source-image",
          node_type: CANVAS_NODE_TYPES.video,
          connect: true,
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [source], []);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects missing nodes and non-editable fields", () => {
    const preset = node({
      id: "preset-image",
      type: CANVAS_NODE_TYPES.imageGen,
      data: {
        prompt: "",
        preset_managed: true,
      },
    });
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "update_node_data",
          node_id: "preset-image",
          data: { prompt: "new prompt", unknownField: "nope" },
        },
        {
          type: "create_edge",
          source: "missing",
          target: "preset-image",
          link_type: "media_input_for",
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [preset], []);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        "node is preset managed: preset-image",
        "fields are not editable on this node: prompt, unknownField",
        "source node not found: missing",
      ]),
    );
  });

  it("accepts display name aliases on editable node titles", () => {
    const videoNode = node({
      id: "video-node",
      type: CANVAS_NODE_TYPES.video,
      data: { prompt: "旧提示词", displayName: "旧标题" },
    });
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "update_node_data",
          node_id: "video-node",
          data: { label: "新标题" },
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [videoNode], []);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("accepts update aliases that normalize into editable text fields", () => {
    const textNode = node({
      id: "text-node",
      type: CANVAS_NODE_TYPES.textAnnotation,
      data: { displayName: "旧标题", content: "旧内容" },
    });
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "update_node_data",
          node_id: "text-node",
          data: { title: "新标题", content: "新内容" },
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [textNode], []);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects planning text edges into generators", () => {
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "create_node",
          client_id: "brief",
          node_type: CANVAS_NODE_TYPES.textAnnotation,
          data: {
            displayName: "海报简报",
            content: "家乡文化海报策划",
            semanticOutputRole: "planning_text",
          },
        },
        {
          type: "create_node",
          client_id: "poster",
          node_type: CANVAS_NODE_TYPES.imageGen,
          data: { displayName: "海报图", prompt: "一张家乡文化海报" },
        },
        {
          type: "create_edge",
          source: "brief",
          target: "poster",
          link_type: "prompt_for",
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [], []);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("edge output role planning_text is not accepted by target imageGenNode"),
        expect.stringContaining("do not change that existing brief/planning node to input_text"),
        expect.stringContaining("group it with the generator instead of connecting it directly"),
        expect.stringContaining('semanticOutputRole="input_text"'),
      ]),
    );
  });

  it("infers blank text nodes as direct input when connected to generators with prompt_for", () => {
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "create_node",
          client_id: "prompt",
          node_type: CANVAS_NODE_TYPES.textAnnotation,
          data: { displayName: "图片提示", content: "新国风水墨海报" },
        },
        {
          type: "create_node",
          client_id: "poster",
          node_type: CANVAS_NODE_TYPES.imageGen,
          data: { displayName: "海报图", prompt: "" },
        },
        {
          type: "create_edge",
          source: "prompt",
          target: "poster",
          link_type: "prompt_for",
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [], []);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("accepts text-to-text context edges", () => {
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "create_node",
          client_id: "poster_root",
          node_type: CANVAS_NODE_TYPES.textAnnotation,
          data: { displayName: "海报创意工作区", content: "整体方向" },
        },
        {
          type: "create_node",
          client_id: "culture_elements",
          node_type: CANVAS_NODE_TYPES.textAnnotation,
          data: { displayName: "文化元素", content: "家乡文化符号" },
        },
        {
          type: "create_edge",
          source: "poster_root",
          target: "culture_elements",
          link_type: "context_for",
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [], []);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects context edges into generation nodes", () => {
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "create_node",
          client_id: "brief",
          node_type: CANVAS_NODE_TYPES.textAnnotation,
          data: { displayName: "海报创意", content: "整体方向" },
        },
        {
          type: "create_node",
          client_id: "poster",
          node_type: CANVAS_NODE_TYPES.imageGen,
          data: { displayName: "海报图", prompt: "生成海报" },
        },
        {
          type: "create_edge",
          source: "brief",
          target: "poster",
          link_type: "context_for",
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [], []);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("link_type context_for is not valid for TextNode -> ImageNode"),
      ]),
    );
  });

  it("accepts executable input text edges into generators", () => {
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "create_node",
          client_id: "prompt",
          node_type: CANVAS_NODE_TYPES.textAnnotation,
          data: {
            displayName: "海报提示词",
            content: "一张家乡文化海报，典雅大气，高清印刷风格",
            semanticOutputRole: "input_text",
          },
        },
        {
          type: "create_node",
          client_id: "poster",
          node_type: CANVAS_NODE_TYPES.imageGen,
          data: { displayName: "海报图", prompt: "按上游提示词生成海报" },
        },
        {
          type: "create_edge",
          source: "prompt",
          target: "poster",
          link_type: "prompt_for",
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [], []);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("accepts source media edges into text nodes for image-to-text workflows", () => {
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "create_node",
          client_id: "image_input",
          node_type: CANVAS_NODE_TYPES.imageGen,
          data: { displayName: "图片输入", imageUrl: "/static/input.png" },
        },
        {
          type: "create_node",
          client_id: "text_output",
          node_type: CANVAS_NODE_TYPES.textAnnotation,
          data: { displayName: "生成文本", content: "根据上游图片生成描述文本。" },
        },
        {
          type: "create_edge",
          source: "image_input",
          target: "text_output",
          link_type: "media_input_for",
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [], []);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("accepts legacy source media edge aliases", () => {
    const source = node({
      id: "source",
      type: CANVAS_NODE_TYPES.imageGen,
      data: { imageUrl: "/static/source.png" },
    });
    const target = node({
      id: "target",
      type: CANVAS_NODE_TYPES.video,
      data: { prompt: "" },
    });
    const envelopes = ["source_media_for", "visual_reference_for"].map((linkType) => ({
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "create_edge",
          source: "source",
          target: "target",
          link_type: linkType,
        },
      ],
    })) as CanvasChatCommandEnvelope[];

    const result = validateCanvasChatCommandEnvelopes(envelopes, [source, target], []);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("requires link_type on create_edge commands", () => {
    const source = node({
      id: "source",
      type: CANVAS_NODE_TYPES.textAnnotation,
      data: { content: "prompt", semanticOutputRole: "input_text" },
    });
    const target = node({
      id: "target",
      type: CANVAS_NODE_TYPES.imageGen,
      data: { prompt: "" },
    });
    const envelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "create_edge",
          source: "source",
          target: "target",
        },
      ],
    } as CanvasChatCommandEnvelope;

    const result = validateCanvasChatCommandEnvelopes([envelope], [source, target], []);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toContain(
      "create_edge.link_type is required and must be one of: context_for, prompt_for, dependency_for, media_input_for, derived_from, composition_input_for",
    );
  });

  it("explains that auto ids are only temporary client aliases", () => {
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "add_next_node",
          client_id: "",
          source_node_id: "auto:5",
          node_type: CANVAS_NODE_TYPES.audio,
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [], []);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("source node not found: auto:5"),
        expect.stringContaining("auto:* ids are temporary client_id aliases"),
      ]),
    );
  });

  it("accepts frontend node actions exposed by the node action catalog", () => {
    const imageNode = node({
      id: "image-node",
      type: CANVAS_NODE_TYPES.imageGen,
      data: { prompt: "猫吃鱼" },
    });
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "run_node_action",
          node_id: "image-node",
          action: "generate_image",
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [imageNode], []);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects run_skill when required upstream image inputs are still pending", () => {
    const beatNode = node({
      id: "beat-node",
      type: CANVAS_NODE_TYPES.beatContext,
      data: { beat_context: { episode: 1, beat: 1 } },
    });
    const pendingBackgroundNode = node({
      id: "pending-background",
      type: CANVAS_NODE_TYPES.imageGen,
      data: { prompt: "背景图生成中" },
    });
    const skillNode = node({
      id: "skill-node",
      type: CANVAS_NODE_TYPES.skill,
      data: { skill_id: "freezone.sketch_from_context" },
    });
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "run_node_action",
          node_id: "skill-node",
          action: "run_skill",
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes(
      [envelope],
      [beatNode, pendingBackgroundNode, skillNode],
      [
        {
          id: "edge-beat",
          source: "beat-node",
          target: "skill-node",
          targetHandle: "beat_context",
          data: { role: "beat_context" },
        },
        {
          id: "edge-background",
          source: "pending-background",
          target: "skill-node",
          targetHandle: "background",
          data: { role: "background" },
        },
      ],
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain("action preconditions are not satisfied");
    expect(result.issues[0]?.message).toContain("background");
    expect(result.issues[0]?.message).toContain("imageUrl");
  });

  it("rejects 3GS generation on director world nodes without an image upstream", () => {
    const worldNode = node({
      id: "world-node",
      type: CANVAS_NODE_TYPES.threeDWorld,
      data: { displayName: "导演世界" },
    });
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "run_node_action",
          node_id: "world-node",
          action: "generate_3gs_world",
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [worldNode], []);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toBe("action not available on node: generate_3gs_world");
  });

  it("accepts 3GS generation when a director world has an image upstream", () => {
    const imageNode = node({
      id: "image-node",
      type: CANVAS_NODE_TYPES.imageGen,
      data: { imageUrl: "/static/image.png" },
    });
    const worldNode = node({
      id: "world-node",
      type: CANVAS_NODE_TYPES.threeDWorld,
      data: { displayName: "导演世界" },
    });
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "run_node_action",
          node_id: "world-node",
          action: "generate_3gs_world",
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes(
      [envelope],
      [imageNode, worldNode],
      [{ id: "edge-world", source: "image-node", target: "world-node" }],
    );

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("validates run_workflow node references", () => {
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "run_workflow",
          node_ids: ["missing-node"],
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [], []);

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toBe("node not found: missing-node");
  });

  it("accepts video frontend node actions exposed by the node action catalog", () => {
    const videoNode = node({
      id: "video-node",
      type: CANVAS_NODE_TYPES.video,
      data: { videoUrl: "/static/video.mp4", prompt: "镜头推进" },
    });
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "run_node_action",
          node_id: "video-node",
          action: "open_video_upscale_tool",
        },
        {
          type: "run_node_action",
          node_id: "video-node",
          action: "open_video_subtitle_erase_smart",
        },
        {
          type: "run_node_action",
          node_id: "video-node",
          action: "run_audio_separate",
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [videoNode], []);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects unsupported video upscale parameters", () => {
    const videoNode = node({
      id: "video-node",
      type: CANVAS_NODE_TYPES.video,
      data: { videoUrl: "/static/video.mp4", prompt: "镜头推进" },
    });
    const envelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "run_node_action",
          node_id: "video-node",
          action: "open_video_upscale_tool",
          parameters: {
            resolution: "8k",
            denoise: "strong",
          },
        },
      ],
    };

    const result = validateCanvasChatCommandEnvelopes([envelope], [videoNode], []);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message)).toEqual([
      "unsupported video upscale resolution: 8k",
      "unsupported video upscale denoise: strong",
    ]);
  });

  it("accepts audio download and rejects unsupported audio download formats", () => {
    const audioNode = node({
      id: "audio-node",
      type: CANVAS_NODE_TYPES.audio,
      data: { audioUrl: "/static/audio.m4a" },
    });
    const validEnvelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "run_node_action",
          node_id: "audio-node",
          action: "download_audio",
        },
      ],
    };
    const invalidEnvelope: CanvasChatCommandEnvelope = {
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      commands: [
        {
          type: "run_node_action",
          node_id: "audio-node",
          action: "download_audio",
          parameters: { format: "flac" },
        },
      ],
    };

    const validResult = validateCanvasChatCommandEnvelopes([validEnvelope], [audioNode], []);
    const invalidResult = validateCanvasChatCommandEnvelopes([invalidEnvelope], [audioNode], []);

    expect(validResult.ok).toBe(true);
    expect(validResult.issues).toEqual([]);
    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.issues[0]?.message).toBe("unsupported audio download format: flac");
  });
});
