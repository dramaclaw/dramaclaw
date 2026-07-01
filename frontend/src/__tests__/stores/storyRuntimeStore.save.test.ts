import { beforeEach, describe, expect, it } from 'vitest';
import { compileGraphToInk } from '@/features/canvas/story/compileGraphToInk';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';
import { storySaveKey, readStorySave, writeStorySave } from '@/features/canvas/story/storySave';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';

function v(id: string, url: string, start?: 'start'): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 },
    data: { videoUrl: url, aspectRatio: '16:9', ...(start ? { storyRole: start } : {}) } } as CanvasNode;
}
function e(s: string, t: string, text: string, order: number): CanvasEdge {
  return { id: `${s}->${t}`, source: s, target: t, type: STORY_CHOICE_EDGE_TYPE,
    data: { choiceText: text, order } } as CanvasEdge;
}
function fixture() {
  return compileGraphToInk(
    [v('intro', 'intro.mp4', 'start'), v('meet', 'meet.mp4')],
    [e('intro', 'meet', '去见面', 0)],
  );
}

const KEY = storySaveKey('cv1', 'g1');

describe('storyRuntimeStore 存档/续玩', () => {
  beforeEach(() => {
    localStorage.clear();
    useStoryRuntimeStore.getState().exitPlay();
  });

  it('无 saveKey 时退化为现状:直接 advance、不存档', () => {
    useStoryRuntimeStore.getState().enterPlay(fixture());
    const s = useStoryRuntimeStore.getState();
    expect(s.saveKey).toBeNull();
    expect(s.resumeAvailable).toBe(false);
    expect(s.currentClipUrl).toBe('intro.mp4');
  });

  it('带 saveKey 首次进入:无存档则直接 advance 并写入初始存档', () => {
    useStoryRuntimeStore.getState().enterPlay(fixture(), { saveKey: KEY });
    const s = useStoryRuntimeStore.getState();
    expect(s.saveKey).toBe(KEY);
    expect(s.resumeAvailable).toBe(false);
    expect(s.currentClipUrl).toBe('intro.mp4');
    expect(readStorySave(KEY)).toBeTruthy();
  });

  it('choose 后自动更新存档', () => {
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(fixture(), { saveKey: KEY });
    const initial = readStorySave(KEY);
    store.choose(0);
    const afterChoose = readStorySave(KEY);
    expect(afterChoose).toBeTruthy();
    expect(afterChoose).not.toBe(initial);
  });

  it('再次进入若有存档:不 advance,resumeAvailable=true,等玩家决定', () => {
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(fixture(), { saveKey: KEY });
    store.choose(0); // 存档推进到 meet
    store.exitPlay();

    store.enterPlay(fixture(), { saveKey: KEY });
    const s = useStoryRuntimeStore.getState();
    expect(s.mode).toBe('play');
    expect(s.resumeAvailable).toBe(true);
    expect(s.phase).toBe('idle');
    expect(s.currentClipUrl).toBeNull();
  });

  it('resumeSaved 恢复到存档点并返回 true', () => {
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(fixture(), { saveKey: KEY });
    store.choose(0); // 走到 meet(结局)
    store.exitPlay();
    store.enterPlay(fixture(), { saveKey: KEY });

    const ok = useStoryRuntimeStore.getState().resumeSaved();
    const s = useStoryRuntimeStore.getState();
    expect(ok).toBe(true);
    expect(s.resumeAvailable).toBe(false);
    expect(s.currentClipUrl).toBe('meet.mp4');
    expect(s.phase).toBe('ended');
  });

  it('startFresh 忽略存档回到起点并覆盖存档', () => {
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(fixture(), { saveKey: KEY });
    store.choose(0);
    store.exitPlay();
    store.enterPlay(fixture(), { saveKey: KEY });
    expect(useStoryRuntimeStore.getState().resumeAvailable).toBe(true);

    store.startFresh();
    const s = useStoryRuntimeStore.getState();
    expect(s.resumeAvailable).toBe(false);
    expect(s.currentClipUrl).toBe('intro.mp4');
    expect(s.phase).toBe('playing');
  });

  it('损坏存档:resumeSaved 不抛、清档、回起点并返回 false', () => {
    writeStorySave(KEY, 'not-json{');
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(fixture(), { saveKey: KEY });
    expect(useStoryRuntimeStore.getState().resumeAvailable).toBe(true);

    let ok: boolean | undefined;
    expect(() => { ok = store.resumeSaved(); }).not.toThrow();
    const s = useStoryRuntimeStore.getState();
    expect(ok).toBe(false);
    expect(s.resumeAvailable).toBe(false);
    expect(s.currentClipUrl).toBe('intro.mp4');
  });

  it('exitPlay 保留存档(下次可续玩)', () => {
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(fixture(), { saveKey: KEY });
    store.choose(0);
    store.exitPlay();
    expect(readStorySave(KEY)).toBeTruthy();
  });

  it('restart 覆盖存档为起点', () => {
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(fixture(), { saveKey: KEY });
    store.choose(0);
    store.restart();
    expect(useStoryRuntimeStore.getState().currentClipUrl).toBe('intro.mp4');
    // 覆盖后再退出重进应直接续到起点态(此处仅验证存档仍存在且可被后续 resume 读到)
    expect(readStorySave(KEY)).toBeTruthy();
  });
});
