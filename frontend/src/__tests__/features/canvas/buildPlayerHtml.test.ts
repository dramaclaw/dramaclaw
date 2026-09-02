import { describe, expect, it } from 'vitest';
import { buildPlayerHtml } from '@/features/canvas/story/export/buildPlayerHtml';
import type { CompiledStory } from '@/features/canvas/story/storyTypes';

function baseCompiled(over: Partial<CompiledStory> = {}): CompiledStory {
  return {
    ink: '',
    clipByNodeId: { intro: '/static/projects/p/videos/intro.mp4' },
    knotByNodeId: { intro: 'clip_intro' },
    choiceTimeByNodeId: {},
    defaultChoiceIndexByNodeId: {},
    endingByNodeId: {},
    placeholderByNodeId: {},
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
    expect(data.variables).toEqual([{ name: 'fav', label: '好感度', initial: 0 }]);
  });

  it('clip 路径烘焙为绝对 URL', () => {
    const html = buildPlayerHtml(baseCompiled(), '{}', { origin: 'https://tale.example' });
    const data = extractData(html) as { clips: Record<string, string> };
    expect(data.clips.intro).toBe('https://tale.example/static/projects/p/videos/intro.mp4');
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
