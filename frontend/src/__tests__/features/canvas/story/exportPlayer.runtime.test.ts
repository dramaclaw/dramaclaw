import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Compiler } from 'inkjs/full';
import { buildPlayerHtml } from '@/features/canvas/story/export/buildPlayerHtml';
import type { CompiledStory } from '@/features/canvas/story/storyTypes';

// Execute the actual exported inline bundle as file://, independently of the app.
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom');
const windows: Window[] = [];
const pause = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
function compiled(overrides: Partial<CompiledStory> = {}): CompiledStory {
  return {
    ink: '-> intro\n=== intro ===\n# clip:intro\n开场\n* [继续] -> ending\n=== ending ===\n# clip:ending\n结局\n-> END',
    clipByNodeId: {}, choiceLoopClipByNodeId: {}, knotByNodeId: {},
    choiceTimeByNodeId: {}, defaultChoiceIndexByNodeId: {},
    endingByNodeId: { ending: { title: '抵达结局' } },
    placeholderByNodeId: { intro: { text: '故事开始' } },
    choiceFeedbackById: {}, choiceStateChangesById: {}, choiceInteractionById: {},
    variables: [], warnings: [], ...overrides,
  };
}
async function openExport(story = compiled(), rejectPlay = false) {
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message));
  const html = buildPlayerHtml(story, new Compiler(story.ink).Compile().ToJson()!, { origin: 'https://editor.example' });
  const dom = new JSDOM(html, {
    url: 'file:///offline/story.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window: Window & typeof globalThis) {
      Object.defineProperties(window.HTMLMediaElement.prototype, {
        play: { configurable: true, value: () => rejectPlay ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve() },
        pause: { configurable: true, value() {} },
        load: { configurable: true, value() {} },
      });
    },
  });
  windows.push(dom.window);
  await pause();
  return { window: dom.window as Window & typeof globalThis, document: dom.window.document as Document, errors, html };
}
afterEach(() => { windows.splice(0).forEach((window) => window.close()); });

describe('exported HTML using the shared player', () => {
  it('file:// 下真正运行：占位剧情、选项、结局、重玩，无外部脚本', async () => {
    const { document, errors } = await openExport();
    expect(document.querySelector('script[src]')).toBeNull();
    expect(document.querySelector('[data-story-placeholder]')?.textContent).toContain('故事开始');
    (document.querySelector('[data-choice-stage] button') as HTMLButtonElement).click();
    await pause(550);
    expect(document.querySelector('[data-story-ending]')?.textContent).toContain('抵达结局');
    (document.querySelector('[data-story-ending] button') as HTMLButtonElement).click();
    await pause();
    expect(document.querySelector('[data-story-placeholder]')).not.toBeNull();
    expect(errors).toEqual([]);
  });

  it('带视频的结局等待 ended；自动播放被拒绝后可手动播放', async () => {
    const { document, window, errors } = await openExport(compiled({
      ink: '-> ending\n=== ending ===\n# clip:ending\n结局\n-> END',
      clipByNodeId: { ending: 'https://editor.example/static/projects/p/videos/main.mp4' },
    }), true);
    const video = document.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('https://editor.example/static/projects/p/videos/main.mp4');
    expect(video.classList.contains('object-contain')).toBe(true);
    expect(document.querySelector('[data-story-ending]')).toBeNull();
    video.dispatchEvent(new window.Event('canplay', { bubbles: true }));
    await pause();
    expect(document.querySelector('button[aria-label="播放当前片段"]')).not.toBeNull();
    video.dispatchEvent(new window.Event('ended', { bubbles: true }));
    await pause();
    expect(document.querySelector('[data-story-ending]')?.textContent).toContain('抵达结局');
    expect(errors).toEqual([]);
  });

  it('媒体失败显示重试入口，不静默卡死', async () => {
    const { document, window, errors } = await openExport(compiled({ clipByNodeId: { intro: 'https://editor.example/static/projects/p/videos/main.mp4' } }));
    document.querySelector('video')!.dispatchEvent(new window.Event('error'));
    await pause();
    expect(document.querySelector('[role=alert]')?.textContent).toContain('视频加载失败');
    expect(document.querySelector('[role=alert] button')?.textContent).toBe('重试播放');
    expect(errors).toEqual([]);
  });
  it('预编译 JSON 的自动跳转等待媒体结束，限时默认分支沿同一运行时推进', async () => {
    const { document, window, errors } = await openExport(compiled({
      ink: '-> intro\n=== intro ===\n# clip:intro\n开场\n-> choice\n=== choice ===\n# clip:choice\n选择\n+ [继续] -> ending\n=== ending ===\n# clip:ending\n结局\n-> END',
      clipByNodeId: { intro: 'https://editor.example/static/projects/p/videos/main.mp4' },
      choiceTimeByNodeId: { choice: 0.1 }, defaultChoiceIndexByNodeId: { choice: 0 },
    }));
    expect(document.querySelector('[data-choice-stage]')).toBeNull();
    document.querySelector('video')!.dispatchEvent(new window.Event('ended'));
    await pause(350);
    expect(document.querySelector('[data-choice-stage]')?.getAttribute('data-choice-stage')).toBe('timeout');
    await pause(550);
    expect(document.querySelector('[data-story-ending]')?.textContent).toContain('抵达结局');
    expect(errors).toEqual([]);
  });

  it('独立循环加载失败回退主视频尾帧，选择仍然可用', async () => {
    const { document, window, errors } = await openExport(compiled({
      clipByNodeId: { intro: 'https://editor.example/static/projects/p/videos/main.mp4' },
      choiceLoopClipByNodeId: { intro: 'https://editor.example/static/projects/p/videos/loop.mp4' },
    }));
    const [main, preload] = Array.from(document.querySelectorAll('video'));
    preload.dispatchEvent(new window.Event('canplay'));
    await pause();
    main.dispatchEvent(new window.Event('ended'));
    await pause();
    expect(document.querySelector('video')!.loop).toBe(true);
    document.querySelector('video')!.dispatchEvent(new window.Event('error'));
    await pause();
    expect(document.querySelector('video')!.getAttribute('src')).toBe('https://editor.example/static/projects/p/videos/main.mp4');
    expect(document.querySelector('video')!.loop).toBe(false);
    expect(document.querySelector('[data-choice-stage] button')).not.toBeNull();
    expect(document.querySelector('[role=alert]')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('导出连续自动转场时，每段视频都等待自己的结束事件', async () => {
    const { document, window } = await openExport(compiled({
      ink: '-> a\n=== a ===\nclip # clip:a\n-> b\n=== b ===\nclip # clip:b\n-> c\n=== c ===\nclip # clip:c\n-> END',
      clipByNodeId: { a: '/a.mp4', b: '/b.mp4', c: '/c.mp4' },
    }));
    document.querySelector('video')!.dispatchEvent(new window.Event('ended'));
    await pause();
    expect(document.querySelector('video')!.src).toBe('https://editor.example/b.mp4');
    document.querySelector('video')!.dispatchEvent(new window.Event('ended'));
    await pause();
    expect(document.querySelector('video')!.src).toBe('https://editor.example/c.mp4');
    expect(document.querySelector('[data-story-ending]')).toBeNull();
  });

  it('导出连续空片段自动推进到可播放视频', async () => {
    const { document } = await openExport(compiled({
      ink: '-> a\n=== a ===\nclip # clip:a\n-> b\n=== b ===\nclip # clip:b\n-> c\n=== c ===\nclip # clip:c\n-> END',
      clipByNodeId: { c: '/c.mp4' },
    }));
    expect(document.querySelector('video')!.src).toBe('https://editor.example/c.mp4');
    expect(document.querySelector('[data-story-ending]')).toBeNull();
  });

  it('导出支持主视频兼作选择等待循环', async () => {
    const { document, window } = await openExport(compiled({
      clipByNodeId: { intro: '/main.mp4' }, choiceLoopClipByNodeId: { intro: '/main.mp4' },
    }));
    const video = document.querySelector('video')!;
    video.dispatchEvent(new window.Event('canplay'));
    await pause();
    video.dispatchEvent(new window.Event('ended'));
    await pause();
    expect(document.querySelector('video')!.loop).toBe(true);
    expect(document.querySelector('[data-choice-stage] button')).not.toBeNull();
  });

});
