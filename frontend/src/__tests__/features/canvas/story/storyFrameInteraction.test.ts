import { expect, it } from 'vitest';
import { canOpenStoryFrameEditor } from '@/features/canvas/story/storyFrameInteraction';

it('视频和占位正文可以编辑，控件、输入、拖动与抓手操作不能触发', () => {
  const frame = document.createElement('div');
  frame.innerHTML = '<video></video><p>占位剧情</p><button><span>播放</span></button><input type="range"><div class="nodrag"><span>音量区域</span></div>';
  expect(canOpenStoryFrameEditor(frame.querySelector('video')!, frame, false)).toBe(true);
  expect(canOpenStoryFrameEditor(frame.querySelector('p')!, frame, false)).toBe(true);
  for (const target of frame.querySelectorAll('button span, input, .nodrag span')) {
    expect(canOpenStoryFrameEditor(target, frame, false)).toBe(false);
  }
  expect(canOpenStoryFrameEditor(frame, frame, true)).toBe(false);
  frame.setAttribute('data-canvas-tool', 'hand');
  expect(canOpenStoryFrameEditor(frame, frame, false)).toBe(false);
});
