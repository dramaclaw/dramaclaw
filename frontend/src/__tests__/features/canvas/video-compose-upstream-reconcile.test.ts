// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildInitialTimeline,
  reconcileDraftWithUpstream,
} from '@/features/canvas/compose/VideoComposeModal';
import { orderedComposeSeedNodeIds } from '@/features/canvas/compose/composeInputOrdering';
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  AUDIO_TRACK_ID,
  type ComposeTimelineState,
} from '@/features/canvas/compose/timelineModel';
import { useCanvasStore } from '@/stores/canvasStore';

function audioNode(audioUrl: string): CanvasNode {
  return {
    id: 'audio-1',
    type: CANVAS_NODE_TYPES.audio,
    position: { x: 0, y: 0 },
    data: {
      audioUrl,
      displayName: '旁白',
      durationMs: null,
    },
  } as CanvasNode;
}

function workflowNode(
  id: string,
  type: typeof CANVAS_NODE_TYPES.video | typeof CANVAS_NODE_TYPES.audio,
  instance: number,
  timelineRole?: string,
  audioKind?: 'speech' | 'music',
): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      ...(type === CANVAS_NODE_TYPES.video
        ? { videoUrl: `/${id}.mp4`, durationMs: 5_000 }
        : { audioUrl: `/${id}.mp3`, durationMs: 2_000 }),
      workflowInstanceId: 'workflow-1',
      ...(audioKind ? { audioKind } : {}),
      workflowCatalog: {
        stepInstance: instance,
        ...(timelineRole ? { timelineRole } : {}),
      },
    },
  } as CanvasNode;
}

function draft(sourceUrl: string): ComposeTimelineState {
  return {
    resolution: '1080p',
    tracks: [{
      id: AUDIO_TRACK_ID,
      kind: 'audio',
      clips: [{
        id: 'clip-1',
        nodeId: 'audio-1',
        kind: 'audio',
        sourceUrl,
        displayName: '旁白',
        thumbUrl: null,
        durationMs: 79_000,
        timelineStartMs: 1_500,
        trimStartMs: 2_000,
        trimEndMs: 70_000,
        volume: 0.6,
        muted: false,
        speed: 1.25,
      }],
    }],
  };
}

describe('reconcileDraftWithUpstream', () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it('replaces a stale draft source when the same audio node is regenerated', () => {
    useCanvasStore.getState().setCanvasData([audioNode('/new.mp3')], []);

    const result = reconcileDraftWithUpstream(draft('/old.mp3'), ['audio-1']);
    const clip = result.tracks[0].clips[0];

    expect(clip.sourceUrl).toBe('/new.mp3');
    expect(clip.durationMs).toBeNull();
    expect(clip.trimStartMs).toBe(0);
    expect(clip.trimEndMs).toBe(5_000);
    expect(clip.timelineStartMs).toBe(1_500);
    expect(clip.volume).toBe(0.6);
    expect(clip.speed).toBe(1.25);
  });

  it('preserves edits when the upstream source has not changed', () => {
    useCanvasStore.getState().setCanvasData([audioNode('/same.mp3')], []);

    const result = reconcileDraftWithUpstream(draft('/same.mp3'), ['audio-1']);
    const clip = result.tracks[0].clips[0];

    expect(clip.trimStartMs).toBe(2_000);
    expect(clip.trimEndMs).toBe(70_000);
  });

  it('aligns shot voices to matching video starts and keeps BGM on a separate track', () => {
    const nodes = [
      workflowNode('video-1', CANVAS_NODE_TYPES.video, 1),
      workflowNode('video-2', CANVAS_NODE_TYPES.video, 2),
      workflowNode('voice-1', CANVAS_NODE_TYPES.audio, 1, 'shot_voice'),
      workflowNode('voice-2', CANVAS_NODE_TYPES.audio, 2, 'shot_voice'),
      workflowNode('bgm', CANVAS_NODE_TYPES.audio, 1, 'background_music'),
    ];
    useCanvasStore.getState().setCanvasData(nodes, []);

    const result = buildInitialTimeline(nodes.map((node) => node.id));
    const audioTracks = result.tracks.filter((track) => track.kind === 'audio');
    const voiceTrack = audioTracks.find((track) => track.id === AUDIO_TRACK_ID);
    const bgmTrack = audioTracks.find((track) => track.id.endsWith('background_music'));

    expect(voiceTrack?.clips.map((clip) => clip.timelineStartMs)).toEqual([0, 5_000]);
    expect(bgmTrack?.clips).toHaveLength(1);
    expect(bgmTrack?.clips[0].timelineStartMs).toBe(0);
    expect(bgmTrack?.clips[0].volume).toBe(0.25);
    expect(bgmTrack?.clips[0].trimEndMs).toBe(2_000);
  });

  it('normalizes dynamic workflow voiceover and music timeline roles', () => {
    const nodes = [
      workflowNode('video-1', CANVAS_NODE_TYPES.video, 1),
      workflowNode('voice-1', CANVAS_NODE_TYPES.audio, 1, 'voiceover'),
      workflowNode('bgm', CANVAS_NODE_TYPES.audio, 1, 'music'),
    ];
    nodes[2].data.durationMs = 30_000;
    useCanvasStore.getState().setCanvasData(nodes, []);

    const result = buildInitialTimeline(nodes.map((node) => node.id));
    const voiceTrack = result.tracks.find((track) => track.id === AUDIO_TRACK_ID);
    const bgmTrack = result.tracks.find((track) => track.id.endsWith('background_music'));

    expect(voiceTrack?.clips[0].timelineStartMs).toBe(0);
    expect(bgmTrack?.clips[0].timelineStartMs).toBe(0);
    expect(bgmTrack?.clips[0].volume).toBe(0.25);
    expect(bgmTrack?.clips[0].trimEndMs).toBe(5_000);
  });

  it('infers BGM from audioKind and keeps ordinary voiceover at 0ms', () => {
    const nodes = [
      workflowNode('video-1', CANVAS_NODE_TYPES.video, 1),
      workflowNode('voice', CANVAS_NODE_TYPES.audio, 1, undefined, 'speech'),
      workflowNode('bgm', CANVAS_NODE_TYPES.audio, 1, undefined, 'music'),
    ];
    nodes[2].data.durationMs = 30_000;
    useCanvasStore.getState().setCanvasData(nodes, []);

    const result = buildInitialTimeline(nodes.map((node) => node.id));
    const voiceTrack = result.tracks.find((track) => track.id === AUDIO_TRACK_ID);
    const bgmTrack = result.tracks.find((track) => track.id.endsWith('background_music'));

    expect(voiceTrack?.clips[0].timelineStartMs).toBe(0);
    expect(bgmTrack?.clips[0].timelineStartMs).toBe(0);
    expect(bgmTrack?.clips[0].volume).toBe(0.25);
    expect(bgmTrack?.clips[0].trimEndMs).toBe(5_000);
  });

  it('keeps ordinary mainline music on the standard audio track', () => {
    const video = {
      id: 'video-mainline',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      data: { videoUrl: '/mainline.mp4', durationMs: 5_000 },
    } as CanvasNode;
    const music = {
      ...audioNode('/music.mp3'),
      data: {
        ...audioNode('/music.mp3').data,
        audioKind: 'music',
        displayName: '广告配乐',
        durationMs: 30_000,
      },
    } as CanvasNode;
    useCanvasStore.getState().setCanvasData([video, music], []);

    const result = buildInitialTimeline([video.id, music.id]);
    const standardAudio = result.tracks.find((track) => track.id === AUDIO_TRACK_ID);
    const bgmTrack = result.tracks.find((track) => track.id.endsWith('background_music'));

    expect(bgmTrack).toBeUndefined();
    expect(standardAudio?.clips[0].timelineStartMs).toBe(0);
    expect(standardAudio?.clips[0].volume).toBe(1);
    expect(standardAudio?.clips[0].trimEndMs).toBe(30_000);
  });

  it('preserves a legacy mixed audio track without implicit migration', () => {
    const voice = workflowNode(
      'voice',
      CANVAS_NODE_TYPES.audio,
      1,
      undefined,
      'speech',
    );
    const bgm = workflowNode(
      'bgm',
      CANVAS_NODE_TYPES.audio,
      1,
      undefined,
      'music',
    );
    bgm.data.durationMs = 30_000;
    useCanvasStore.getState().setCanvasData([voice, bgm], []);
    const seeded = buildInitialTimeline(['voice', 'bgm']);
    const voiceClip = seeded.tracks
      .find((track) => track.id === AUDIO_TRACK_ID)!
      .clips[0];
    const bgmClip = seeded.tracks
      .find((track) => track.id.endsWith('background_music'))!
      .clips[0];
    const legacyDraft: ComposeTimelineState = {
      ...seeded,
      tracks: [{
        id: AUDIO_TRACK_ID,
        kind: 'audio',
        clips: [
          { ...bgmClip, timelineStartMs: 0, volume: 1 },
          { ...voiceClip, timelineStartMs: 2_000 },
        ],
      }],
    };

    const result = reconcileDraftWithUpstream(legacyDraft, ['voice', 'bgm']);
    const preservedAudio = result.tracks.find((track) => track.id === AUDIO_TRACK_ID);
    const migratedBgm = result.tracks.find((track) =>
      track.id.endsWith('background_music'));

    expect(preservedAudio?.clips.map((clip) => clip.timelineStartMs)).toEqual([0, 2_000]);
    expect(preservedAudio?.clips.map((clip) => clip.volume)).toEqual([1, 1]);
    expect(migratedBgm).toBeUndefined();
  });
});

describe('orderedComposeSeedNodeIds', () => {
  it('prefers dynamic workflow plan order over canvas layout order', () => {
    const nodes = [
      workflowNode('shot-3', CANVAS_NODE_TYPES.video, 3),
      workflowNode('shot-2', CANVAS_NODE_TYPES.video, 2),
      workflowNode('shot-4', CANVAS_NODE_TYPES.video, 4),
      workflowNode('shot-1', CANVAS_NODE_TYPES.video, 1),
    ];
    nodes.forEach((node, index) => {
      node.position.y = index * 100;
      node.data.workflowPlanNodeId = node.id;
    });

    expect(orderedComposeSeedNodeIds(nodes, [
      'shot-1',
      'shot-2',
      'shot-3',
      'shot-4',
    ])).toEqual(['shot-1', 'shot-2', 'shot-3', 'shot-4']);
  });
});
