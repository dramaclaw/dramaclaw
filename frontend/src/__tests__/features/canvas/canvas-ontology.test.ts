import { describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import {
  buildCanvasOntologySummary,
  buildCanvasOntologyContext,
  deriveCanvasOntologyLink,
  deriveCanvasOntologyObject,
} from "@/features/canvas/ontology/canvasOntology";

function node(partial: Partial<CanvasNode> & { id: string; type: CanvasNode["type"] }): CanvasNode {
  return {
    id: partial.id,
    type: partial.type,
    position: partial.position ?? { x: 0, y: 0 },
    data: partial.data ?? {},
  } as CanvasNode;
}

describe("canvas ontology", () => {
  it("derives ordinary canvas link types from node roles", () => {
    const beatContext = node({
      id: "beat-context",
      type: CANVAS_NODE_TYPES.beatContext,
      data: { content: "雨夜街口，角色回头" },
    });
    const sourceImage = node({
      id: "source-image",
      type: CANVAS_NODE_TYPES.imageGen,
      data: { imageUrl: "/image.png" },
    });
    const planningText = node({
      id: "planning-text",
      type: CANVAS_NODE_TYPES.textAnnotation,
      data: { content: "镜头规划" },
    });
    const imageGen = node({
      id: "image-gen",
      type: CANVAS_NODE_TYPES.imageGen,
      data: { prompt: "角色定妆" },
    });
    const video = node({
      id: "video",
      type: CANVAS_NODE_TYPES.video,
      data: { videoUrl: "/video.mp4" },
    });
    const compose = node({
      id: "compose",
      type: CANVAS_NODE_TYPES.videoCompose,
      data: {},
    });
    const exportImage = node({
      id: "export-image",
      type: CANVAS_NODE_TYPES.exportImage,
      data: { imageUrl: "/crop.png" },
    });
    const nodeById = new Map([
      [beatContext.id, beatContext],
      [sourceImage.id, sourceImage],
      [planningText.id, planningText],
      [imageGen.id, imageGen],
      [video.id, video],
      [compose.id, compose],
      [exportImage.id, exportImage],
    ]);

    expect(deriveCanvasOntologyLink(
      { id: "context-edge", source: beatContext.id, target: planningText.id },
      nodeById,
    )).toMatchObject({ link_type: "context_for" });
    expect(deriveCanvasOntologyLink(
      { id: "reference-edge", source: sourceImage.id, target: imageGen.id },
      nodeById,
    )).toMatchObject({ link_type: "media_input_for" });
    expect(deriveCanvasOntologyLink(
      { id: "media-edge", source: sourceImage.id, target: video.id },
      nodeById,
    )).toMatchObject({ link_type: "media_input_for" });
    expect(deriveCanvasOntologyLink(
      {
        id: "legacy-media-edge",
        source: sourceImage.id,
        target: video.id,
        data: { link_type: "source_media_for" },
      },
      nodeById,
    )).toMatchObject({ link_type: "media_input_for" });
    expect(deriveCanvasOntologyLink(
      { id: "compose-edge", source: video.id, target: compose.id },
      nodeById,
    )).toMatchObject({ link_type: "composition_input_for" });
    expect(deriveCanvasOntologyLink(
      { id: "derived-edge", source: sourceImage.id, target: exportImage.id },
      nodeById,
    )).toMatchObject({ link_type: "derived_from" });
  });

  it("derives mainline, candidate, action, and link ontology from canvas nodes", () => {
    const mainline = node({
      id: "mainline-frame",
      type: CANVAS_NODE_TYPES.imageGen,
      position: { x: 0, y: 0 },
      data: {
        displayName: "当前分镜",
        imageUrl: "/static/frame.png",
        preset_managed: true,
        slot_target: { kind: "frame", episode: 1, beat: 2 },
        mainline_context: [{ kind: "frame", episode: 1, beat: 2 }],
      },
    });
    const candidate = node({
      id: "candidate-frame",
      type: CANVAS_NODE_TYPES.imageGen,
      position: { x: 360, y: 0 },
      data: {
        displayName: "分镜候选",
        imageUrl: "/static/candidate.png",
        user_spawned: true,
        slot_target: { kind: "frame", episode: 1, beat: 2 },
        candidate_origin: { skill_id: "freezone.frame_from_context" },
      },
    });
    const action = node({
      id: "skill-node",
      type: CANVAS_NODE_TYPES.skill,
      position: { x: 720, y: 0 },
      data: {
        displayName: "从镜头上下文生成分镜",
        skill_id: "freezone.frame_from_context",
      },
    });
    const edge = {
      id: "edge-1",
      source: "mainline-frame",
      target: "skill-node",
      data: { edgeKind: "role_binding", role: "frame" },
    };
    const semanticSource = node({
      id: "story-text",
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 0, y: 240 },
      data: {
        title: "角色设定",
        content: "一位温柔坚定的公益主角",
      },
    });
    const generator = node({
      id: "image-node",
      type: CANVAS_NODE_TYPES.imageGen,
      position: { x: 360, y: 240 },
      data: {
        prompt: "角色形象图",
      },
    });
    const semanticEdge = {
      id: "edge-2",
      source: "story-text",
      target: "image-node",
      data: {},
    };

    expect(deriveCanvasOntologyObject(mainline)).toMatchObject({
      node_id: "mainline-frame",
      object_kind: "mainline",
      media_type: "image",
      preset_managed: true,
      pushable: false,
    });
    expect(deriveCanvasOntologyObject(candidate)).toMatchObject({
      node_id: "candidate-frame",
      object_kind: "candidate",
      pushable: true,
      user_spawned: true,
    });
    expect(deriveCanvasOntologyObject(action)).toMatchObject({
      node_id: "skill-node",
      object_kind: "action",
      action_id: "freezone.frame_from_context",
    });
    expect(deriveCanvasOntologyLink(edge)).toEqual({
      id: "edge-1",
      source: "mainline-frame",
      target: "skill-node",
      link_type: null,
    });
    expect(
      deriveCanvasOntologyLink(
        semanticEdge,
        new Map([
          ["story-text", semanticSource],
          ["image-node", generator],
        ]),
      ),
    ).toMatchObject({
      id: "edge-2",
      source: "story-text",
      target: "image-node",
      link_type: "prompt_for",
    });

    const explicitSemanticEdge = {
      id: "edge-3",
      source: "story-text",
      target: "image-node",
      data: {
        link_type: "prompt_for",
      },
    } as typeof semanticEdge;
    expect(
      deriveCanvasOntologyLink(
        explicitSemanticEdge,
        new Map([
          ["story-text", semanticSource],
          ["image-node", generator],
        ]),
      ),
    ).toMatchObject({
      id: "edge-3",
      link_type: "prompt_for",
    });

    const executableText = {
      ...semanticSource,
      id: "input-text",
      data: {
        displayName: "可执行图片提示词",
        content: "直接用于生成图片的提示词",
        semanticOutputRole: "input_text",
      },
    };
    const executableEdge = {
      id: "edge-4",
      source: "input-text",
      target: "image-node",
      data: {},
    } as typeof semanticEdge;
    expect(
      deriveCanvasOntologyLink(
        executableEdge,
        new Map([
          ["input-text", executableText],
          ["image-node", generator],
        ]),
      ),
    ).toMatchObject({
      id: "edge-4",
      link_type: "prompt_for",
    });

    const context = buildCanvasOntologyContext(
      [mainline, candidate, action, semanticSource, executableText, generator],
      [edge, semanticEdge],
      {
      canvasId: "canvas-a",
      selectedNodeIds: ["candidate-frame"],
      },
    );

    expect(context.schema_version).toBe("canvas_ontology_context.v1");
    expect(context.current_selection).toEqual(["candidate-frame"]);
    expect(context.objects[0]?.node_id).toBe("candidate-frame");
    expect(context.links).toHaveLength(2);
    expect(context.links.find((link) => link.id === "edge-2")).toMatchObject({
      link_type: "prompt_for",
    });
    expect(context.slots.map((slot) => slot.slot_kind)).toContain("frame");
    expect(context.objects.find((object) => object.node_id === "story-text")).toMatchObject({
      primary_output_role: null,
      accepted_input_roles: ["planning_text", "context_text"],
    });
    expect(context.objects.find((object) => object.node_id === "input-text")).toMatchObject({
      primary_output_role: "input_text",
      accepted_input_roles: ["planning_text", "context_text"],
    });
    expect(context.objects.find((object) => object.node_id === "image-node")).toMatchObject({
      primary_output_role: "image_output",
      accepted_input_roles: ["input_text", "context_text"],
    });
    expect(context.summary).toMatchObject({
      object_count: 6,
      link_count: 2,
      candidate_count: 1,
      action_count: 1,
      pushable_count: 1,
    });

    const summary = buildCanvasOntologySummary(context);
    expect(summary.schema_version).toBe("canvas_ontology_summary.v1");
    expect(summary.node_count).toBe(6);
    expect(summary.edge_count).toBe(2);
    expect(summary.selected_node_ids).toEqual(["candidate-frame"]);
    expect(summary.top_objects[0]?.node_id).toBe("candidate-frame");
    expect(summary.action_nodes).toEqual([
      {
        node_id: "skill-node",
        skill_id: "freezone.frame_from_context",
        action: "run_skill",
        command_type: "run_node_action",
        label: "从镜头上下文生成分镜",
        execution_state: null,
      },
    ]);
    expect(summary.pushable_candidates[0]).toMatchObject({
      node_id: "candidate-frame",
      slot_kind: "frame",
      label: "分镜候选",
      media_type: "image",
    });
  });

  it("describes director world nodes as model assets instead of ordinary images", () => {
    const world = node({
      id: "director-world",
      type: CANVAS_NODE_TYPES.threeDWorld,
      data: {
        displayName: "导演世界",
        plyUrl: "/static/world.sog",
        previewImageUrl: "/static/world-preview.png",
      },
    });

    expect(deriveCanvasOntologyObject(world)).toMatchObject({
      node_id: "director-world",
      node_type: CANVAS_NODE_TYPES.threeDWorld,
      media_type: "model",
    });
  });
});
