import { describe, expect, it } from 'vitest';
import { buildPlayerHtml } from '@/features/canvas/story/export/buildPlayerHtml';
import type { CompiledStory } from '@/features/canvas/story/storyTypes';

function baseCompiled(over: Partial<CompiledStory> = {}): CompiledStory {
  return {
    ink: '',
    clipByNodeId: { intro: '/static/projects/p/videos/intro.mp4' },
    choiceLoopClipByNodeId: {},
    knotByNodeId: { intro: 'clip_intro' },
    choiceTimeByNodeId: {},
    defaultChoiceIndexByNodeId: {},
    endingByNodeId: {},
    placeholderByNodeId: {},
    choiceFeedbackById: {},
    choiceStateChangesById: {},
    choiceInteractionById: {},
    warnings: [],
    variables: [{ name: 'fav', label: '好感度', initial: 0 }],
    ...over,
  };
}

function extractData(html: string): Record<string, unknown> {
  const m = html.match(/window\.__STORY__=(\{[\s\S]*?\});<\/script>/);
  if (!m) throw new Error('no __STORY__ payload');
  return JSON.parse(m[1]);
}

describe('buildPlayerHtml', () => {
  it('内联 inkjs runtime 与播放器(含 new inkjs.Story)', () => {
    const html = buildPlayerHtml(baseCompiled(), '{"fake":1}', { origin: 'https://tale.example' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('.inkjs=');          // UMD 全局赋值标记
    expect(html).toContain('new inkjs.Story');   // 播放器脚本
  });

  it('注入可 JSON.parse 的数据,storyJson 原样保留', () => {
    const html = buildPlayerHtml(baseCompiled(), '{"fake":1}', { origin: 'https://tale.example' });
    const data = extractData(html);
    expect(data.storyJson).toBe('{"fake":1}');
    expect(data).not.toHaveProperty('variables');
  });

  it('clip 路径烘焙为绝对 URL', () => {
    const html = buildPlayerHtml(baseCompiled(), '{}', { origin: 'https://tale.example' });
    const data = extractData(html) as { clips: Record<string, string> };
    expect(data.clips.intro).toBe('https://tale.example/static/projects/p/videos/intro.mp4');
  });

  it('独立烘焙选择阶段循环片段，不复用主剧情视频', () => {
    const html = buildPlayerHtml(baseCompiled({
      choiceLoopClipByNodeId: { intro: '/static/projects/p/videos/choice-loop.mp4' },
    }), '{}', { origin: 'https://tale.example' });
    const data = extractData(html) as { choiceLoops: Record<string, string> };

    expect(data.choiceLoops.intro).toBe('https://tale.example/static/projects/p/videos/choice-loop.mp4');
    expect(html).toContain('var choiceLoopUrl');
    expect(html).toContain('v.loop = !!choiceLoopUrl');
    expect(html).toContain('showChoices() && st.choices.length > 0');
    expect(html).not.toContain('v.loop = videoEnded && st.choices.length > 0');
  });

  it('空 clip 保持空串(占位片段)', () => {
    const html = buildPlayerHtml(baseCompiled({
      clipByNodeId: { a: '' },
      placeholderByNodeId: { a: { label: '雨夜', text: '主角推开便利店的门。' } },
    }), '{}', { origin: 'https://x' });
    const data = extractData(html) as {
      clips: Record<string, string>;
      placeholders: Record<string, { label: string; text: string }>;
    };
    expect(data.clips.a).toBe('');
    expect(data.placeholders.a).toEqual({ label: '雨夜', text: '主角推开便利店的门。' });
    expect(html).toContain("el('p', 'placeholder-text'");
  });

  it('注入选择后的剧情反馈，独立播放器可按选项 tag 查找', () => {
    const html = buildPlayerHtml(baseCompiled({
      choiceFeedbackById: { 'feedback-0': '她把手电筒递给了你。' },
      choiceStateChangesById: { 'feedback-0': [{ label: '信任', direction: 'up' }] },
    }), '{}', { origin: 'https://x' });
    const data = extractData(html) as {
      choiceFeedback: Record<string, string>;
      choiceStateChanges: Record<string, Array<{ label: string; direction: string }>>;
    };
    expect(data.choiceFeedback['feedback-0']).toBe('她把手电筒递给了你。');
    expect(data.choiceStateChanges['feedback-0']).toEqual([{ label: '信任', direction: 'up' }]);
    expect(html).toContain("tag.indexOf('choice-feedback:')");
    expect(html).toContain('outcome-feedback-text');
    expect(html).toContain('outcome-state-changes');
  });

  it('注入物品锚定与视频内 UI 热区规格，独立播放器读取 choice interaction tag', () => {
    const html = buildPlayerHtml(baseCompiled({
      choiceInteractionById: {
        'interaction-0': {
          presentation: 'object-anchor',
          anchor: { x: 0.68, y: 0.64, objectLabel: '手电筒' },
          uiStyle: 'tag',
          motion: 'pop',
        },
      },
    }), '{}', { origin: 'https://x' });
    const data = extractData(html) as {
      choiceInteraction: Record<string, { presentation: string; anchor: { x: number; y: number } }>;
    };
    expect(data.choiceInteraction['interaction-0'].anchor).toEqual({ x: 0.68, y: 0.64, objectLabel: '手电筒' });
    expect(html).toContain("tag.indexOf('choice-interaction:')");
    expect(html).toContain('anchored-choice');
    expect(html).toContain('.anchored-choice.tag { width: 52px');
    expect(html).not.toContain('.anchored-choice.tag::before');
    expect(html).toContain('color: transparent');
    expect(html).toContain("outerRing.setAttribute('data-tech-target', 'true')");
    expect(html).toContain("hitHighlight.setAttribute('data-tech-hit-highlight', 'true')");
    expect(html).toContain("button.setAttribute('data-anchor-x'");
    expect(html).toContain('function positionAnchors(stage, video)');
    expect(html).toContain("v.addEventListener('timeupdate'");
    expect(html).toContain("previousVideo.getAttribute('data-player-src')");
    expect(html).toContain('var reusableVideo = null');
  });

  it('导出播放器按 baked-video 的矩形宽高设置透明热区', () => {
    const html = buildPlayerHtml(baseCompiled({
      choiceInteractionById: {
        'interaction-0': {
          presentation: 'baked-video',
          anchor: { x: 0.58, y: 0.62, width: 0.3, height: 0.16 },
        },
      },
    }), '{}', { origin: 'https://x' });
    const data = extractData(html) as {
      choiceInteraction: Record<string, { anchor: { width: number; height: number } }>;
    };

    expect(data.choiceInteraction['interaction-0'].anchor).toMatchObject({ width: 0.3, height: 0.16 });
    expect(html).toContain("button.setAttribute('data-anchor-width'");
    expect(html).toContain("button.setAttribute('data-anchor-height'");
    expect(html).toContain("button.classList.contains('baked')");
    expect(html).toContain('hotspotWidth * renderedWidth');
    expect(html).toContain('.anchored-choice.baked { min-width: 44px;');
  });

  it('转义结局标题中的 </script>,且可被还原', () => {
    const compiled = baseCompiled({ endingByNodeId: { e: { title: 'bad</script>x' } } });
    const html = buildPlayerHtml(compiled, '{}', { origin: 'https://x' });
    const payload = html.match(/window\.__STORY__=(\{[\s\S]*?\});<\/script>/)![1];
    expect(payload).not.toContain('</script>');
    const data = extractData(html) as { endings: Record<string, { title: string }> };
    expect(data.endings.e.title).toBe('bad</script>x');
  });

  it('注入本地化 labels(传入则用传入)', () => {
    const html = buildPlayerHtml(baseCompiled(), '{}', {
      origin: 'https://x',
      labels: {
        defaultChoice: 'DEF',
        endingBadge: 'END',
        endingFallback: 'FIN',
        restart: 'AGAIN',
        loadError: 'ERR',
        placeholderBadge: 'PLACEHOLDER',
        placeholderHint: 'NO VIDEO',
      },
    });
    const data = extractData(html) as { labels: Record<string, string> };
    expect(data.labels.restart).toBe('AGAIN');
    expect(data.labels.placeholderHint).toBe('NO VIDEO');
  });

  it('安全转义占位剧情中的 script 结束标签', () => {
    const html = buildPlayerHtml(baseCompiled({
      placeholderByNodeId: { a: { label: '占位', text: '前半段</script><b>后半段</b>' } },
    }), '{}', { origin: 'https://x' });
    const payload = html.match(/window\.__STORY__=(\{[\s\S]*?\});<\/script>/)![1];
    expect(payload).not.toContain('</script>');
    const data = extractData(html) as { placeholders: Record<string, { text: string }> };
    expect(data.placeholders.a.text).toBe('前半段</script><b>后半段</b>');
  });
});
