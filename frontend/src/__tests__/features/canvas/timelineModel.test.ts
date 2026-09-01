// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  activeClipAt,
  buildComposePayload,
  clipLengthMs,
  hasExportableClips,
  hasOverlappingVideoClips,
  overlappingVideoClipIds,
  layoutTrack,
  neighborBoundsMs,
  compactVideoTracks,
  packTrackClips,
  reorderIndexForDrag,
  timelineDurationMs,
  type ComposeClip,
  type ComposeTimelineState,
  type ComposeTrack,
} from "@/features/canvas/compose/timelineModel";

function clip(overrides: Partial<ComposeClip> = {}): ComposeClip {
  return {
    id: overrides.id ?? "c1",
    nodeId: overrides.nodeId ?? null,
    kind: overrides.kind ?? "video",
    sourceUrl: overrides.sourceUrl ?? "/static/u/p/a.mp4",
    displayName: overrides.displayName ?? null,
    thumbUrl: overrides.thumbUrl ?? null,
    durationMs: overrides.durationMs ?? 5000,
    timelineStartMs: overrides.timelineStartMs ?? 0,
    trimStartMs: overrides.trimStartMs ?? 0,
    trimEndMs: overrides.trimEndMs ?? 5000,
    volume: overrides.volume ?? 1,
    muted: overrides.muted ?? false,
    speed: overrides.speed ?? 1,
  };
}

function videoTrack(clips: ComposeClip[]): ComposeTrack {
  return { id: "track_video", kind: "video", clips };
}

describe("timelineModel", () => {
  it("clipLengthMs is trimEnd - trimStart, floored at 0", () => {
    expect(clipLengthMs(clip({ trimStartMs: 1000, trimEndMs: 4000 }))).toBe(3000);
    expect(clipLengthMs(clip({ trimStartMs: 4000, trimEndMs: 1000 }))).toBe(0);
  });

  it("layoutTrack orders clips by explicit timelineStartMs and skips zero-length", () => {
    const track = videoTrack([
      clip({ id: "a", timelineStartMs: 0, trimStartMs: 0, trimEndMs: 2000 }),
      clip({ id: "z", timelineStartMs: 1000, trimStartMs: 1000, trimEndMs: 1000 }), // zero length → skipped
      clip({ id: "b", timelineStartMs: 2000, trimStartMs: 500, trimEndMs: 3500 }), // 3000ms
    ]);
    const laid = layoutTrack(track);
    expect(laid.map((l) => l.clip.id)).toEqual(["a", "b"]);
    expect(laid[0]).toMatchObject({ timelineStartMs: 0, timelineEndMs: 2000 });
    expect(laid[1]).toMatchObject({ timelineStartMs: 2000, timelineEndMs: 5000 });
  });

  it("layoutTrack honors gaps and sorts out-of-order clips", () => {
    const track = videoTrack([
      clip({ id: "b", timelineStartMs: 3000, trimStartMs: 0, trimEndMs: 2000 }),
      clip({ id: "a", timelineStartMs: 0, trimStartMs: 0, trimEndMs: 2000 }),
    ]);
    const laid = layoutTrack(track);
    expect(laid.map((l) => l.clip.id)).toEqual(["a", "b"]);
    expect(laid[1]).toMatchObject({ timelineStartMs: 3000, timelineEndMs: 5000 });
    // 落在间隙（2000–3000）→ 无命中
    expect(activeClipAt(track, 2500)).toBeNull();
  });

  it("neighborBoundsMs returns adjacent edges around a clip", () => {
    const track = videoTrack([
      clip({ id: "a", timelineStartMs: 0, trimStartMs: 0, trimEndMs: 2000 }),
      clip({ id: "b", timelineStartMs: 3000, trimStartMs: 0, trimEndMs: 2000 }),
      clip({ id: "c", timelineStartMs: 6000, trimStartMs: 0, trimEndMs: 2000 }),
    ]);
    expect(neighborBoundsMs(track, "b")).toEqual({ prevEndMs: 2000, nextStartMs: 6000 });
    expect(neighborBoundsMs(track, "a")).toEqual({ prevEndMs: null, nextStartMs: 3000 });
    expect(neighborBoundsMs(track, "c")).toEqual({ prevEndMs: 5000, nextStartMs: null });
  });

  it("packTrackClips lays clips end-to-end from 0 with no gaps", () => {
    const packed = packTrackClips([
      clip({ id: "a", timelineStartMs: 999, trimStartMs: 0, trimEndMs: 2000 }), // 2000ms
      clip({ id: "b", timelineStartMs: 50, trimStartMs: 0, trimEndMs: 3000 }), // 3000ms
      clip({ id: "c", timelineStartMs: 0, trimStartMs: 0, trimEndMs: 1000 }), // 1000ms
    ]);
    // 保持数组顺序，timelineStartMs 依次累加，整条无缝
    expect(packed.map((c) => [c.id, c.timelineStartMs])).toEqual([
      ["a", 0],
      ["b", 2000],
      ["c", 5000],
    ]);
  });

  it("packTrackClips respects speed when computing timeline length", () => {
    const packed = packTrackClips([
      clip({ id: "a", trimStartMs: 0, trimEndMs: 4000, speed: 2 }), // 4000/2 = 2000ms
      clip({ id: "b", trimStartMs: 0, trimEndMs: 1000, speed: 1 }),
    ]);
    expect(packed.map((c) => c.timelineStartMs)).toEqual([0, 2000]);
  });

  it("reorderIndexForDrag picks insertion slot by dragged-clip center", () => {
    // 已无缝排布的 siblings：a[0,2000) b[2000,5000) c[5000,6000)
    const siblings = [
      clip({ id: "a", trimStartMs: 0, trimEndMs: 2000 }),
      clip({ id: "b", trimStartMs: 0, trimEndMs: 3000 }),
      clip({ id: "c", trimStartMs: 0, trimEndMs: 1000 }),
    ];
    const draggedLen = 1000;
    // 中心 = left + 500。落在 a 中心(1000)左侧 → 排到最前
    expect(reorderIndexForDrag(siblings, 0, draggedLen)).toBe(0);
    // 中心越过 a 中心(1000)、未到 b 中心(3500) → 插到 a 与 b 之间
    expect(reorderIndexForDrag(siblings, 1000, draggedLen)).toBe(1);
    // 中心越过 b 中心(3500)、未到 c 中心(5500) → 插到 b 与 c 之间
    expect(reorderIndexForDrag(siblings, 3500, draggedLen)).toBe(2);
    // 中心越过所有 → 追加到末尾
    expect(reorderIndexForDrag(siblings, 6000, draggedLen)).toBe(3);
    // 负的左缘按 0 处理 → 最前
    expect(reorderIndexForDrag(siblings, -500, draggedLen)).toBe(0);
  });

  it("compactVideoTracks ripple-closes gaps on the main video track only", () => {
    const state: ComposeTimelineState = {
      resolution: "1080p",
      tracks: [
        {
          id: "track_video",
          kind: "video",
          clips: [
            // 中间有空隙 + 乱序，应按时间顺序无缝补位
            clip({ id: "b", timelineStartMs: 5000, trimStartMs: 0, trimEndMs: 3000 }),
            clip({ id: "a", timelineStartMs: 0, trimStartMs: 0, trimEndMs: 2000 }),
          ],
        },
        {
          // 附加视频轨自由定位：用户摆在 10s 的片段不能被吸回 0（否则与主轨重叠）
          id: "track_extra",
          kind: "video",
          clips: [
            clip({ id: "x", timelineStartMs: 10000, trimStartMs: 0, trimEndMs: 1000 }),
          ],
        },
        {
          id: "track_audio",
          kind: "audio",
          clips: [
            // 音频自由定位：故意留空隙，应原样不动
            clip({ id: "m", kind: "audio", timelineStartMs: 4000, trimStartMs: 0, trimEndMs: 1000 }),
          ],
        },
      ],
    };
    const out = compactVideoTracks(state);
    const video = out.tracks[0];
    expect(video.clips.map((c) => [c.id, c.timelineStartMs])).toEqual([
      ["a", 0],
      ["b", 2000],
    ]);
    // 附加视频轨未被触碰（保持自由定位）
    expect(out.tracks[1].clips[0].timelineStartMs).toBe(10000);
    // 音频轨未被触碰
    expect(out.tracks[2].clips[0].timelineStartMs).toBe(4000);
  });

  it("timelineDurationMs is the max track end", () => {
    const state: ComposeTimelineState = {
      resolution: "1080p",
      tracks: [
        videoTrack([
          clip({ timelineStartMs: 0, trimEndMs: 4000 }),
          clip({ id: "c2", timelineStartMs: 4000, trimEndMs: 4000 }),
        ]), // ends 8000
        {
          id: "track_audio",
          kind: "audio",
          clips: [clip({ id: "au", kind: "audio", timelineStartMs: 0, trimEndMs: 3000 })],
        }, // 3000
      ],
    };
    expect(timelineDurationMs(state)).toBe(8000);
  });

  it("activeClipAt resolves the hit clip and source time", () => {
    const track = videoTrack([
      clip({ id: "a", timelineStartMs: 0, trimStartMs: 0, trimEndMs: 2000 }),
      clip({ id: "b", timelineStartMs: 2000, trimStartMs: 1000, trimEndMs: 4000 }), // 3000ms, source offset 1000
    ]);
    // playhead 500ms → first clip, source 500
    expect(activeClipAt(track, 500)).toMatchObject({
      laid: { clip: { id: "a" } },
      sourceMs: 500,
    });
    // playhead 2500ms → second clip (starts at 2000), offset 500 → source 1000 + 500
    expect(activeClipAt(track, 2500)).toMatchObject({
      laid: { clip: { id: "b" } },
      sourceMs: 1500,
    });
    // beyond end → null
    expect(activeClipAt(track, 9000)).toBeNull();
  });

  it("buildComposePayload maps ms→seconds and drops empty tracks", () => {
    const state: ComposeTimelineState = {
      resolution: "720p",
      tracks: [
        videoTrack([clip({ id: "a", trimStartMs: 1000, trimEndMs: 4000, volume: 0.8 })]),
        { id: "track_audio", kind: "audio", clips: [] }, // empty → dropped
      ],
    };
    const payload = buildComposePayload(state, {
      title: "T",
      canvasId: "cv",
      nodeId: "compose-a",
      fps: 24,
    });
    expect(payload.resolution).toBe("720p");
    expect(payload.nodeId).toBe("compose-a");
    expect(payload.fps).toBe(24);
    expect(payload.tracks).toHaveLength(1);
    expect(payload.tracks[0]).toMatchObject({ trackId: "track_video", kind: "video" });
    expect(payload.tracks[0].items[0]).toMatchObject({
      itemId: "a",
      timelineStart: 0,
      sourceStart: 1,
      sourceEnd: 4,
      volume: 0.8,
    });
  });

  it("speed shrinks timeline length and maps source time on playback", () => {
    // 4000ms source at 2× → 2000ms on the timeline.
    const fast = clip({ trimStartMs: 0, trimEndMs: 4000, speed: 2 });
    expect(clipLengthMs(fast)).toBe(2000);
    const track = videoTrack([fast]);
    expect(timelineDurationMs({ resolution: "1080p", tracks: [track] })).toBe(2000);
    // playhead 1000ms (mid) → source 2000ms (2× consumed).
    expect(activeClipAt(track, 1000)?.sourceMs).toBe(2000);
  });

  it("buildComposePayload carries per-clip speed", () => {
    const payload = buildComposePayload(
      { resolution: "1080p", tracks: [videoTrack([clip({ id: "a", speed: 1.5 })])] },
    );
    expect(payload.tracks[0].items[0].speed).toBe(1.5);
  });

  it("hasOverlappingVideoClips detects video time-overlap across tracks (audio ignored)", () => {
    const a = clip({ id: "a", kind: "video", timelineStartMs: 0, trimEndMs: 4000 }); // 0–4000
    // 同一时间另一条视频轨上的片段 → 重叠
    const b = clip({ id: "b", kind: "video", timelineStartMs: 2000, trimEndMs: 4000 }); // 2000–6000
    const overlap: ComposeTimelineState = {
      resolution: "1080p",
      tracks: [
        { id: "v1", kind: "video", clips: [a] },
        { id: "v2", kind: "video", clips: [b] },
      ],
    };
    expect(hasOverlappingVideoClips(overlap)).toBe(true);

    // 错开后不重叠
    const ok: ComposeTimelineState = {
      resolution: "1080p",
      tracks: [
        { id: "v1", kind: "video", clips: [a] },
        { id: "v2", kind: "video", clips: [clip({ id: "b", kind: "video", timelineStartMs: 4000, trimEndMs: 4000 })] },
      ],
    };
    expect(hasOverlappingVideoClips(ok)).toBe(false);

    // 音频重叠不算
    const audioOverlap: ComposeTimelineState = {
      resolution: "1080p",
      tracks: [
        { id: "a1", kind: "audio", clips: [clip({ id: "x", kind: "audio", timelineStartMs: 0, trimEndMs: 4000 })] },
        { id: "a2", kind: "audio", clips: [clip({ id: "y", kind: "audio", timelineStartMs: 1000, trimEndMs: 4000 })] },
      ],
    };
    expect(hasOverlappingVideoClips(audioOverlap)).toBe(false);
  });

  it("overlappingVideoClipIds returns exactly the conflicting clips", () => {
    const a = clip({ id: "a", kind: "video", timelineStartMs: 0, trimEndMs: 4000 }); // 0–4000
    const b = clip({ id: "b", kind: "video", timelineStartMs: 2000, trimEndMs: 4000 }); // 2000–6000 (overlaps a)
    const c = clip({ id: "c", kind: "video", timelineStartMs: 8000, trimEndMs: 4000 }); // 8000–12000 (clear)
    const state: ComposeTimelineState = {
      resolution: "1080p",
      tracks: [
        { id: "v1", kind: "video", clips: [a, c] },
        { id: "v2", kind: "video", clips: [b] },
      ],
    };
    const ids = overlappingVideoClipIds(state);
    expect([...ids].sort()).toEqual(["a", "b"]);
    expect(ids.has("c")).toBe(false);
  });

  it("hasExportableClips reflects non-zero clips", () => {
    expect(
      hasExportableClips({ resolution: "1080p", tracks: [videoTrack([clip()])] }),
    ).toBe(true);
    expect(
      hasExportableClips({
        resolution: "1080p",
        tracks: [videoTrack([clip({ trimStartMs: 1000, trimEndMs: 1000 })])],
      }),
    ).toBe(false);
  });
});
