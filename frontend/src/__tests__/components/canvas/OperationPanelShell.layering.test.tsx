import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { OperationPanelShell } from '@/features/canvas/ui/OperationPanelShell';

afterEach(cleanup);

it('仅打开内联操作面板的视频节点匹配层级提升规则，展开或关闭后释放', () => {
  const selector = ".react-flow .react-flow__node-videoNode:has([data-story-edit-frame]):has([data-slot='node-operation-panel'])";
  const shell = (expanded: boolean, storyClip = true) => (
    <div className="react-flow"><div className="react-flow__node-videoNode">
      <div data-story-edit-frame={storyClip ? 'clip' : undefined} />
      <OperationPanelShell expanded={expanded} onCollapse={vi.fn()} inlineClassName="" inlineStyle={{}}>
        生成提示词
      </OperationPanelShell>
    </div></div>
  );
  const view = render(shell(false));
  expect(view.container.querySelector(selector)).not.toBeNull();
  view.rerender(shell(false, false));
  expect(view.container.querySelector(selector)).toBeNull();
  view.rerender(shell(true));
  expect(view.container.querySelector(selector)).toBeNull();
  view.unmount();
  expect(document.querySelector(selector)).toBeNull();
  const css = readFileSync('src/index.css', 'utf8');
  expect(css).toContain(`${selector} {\n  z-index: 1003 !important;`);
});
