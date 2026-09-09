// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import type { PushResult, PushTarget } from "@/api/push";
import { nodeDataAfterCommittedSlot } from "@/features/freezone/commit/committedNodePatch";
import { zhT } from "../../helpers/i18n-fixtures";

// Regression guard for the SHARED commit-node patch that the Director World
// rework made apply to NON-director-world commits too (image/video/audio/
// identity/scene image slots). The Director World logic is covered elsewhere;
// these cases pin the per-kind patch shape so a future DW change can't silently
// corrupt how a committed image/video/audio/identity node is rewritten.

function result(targetUrl: string): Pick<PushResult, "target_path" | "target_url"> {
  return { target_path: targetUrl.replace(/^.*\/static\//, ""), target_url: targetUrl };
}

describe("nodeDataAfterCommittedSlot — non-director-world targets", () => {
  it("video → videoUrl patch + video context", () => {
    const target: PushTarget = { kind: "video", episode: 1, beat: 2 };
    const patch = nodeDataAfterCommittedSlot(
      { videoUrl: "/freezone/tmp.mp4" },
      target,
      result("/static/proj/episodes/1/beats/2/video.mp4"),
      "proj",
      zhT,
    );
    expect(patch).toMatchObject({
      videoUrl: "/static/proj/episodes/1/beats/2/video.mp4",
      slot_target: target,
      committed_slot_url: "/static/proj/episodes/1/beats/2/video.mp4",
      mainline_context: [{ kind: "video", projectId: "proj", episode: 1, beat: 2 }],
    });
    // must NOT leak an imageUrl/audioUrl onto a video node
    expect(patch).not.toHaveProperty("audioUrl");
  });

  it("beat_audio → audioUrl/url patch + audio context", () => {
    const target: PushTarget = { kind: "beat_audio", episode: 3, beat: 4 };
    const patch = nodeDataAfterCommittedSlot(
      { audioUrl: "/freezone/tmp.wav" },
      target,
      result("/static/proj/episodes/3/beats/4/audio.wav"),
      "proj",
      zhT,
    );
    expect(patch).toMatchObject({
      audioUrl: "/static/proj/episodes/3/beats/4/audio.wav",
      url: "/static/proj/episodes/3/beats/4/audio.wav",
      slot_target: target,
      mainline_context: [{ kind: "audio", projectId: "proj", episode: 3, beat: 4 }],
    });
  });

  it("identity → imageUrl patch + identity context", () => {
    const target: PushTarget = { kind: "identity", character: "Alice", identity_id: "id-1" };
    const patch = nodeDataAfterCommittedSlot(
      { imageUrl: "/freezone/tmp.png" },
      target,
      result("/static/proj/characters/Alice/id-1.png"),
      "proj",
      zhT,
    );
    expect(patch).toMatchObject({
      imageUrl: "/static/proj/characters/Alice/id-1.png",
      previewImageUrl: "/static/proj/characters/Alice/id-1.png",
      slot_target: target,
      mainline_context: [{ kind: "identity", projectId: "proj", character: "Alice", identityId: "id-1" }],
    });
  });

  it("scene image slot (scene_master) → imageUrl patch + scene context", () => {
    const target: PushTarget = { kind: "scene_master", scene_id: "hall" };
    const patch = nodeDataAfterCommittedSlot(
      { imageUrl: "/freezone/tmp.png" },
      target,
      result("/static/proj/scenes/hall/master.png"),
      "proj",
      zhT,
    );
    expect(patch).toMatchObject({
      imageUrl: "/static/proj/scenes/hall/master.png",
      slot_target: target,
      mainline_context: [{ kind: "scene", projectId: "proj", sceneId: "hall" }],
    });
  });

  it("candidate node (user_spawned) → relabels 已提交 and drops mainline_context", () => {
    const target: PushTarget = { kind: "frame", episode: 1, beat: 1 };
    const patch = nodeDataAfterCommittedSlot(
      { imageUrl: "/freezone/tmp.png", user_spawned: true, mainline_context: [{ kind: "scene" }] },
      target,
      result("/static/proj/episodes/1/beats/1/frame.png"),
      "proj",
      zhT,
    );
    expect(patch?.displayName).toMatch(/^已提交 ·/);
    expect(patch?.mainline_context).toBeUndefined();
  });

  it("empty target_url → no patch (null)", () => {
    const target: PushTarget = { kind: "frame", episode: 1, beat: 1 };
    expect(
      nodeDataAfterCommittedSlot({ imageUrl: "/x.png" }, target, { target_path: "", target_url: "" }, "proj", zhT),
    ).toBeNull();
  });

  it("scene_director_world target → null (state commit does not patch via this path)", () => {
    const target = { kind: "scene_director_world", scene_id: "hall" } as unknown as PushTarget;
    expect(nodeDataAfterCommittedSlot({}, target, result("/static/proj/x"), "proj", zhT)).toBeNull();
  });
});
