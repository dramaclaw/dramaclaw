import { beforeEach, describe, expect, it } from 'vitest';
import { compileGraphToInk } from '@/features/canvas/story/compileGraphToInk';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';
import { readStoryStats, statsKeyFromSaveKey } from '@/features/canvas/story/storyStats';
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
  it('实时生成使用独立的无存档运行态', () => {
    const compiled = compileGraphToInk(
      [v('intro', 'intro.mp4', 'start'), v('end', 'end.mp4')],
      [e('intro', 'end', '继续', 0)],
    );
    useStoryRuntimeStore.getState().enterPlay(compiled, {
      groupId: 'story-group',
      playKind: 'live',
    });

    const state = useStoryRuntimeStore.getState();
    expect(state.playKind).toBe('live');
    expect(state.groupId).toBe('story-group');
    expect(state.saveKey).toBeNull();
    expect(state.statsKey).toBeNull();
    expect(state.resumeAvailable).toBe(false);
  });

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

  it('保存选择阶段独立循环片段表，主视频地址保持不变', () => {
    const intro = v('intro', 'story.mp4', 'start');
    intro.data = { ...intro.data, choiceLoopVideoUrl: 'choice-loop.mp4' };
    const compiled = compileGraphToInk(
      [intro, v('meet', 'meet.mp4')],
      [e('intro', 'meet', '继续', 0)],
    );

    useStoryRuntimeStore.getState().enterPlay(compiled);
    const state = useStoryRuntimeStore.getState();
    expect(state.currentClipUrl).toBe('story.mp4');
    expect(state.choiceLoopClipByNodeId).toEqual({ intro: 'choice-loop.mp4' });
  });

  it('从编译后的 Ink choice tag 读取剧情反馈和语义状态箭头，不改变当前视频', () => {
    const edge = e('intro', 'meet', '接过手电筒', 0);
    edge.data = {
      ...edge.data,
      feedbackText: '她把手电筒递给了你。',
      effects: [{ var: 'trust', delta: 1 }],
    };
    const compiled = compileGraphToInk(
      [v('intro', 'intro.mp4', 'start'), v('meet', 'meet.mp4')],
      [edge],
      [{ name: 'trust', label: '信任', initial: 0 }],
    );
    useStoryRuntimeStore.getState().enterPlay(compiled);

    const s = useStoryRuntimeStore.getState();
    expect(s.error).toBeNull();
    expect(s.currentClipUrl).toBe('intro.mp4');
    expect(s.currentChoices[0]).toMatchObject({
      text: '接过手电筒',
      feedbackText: '她把手电筒递给了你。',
      stateChanges: [{ label: '信任', direction: 'up' }],
    });
  });

  it('从编译后的 Ink choice tag 读取物品锚定互动规格', () => {
    const edge = e('intro', 'meet', '拿起手电筒', 0);
    edge.data = {
      ...edge.data,
      interaction: {
        presentation: 'object-anchor',
        anchor: { x: 0.68, y: 0.64, objectLabel: '手电筒' },
        uiStyle: 'tag',
        motion: 'pulse',
      },
    };
    const compiled = compileGraphToInk(
      [v('intro', 'intro.mp4', 'start'), v('meet', 'meet.mp4')],
      [edge],
    );
    useStoryRuntimeStore.getState().enterPlay(compiled);

    expect(useStoryRuntimeStore.getState().currentChoices[0].interaction).toEqual({
      presentation: 'object-anchor',
      anchor: { x: 0.68, y: 0.64, objectLabel: '手电筒' },
      uiStyle: 'tag',
      motion: 'pulse',
      transition: 'fade',
    });
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

  it('片段结束后按布尔条件执行自动跳转，不生成玩家选项', () => {
    const automatic = {
      id: 'intro->open',
      source: 'intro',
      target: 'open',
      type: STORY_CHOICE_EDGE_TYPE,
      data: { choiceText: '', order: 0, transitionMode: 'automatic', condition: { flag: 'has_key', value: false } },
    } as CanvasEdge;
    const compiled = compileGraphToInk(
      [v('intro', 'intro.mp4', 'start'), v('open', 'open.mp4')],
      [automatic],
      [],
      [{ name: 'has_key', label: '已拿到钥匙', initial: false }],
    );
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(compiled);
    expect(useStoryRuntimeStore.getState().currentChoices).toEqual([]);
    expect(useStoryRuntimeStore.getState().phase).toBe('playing');
    store.advanceAutomatic();
    expect(useStoryRuntimeStore.getState().currentClipUrl).toBe('open.mp4');
    expect(useStoryRuntimeStore.getState().phase).toBe('ended');
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
    useStoryRuntimeStore.getState().enterPlay({ ink: '~ badFunc(', clipByNodeId: {}, choiceLoopClipByNodeId: {}, knotByNodeId: {}, choiceTimeByNodeId: {}, defaultChoiceIndexByNodeId: {}, endingByNodeId: {}, placeholderByNodeId: {}, choiceFeedbackById: {}, choiceStateChangesById: {}, choiceInteractionById: {}, warnings: [], variables: [] });
    const s = useStoryRuntimeStore.getState();
    expect(s.phase).toBe('error');
    expect(s.error).toBeTruthy();
    expect(s.story).toBeNull();
  });

  it('nextClipUrls 前瞻暴露当前各选项的后继片段 URL(针对性下一跳预取)', () => {
    const compiled = compileGraphToInk(
      [v('intro', 'intro.mp4', 'start'), v('a', 'a.mp4'), v('b', 'b.mp4')],
      [e('intro', 'a', '走左边', 0), e('intro', 'b', '走右边', 1)],
    );
    useStoryRuntimeStore.getState().enterPlay(compiled);
    expect([...useStoryRuntimeStore.getState().nextClipUrls].sort()).toEqual(['a.mp4', 'b.mp4']);
  });

  it('nextClipUrls 前瞻不破坏当前运行态,选择仍能正确推进', () => {
    const compiled = compileGraphToInk(
      [v('intro', 'intro.mp4', 'start'), v('a', 'a.mp4'), v('b', 'b.mp4')],
      [e('intro', 'a', '走左边', 0), e('intro', 'b', '走右边', 1)],
    );
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(compiled);
    // 前瞻(peek)后当前片段与选项应原封不动
    expect(useStoryRuntimeStore.getState().currentClipUrl).toBe('intro.mp4');
    expect(useStoryRuntimeStore.getState().currentChoices).toHaveLength(2);
    // 且实际选择仍走到正确后继(证明 peek 已恢复状态)
    store.choose(0);
    expect(useStoryRuntimeStore.getState().currentClipUrl).toBe('a.mp4');
  });

  it('叶子(无后继)节点 nextClipUrls 为空', () => {
    const compiled = compileGraphToInk(
      [v('intro', 'intro.mp4', 'start'), v('meet', 'meet.mp4')],
      [e('intro', 'meet', '去见面', 0)],
    );
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(compiled);
    store.choose(0); // 走到叶子 meet
    expect(useStoryRuntimeStore.getState().nextClipUrls).toEqual([]);
  });

  it('无视频占位节点(有选项)暴露 currentPlaceholder 供占位试玩;有视频时为 null', () => {
    const intro = {
      id: 'intro',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      data: { videoUrl: null, aspectRatio: '16:9', storyRole: 'start', narration: '雨夜,门铃响起', displayName: '开场' },
    } as CanvasNode;
    const compiled = compileGraphToInk(
      [intro, v('meet', 'meet.mp4')],
      [e('intro', 'meet', '开门', 0)],
    );
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(compiled);
    // 起点无视频(空串占位)+ 有选项 → 占位卡
    expect(useStoryRuntimeStore.getState().currentClipUrl).toBeFalsy();
    expect(useStoryRuntimeStore.getState().currentPlaceholder).toEqual({ text: '雨夜,门铃响起', label: '开场' });
    // 推进到有视频的节点 → 不再占位
    store.choose(0);
    expect(useStoryRuntimeStore.getState().currentClipUrl).toBe('meet.mp4');
    expect(useStoryRuntimeStore.getState().currentPlaceholder).toBeNull();
  });

  it('无旁白的占位节点仍暴露 currentPlaceholder(空文案,播放器兜底提示)', () => {
    const compiled = compileGraphToInk(
      [v('intro', ''), v('meet', 'meet.mp4')], // intro 无视频、无旁白
      [e('intro', 'meet', '继续', 0)],
    );
    useStoryRuntimeStore.getState().enterPlay(compiled);
    expect(useStoryRuntimeStore.getState().currentPlaceholder).toEqual({ text: '' });
  });

  it('试玩埋点:choose 记录选择分布,到达结局记录达成率(仅在有 saveKey 时)', () => {
    const saveKey = 'st.story.save.cvs.grp-stats';
    localStorage.clear();
    const leaf = {
      id: 'meet', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 },
      data: { videoUrl: 'meet.mp4', aspectRatio: '16:9', narration: '皆大欢喜', endingLabel: 'GE' },
    } as CanvasNode;
    const nodes = [
      { id: 'intro', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 },
        data: { videoUrl: 'intro.mp4', aspectRatio: '16:9', storyRole: 'start', displayName: '开场' } } as CanvasNode,
      leaf,
      v('other', 'other.mp4'),
    ];
    const edges = [e('intro', 'meet', '去见面', 0), e('intro', 'other', '不去', 1)];
    const compiled = compileGraphToInk(nodes, edges);
    const store = useStoryRuntimeStore.getState();

    store.enterPlay(compiled, { saveKey });
    store.choose(0); // 在 intro 选「去见面」→ 走到结局 meet

    const stats = readStoryStats(statsKeyFromSaveKey(saveKey)!);
    expect(stats.points.intro.label).toBe('开场');
    expect(stats.points.intro.options['0']).toEqual({ text: '去见面', count: 1 });
    expect(stats.endings.meet).toEqual({ title: '皆大欢喜', label: 'GE', count: 1 });
    expect(stats.totalRuns).toBe(1);
  });

  it('无 saveKey 时不写试玩统计', () => {
    localStorage.clear();
    const compiled = compileGraphToInk(
      [v('intro', 'intro.mp4', 'start'), v('meet', 'meet.mp4')],
      [e('intro', 'meet', '去见面', 0)],
    );
    const store = useStoryRuntimeStore.getState();
    store.enterPlay(compiled); // 无 saveKey
    store.choose(0);
    expect(useStoryRuntimeStore.getState().statsKey).toBeNull();
    // localStorage 里不应出现任何 stats key
    const keys = Object.keys(localStorage).filter((k) => k.includes('.stats.'));
    expect(keys).toEqual([]);
  });

});
