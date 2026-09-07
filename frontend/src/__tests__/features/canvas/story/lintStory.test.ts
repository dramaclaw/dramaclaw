import { describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE, type StoryFlag, type StoryVariable } from '@/features/canvas/story/storyTypes';
import { lintStory, type StoryIssue } from '@/features/canvas/story/lintStory';

function vnode(
  id: string,
  opts: {
    start?: boolean;
    videoUrl?: string | null;
    endingLabel?: string;
    importNeedsReview?: boolean;
  } = {},
): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: {
      videoUrl: opts.videoUrl === undefined ? `${id}.mp4` : opts.videoUrl,
      aspectRatio: '16:9',
      ...(opts.start ? { storyRole: 'start' } : {}),
      ...(opts.endingLabel ? { endingLabel: opts.endingLabel } : {}),
      ...(opts.importNeedsReview ? { importNeedsReview: true } : {}),
    },
  } as CanvasNode;
}

function cedge(
  id: string,
  source: string,
  target: string,
  data: Partial<{ condition: unknown; effects: unknown; needsReview: boolean; order: number }> = {},
): CanvasEdge {
  return {
    id,
    source,
    target,
    type: STORY_CHOICE_EDGE_TYPE,
    data: { choiceText: id, order: data.order ?? 0, ...data },
  } as CanvasEdge;
}

const codes = (issues: StoryIssue[]) => issues.map((i) => i.code);

describe('lintStory', () => {
  it('超过分析深度的有限自动链只提示未完成，不误报死循环或不可达', () => {
    const members = Array.from({ length: 103 }, (_, i) => vnode(`n${i}`, {
      start: i === 0, ...(i === 102 ? { endingLabel: 'GE' } : {}),
    }));
    const edges = members.slice(0, -1).map((node, i) => ({
      ...cedge(`e${i}`, node.id, `n${i + 1}`),
      data: { transitionMode: 'automatic', order: 0 },
    }));
    const findings = codes(lintStory(members, edges, []));
    expect(findings).toContain('path_analysis_incomplete');
    expect(findings).not.toContain('automatic_cycle');
    expect(findings).not.toContain('runtime_unreachable');
  });
  it('合法故事 → 空数组', () => {
    const members = [vnode('a', { start: true }), vnode('b', { endingLabel: 'GE' })];
    const edges = [cedge('e', 'a', 'b')];
    expect(lintStory(members, edges, [])).toEqual([]);
  });

  it('no_start:无起点也无唯一根(环)', () => {
    const members = [vnode('a'), vnode('b')];
    const edges = [cedge('e1', 'a', 'b'), cedge('e2', 'b', 'a')];
    expect(codes(lintStory(members, edges, []))).toContain('no_start');
  });

  it('no_start:多个显式起点', () => {
    const members = [vnode('a', { start: true }), vnode('b', { start: true, endingLabel: 'GE' })];
    const edges = [cedge('e', 'a', 'b')];
    expect(codes(lintStory(members, edges, []))).toContain('no_start');
  });

  it('unreachable:从起点连不到的节点', () => {
    const members = [vnode('a', { start: true }), vnode('b', { endingLabel: 'GE' }), vnode('island', { endingLabel: 'X' })];
    const edges = [cedge('e', 'a', 'b')];
    const issues = lintStory(members, edges, []);
    expect(issues.some((i) => i.code === 'unreachable' && i.nodeId === 'island')).toBe(true);
  });

  it('missing_video:占位片段无视频', () => {
    const members = [vnode('a', { start: true }), vnode('b', { videoUrl: null, endingLabel: 'GE' })];
    const edges = [cedge('e', 'a', 'b')];
    const issues = lintStory(members, edges, []);
    expect(issues.some((i) => i.code === 'missing_video' && i.nodeId === 'b')).toBe(true);
  });

  it('undefined_variable:条件/效果引用未定义变量', () => {
    const members = [vnode('a', { start: true }), vnode('b', { endingLabel: 'GE' })];
    const edges = [cedge('e', 'a', 'b', { condition: { var: 'ghost', op: '>=', value: 1 } })];
    const vars: StoryVariable[] = [{ name: 'favor', label: 'favor', initial: 0 }];
    const issues = lintStory(members, edges, vars);
    const u = issues.find((i) => i.code === 'undefined_variable' && i.edgeId === 'e');
    expect(u).toBeTruthy();
    expect(u?.detail).toBe('ghost');
  });

  it('undefined_variable:复合条件组里某叶子引用未定义变量', () => {
    const members = [vnode('a', { start: true }), vnode('b', { endingLabel: 'GE' })];
    const edges = [cedge('e', 'a', 'b', {
      condition: { join: 'and', items: [
        { var: 'favor', op: '>=', value: 5 },
        { var: 'ghost', op: '>=', value: 1 },
      ] },
    })];
    const vars: StoryVariable[] = [{ name: 'favor', label: 'favor', initial: 0 }];
    const issues = lintStory(members, edges, vars);
    const u = issues.find((i) => i.code === 'undefined_variable' && i.edgeId === 'e');
    expect(u).toBeTruthy();
    expect(u?.detail).toBe('ghost');
  });

  it('访问叶子不当作未定义变量;指向非成员 → dangling_visit', () => {
    const members = [vnode('a', { start: true }), vnode('b', { endingLabel: 'GE' })];
    const edges = [cedge('e', 'a', 'b', {
      condition: { join: 'and', items: [
        { var: 'favor', op: '>=', value: 5 },
        { visitedNodeId: 'ghost', op: '>=', value: 1 },
      ] },
    })];
    const vars: StoryVariable[] = [{ name: 'favor', label: 'favor', initial: 0 }];
    const issues = lintStory(members, edges, vars);
    expect(issues.some((i) => i.code === 'undefined_variable')).toBe(false);
    expect(issues.some((i) => i.code === 'dangling_visit' && i.edgeId === 'e')).toBe(true);
  });

  it('访问叶子指向组内成员 → 不报 dangling_visit', () => {
    const members = [vnode('a', { start: true }), vnode('b', { endingLabel: 'GE' })];
    const edges = [cedge('e', 'a', 'b', { condition: { visitedNodeId: 'b', op: '>=', value: 1 } })];
    const issues = lintStory(members, edges, []);
    expect(issues.some((i) => i.code === 'dangling_visit')).toBe(false);
  });

  it('dangling_edge:目标不在组内', () => {
    const members = [vnode('a', { start: true })];
    const edges = [cedge('e', 'a', 'outsider')];
    const issues = lintStory(members, edges, []);
    expect(issues.some((i) => i.code === 'dangling_edge' && i.edgeId === 'e')).toBe(true);
  });

  it('leaf_no_ending:叶子无结局标 → info', () => {
    const members = [vnode('a', { start: true }), vnode('b')]; // b 无 endingLabel、无出边
    const edges = [cedge('e', 'a', 'b')];
    const issues = lintStory(members, edges, []);
    const leaf = issues.find((i) => i.code === 'leaf_no_ending' && i.nodeId === 'b');
    expect(leaf).toBeTruthy();
    expect(leaf?.severity).toBe('info');
  });

  it('needs_review:汇总导入打标的边与节点', () => {
    const members = [vnode('a', { start: true }), vnode('b', { endingLabel: 'GE', importNeedsReview: true })];
    const edges = [cedge('e', 'a', 'b', { needsReview: true })];
    const issues = lintStory(members, edges, []);
    expect(issues.filter((i) => i.code === 'needs_review')).toHaveLength(2);
  });

  it('自动分支没有兜底时给出可定位警告', () => {
    const members = [vnode('a', { start: true }), vnode('b', { endingLabel: 'GE' })];
    const edges = [cedge('e', 'a', 'b', { condition: { flag: 'has_key', value: true } })];
    (edges[0].data as Record<string, unknown>).transitionMode = 'automatic';
    const flags: StoryFlag[] = [{ name: 'has_key', label: '已拿到钥匙', initial: false }];
    const issues = lintStory(members, edges, [], flags);
    expect(issues.some((issue) => issue.code === 'automatic_no_fallback' && issue.nodeId === 'a')).toBe(true);
    expect(issues.some((issue) => issue.code === 'undefined_flag')).toBe(false);
  });

  it('无条件自动分支遮住后续规则时阻止发布', () => {
    const members = [vnode('a', { start: true }), vnode('b', { endingLabel: 'GE' }), vnode('c', { endingLabel: 'BE' })];
    const edges = [cedge('fallback', 'a', 'b', { order: 0 }), cedge('later', 'a', 'c', { order: 1 })];
    for (const edge of edges) (edge.data as Record<string, unknown>).transitionMode = 'automatic';
    const issues = lintStory(members, edges, []);
    expect(issues.some((issue) => issue.code === 'automatic_fallback_order' && issue.edgeId === 'fallback')).toBe(true);
  });

  it('识别连线可达但状态永远无法触发的分支', () => {
    const members = [
      vnode('a', { start: true }),
      vnode('b'),
      vnode('impossible', { endingLabel: 'X' }),
      vnode('reachable', { endingLabel: 'GE' }),
    ];
    const edges = [
      cedge('set-key', 'a', 'b', { effects: [{ flag: 'has_key', value: true }] }),
      cedge('without-key', 'b', 'impossible', { condition: { flag: 'has_key', value: false }, order: 0 }),
      cedge('with-key', 'b', 'reachable', { condition: { flag: 'has_key', value: true }, order: 1 }),
    ];
    const flags: StoryFlag[] = [{ name: 'has_key', label: '已拿到钥匙', initial: false }];
    const issues = lintStory(members, edges, [], flags);
    expect(issues.some((issue) => issue.code === 'condition_unreachable' && issue.edgeId === 'without-key')).toBe(true);
    expect(issues.some((issue) => issue.code === 'runtime_unreachable' && issue.nodeId === 'impossible')).toBe(true);
  });

  it('变量效果超出声明范围时阻止发布', () => {
    const members = [vnode('a', { start: true }), vnode('b', { endingLabel: 'GE' })];
    const edges = [cedge('overflow', 'a', 'b', { effects: [{ var: 'score', delta: 2 }] })];
    const variables: StoryVariable[] = [{ name: 'score', label: '积分', initial: 0, minimum: 0, maximum: 1 }];
    const issues = lintStory(members, edges, variables);
    expect(issues.some((issue) => issue.code === 'variable_out_of_bounds' && issue.edgeId === 'overflow' && issue.severity === 'error')).toBe(true);
  });

  it('无玩家输入的自动自循环会阻止发布', () => {
    const members = [vnode('a', { start: true })];
    const edges = [cedge('auto-loop', 'a', 'a')];
    (edges[0].data as Record<string, unknown>).transitionMode = 'automatic';
    const issues = lintStory(members, edges, []);
    expect(issues.some((issue) => issue.code === 'automatic_cycle' && issue.edgeId === 'auto-loop' && issue.severity === 'error')).toBe(true);
  });

  it('允许玩家取得钥匙后返回旧节点并解锁新路径', () => {
    const members = [
      vnode('door', { start: true }),
      vnode('key'),
      vnode('room', { endingLabel: 'GE' }),
    ];
    const edges = [
      cedge('find-key', 'door', 'key', { condition: { flag: 'unlocked', value: false }, order: 0 }),
      cedge('open-door', 'door', 'room', { condition: { flag: 'unlocked', value: true }, order: 1 }),
      cedge('return', 'key', 'door', { effects: [{ flag: 'unlocked', value: true }] }),
    ];
    const flags: StoryFlag[] = [{ name: 'unlocked', label: '门已解锁', initial: false }];
    const issues = lintStory(members, edges, [], flags);
    expect(issues.some((issue) => ['runtime_unreachable', 'condition_unreachable', 'automatic_cycle'].includes(issue.code))).toBe(false);
  });

  it('按 error → warning → info 排序', () => {
    const members = [
      vnode('a', { start: true }),
      vnode('b', { videoUrl: null }), // missing_video(warning) + leaf_no_ending(info)
    ];
    const edges = [cedge('e', 'a', 'b', { condition: { var: 'ghost', op: '>=', value: 1 } })]; // undefined_variable(error)
    const sevs = lintStory(members, edges, []).map((i) => i.severity);
    const rank = { error: 0, warning: 1, info: 2 } as const;
    const ranks = sevs.map((s) => rank[s]);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
  });
});
