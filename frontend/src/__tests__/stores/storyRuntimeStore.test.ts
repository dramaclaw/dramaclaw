import { beforeEach, describe, expect, it } from 'vitest';
import { compileGraphToInk } from '@/features/canvas/story/compileGraphToInk';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';

function v(id: string, url: string, start?: 'start'): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 },
    data: { videoUrl: url, aspectRatio: '16:9', ...(start ? { storyRole: start } : {}) } } as CanvasNode;
}
function e(s: string, t: string, text: string, order: number): CanvasEdge {
  return { id: `${s}->${t}`, source: s, target: t, type: STORY_CHOICE_EDGE_TYPE,
    data: { choiceText: text, order } } as CanvasEdge;
}

describe('storyRuntimeStore', () => {
  beforeEach(() => useStoryRuntimeStore.getState().exitPlay());

  it('enterPlay 进入起点片段并暴露选项', () => {
    const compiled = compileGraphToInk(
      [v('intro', 'intro.mp4', 'start'), v('meet', 'meet.mp4')],
      [e('intro', 'meet', '去见面', 0)],
    );
    useStoryRuntimeStore.getState().enterPlay(compiled);

    const s = useStoryRuntimeStore.getState();
    expect(s.mode).toBe('play');
    expect(s.currentClipUrl).toBe('intro.mp4');
    expect(s.phase).toBe('playing');
    expect(s.currentChoices.map((c) => c.text)).toEqual(['去见面']);
  });

  it('choose 推进到下一片段,叶子节点进入 ended', () => {
    const compiled = compileGraphToInk(
      [v('intro', 'intro.mp4', 'start'), v('meet', 'meet.mp4')],
      [e('intro', 'meet', '去见面', 0)],
    );
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(compiled);
    store.choose(0);

    const s = useStoryRuntimeStore.getState();
    expect(s.currentClipUrl).toBe('meet.mp4');
    expect(s.phase).toBe('ended');
    expect(s.currentChoices).toHaveLength(0);
  });

  it('叶子结局暴露 currentEnding(title=旁白,label=结局标);非结局为 null', () => {
    const leaf = {
      id: 'meet',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      data: { videoUrl: 'meet.mp4', aspectRatio: '16:9', narration: '宠冠后宫', endingLabel: 'GE' },
    } as CanvasNode;
    const compiled = compileGraphToInk(
      [v('intro', 'intro.mp4', 'start'), leaf],
      [e('intro', 'meet', '去见面', 0)],
    );
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(compiled);
    expect(useStoryRuntimeStore.getState().currentEnding).toBeNull(); // 起点非结局
    store.choose(0);
    expect(useStoryRuntimeStore.getState().currentEnding).toEqual({ title: '宠冠后宫', label: 'GE' });
  });

  it('restart 回到起点', () => {
    const compiled = compileGraphToInk(
      [v('intro', 'intro.mp4', 'start'), v('meet', 'meet.mp4')],
      [e('intro', 'meet', '去见面', 0)],
    );
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(compiled);
    store.choose(0);
    store.restart();
    expect(useStoryRuntimeStore.getState().currentClipUrl).toBe('intro.mp4');
  });

  it('exitPlay 回到编辑模式并清空运行态', () => {
    const store = useStoryRuntimeStore.getState();
    store.exitPlay();
    const s = useStoryRuntimeStore.getState();
    expect(s.mode).toBe('edit');
    expect(s.story).toBeNull();
  });

  it('enterPlay 收到损坏 ink 时进入 error 相位且清空 story', () => {
    // 先成功进入 play，产生非空 story，再用坏 ink 触发 compile error
    const compiled = compileGraphToInk(
      [v('intro', 'intro.mp4', 'start'), v('meet', 'meet.mp4')],
      [e('intro', 'meet', '去见面', 0)],
    );
    useStoryRuntimeStore.getState().enterPlay(compiled);
    expect(useStoryRuntimeStore.getState().story).not.toBeNull();

    // ink 内容含非法语法：函数调用括号不匹配，强制 Compiler 抛错
    useStoryRuntimeStore.getState().enterPlay({ ink: '~ badFunc(', clipByNodeId: {}, knotByNodeId: {}, choiceTimeByNodeId: {}, defaultChoiceIndexByNodeId: {}, endingByNodeId: {}, warnings: [], variables: [] });
    const s = useStoryRuntimeStore.getState();
    expect(s.phase).toBe('error');
    expect(s.error).toBeTruthy();
    expect(s.story).toBeNull();
  });

  it('currentVariables 反映效果累加(供 HUD 显示)', () => {
    const nodes = [v('intro', 'intro.mp4', 'start'), v('meet', 'meet.mp4')];
    const edges: CanvasEdge[] = [
      { id: 'intro->meet', source: 'intro', target: 'meet', type: STORY_CHOICE_EDGE_TYPE,
        data: { choiceText: '夸她', order: 0, effects: [{ var: 'fav', delta: 3 }] } } as CanvasEdge,
    ];
    const compiled = compileGraphToInk(nodes, edges, [{ name: 'fav', label: '好感度', initial: 0 }]);
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(compiled);
    // 起点:好感度初始 0
    expect(useStoryRuntimeStore.getState().currentVariables).toEqual([{ name: 'fav', label: '好感度', value: 0 }]);
    store.choose(0); // 夸她 → 好感度 +3
    expect(useStoryRuntimeStore.getState().currentVariables).toEqual([{ name: 'fav', label: '好感度', value: 3 }]);
  });
});
