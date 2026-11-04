import { describe, expect, it } from 'vitest';
import { Compiler } from 'inkjs/full';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';
import { compileGraphToInk } from '@/features/canvas/story/compileGraphToInk';

function v(id: string, url: string, start?: 'start'): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: { videoUrl: url, aspectRatio: '16:9', ...(start ? { storyRole: start } : {}) },
  } as CanvasNode;
}
function e(s: string, t: string, text: string, order: number): CanvasEdge {
  return {
    id: `${s}->${t}`,
    source: s,
    target: t,
    type: STORY_CHOICE_EDGE_TYPE,
    data: { choiceText: text, order },
  } as CanvasEdge;
}

/**
 * 推进 story 到下一个 knot,读取 `# clip: <id>` tag,返回对应视频 URL。
 *
 * 实测 inkjs 2.4.0 行为:
 * - Continue() 之后 currentTags 立即可读,格式为 `["clip: <id>"]`(冒号后有空格)
 * - tag 前缀是 "clip:" —— slice + trim() 去掉前导空格即得 nodeId
 * - 叶子节点 Continue() 后 currentChoices 为空,canContinue 为 false
 */
function advance(
  story: ReturnType<Compiler['Compile']>,
  clipByNodeId: Record<string, string>,
): string | null {
  if (!story.canContinue) return null;
  story.Continue();
  const tag = (story.currentTags ?? []).find((it) => it.startsWith('clip:'));
  if (!tag) return null;
  const nodeId = tag.slice('clip:'.length).trim();
  return clipByNodeId[nodeId] ?? null;
}

describe('compileGraphToInk + inkjs 端到端', () => {
  it('编译产物能被 inkjs 编译,并按选择走出期望的视频序列', () => {
    const nodes = [v('intro', 'intro.mp4', 'start'), v('meet', 'meet.mp4'), v('awk', 'awk.mp4')];
    const edges = [e('intro', 'meet', '先自我介绍', 0), e('intro', 'awk', '直接坐下', 1)];
    const { ink, clipByNodeId } = compileGraphToInk(nodes, edges);

    const story = new Compiler(ink).Compile();

    // 走起点:intro.mp4
    expect(advance(story, clipByNodeId)).toBe('intro.mp4');
    // 选项文案与顺序
    expect(story.currentChoices.map((c) => c.text)).toEqual(['先自我介绍', '直接坐下']);

    // 选第 0 项 -> meet.mp4(叶子节点)
    story.ChooseChoiceIndex(0);
    expect(advance(story, clipByNodeId)).toBe('meet.mp4');
    // 叶子节点:无选项,故事结束
    expect(story.currentChoices).toHaveLength(0);
    expect(story.canContinue).toBe(false);
  });
});
