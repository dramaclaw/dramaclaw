// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it } from 'vitest';
import { applyGroupPaintProbe } from '@/features/canvas/application/canvasGroupPaintProbe';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  document.body.innerHTML = '';
});

function fixture() {
  const root = document.createElement('div');
  root.innerHTML = '<div class="react-flow__node-groupNode" style="width:400px;height:200px;transform:translate(20px,30px);z-index:0"><div class="group" style="width:100%;height:100%;background-color:rgba(255,59,48,0.1);border:1px solid rgba(255,59,48,0.2);border-radius:20px;transition:all 200ms"><div class="origin-bottom-left">Title</div></div></div>';
  document.body.append(root);
  return { root, group: root.firstElementChild as HTMLElement, body: root.querySelector('.group') as HTMLElement };
}

describe('group paint comparison', () => {
  it('does nothing in normal, no-fill and no-label modes', () => {
    const { root } = fixture();
    const before = root.innerHTML;
    for (const mode of ['normal', 'no-fill', 'no-label'] as const) applyGroupPaintProbe(root, mode)();
    expect(root.innerHTML).toBe(before);
  });

  it('moves paint to the wrapper without changing geometry or layer', () => {
    const { root, group, body } = fixture();
    const before = { outer: group.getAttribute('style'), inner: body.getAttribute('style') };
    const stop = applyGroupPaintProbe(root, 'wrapper-fill');
    cleanups.push(stop);
    expect(group.style.backgroundColor).toBe('rgba(255, 59, 48, 0.1)');
    expect(group.style.borderRadius).toBe('20px');
    expect(body.style.backgroundColor).toBe('transparent');
    expect(body.style.borderTopWidth).toBe('1px');
    expect(body.style.borderTopColor).toBe('transparent');
    expect([group.style.width, group.style.height, group.style.transform, group.style.zIndex])
      .toEqual(['400px', '200px', 'translate(20px,30px)', '0']);
    stop();
    const reference = document.createElement('div');
    reference.setAttribute('style', before.outer!);
    expect(group.style.cssText).toBe(reference.style.cssText);
    reference.setAttribute('style', before.inner!);
    expect(body.style.cssText).toBe(reference.style.cssText);
  });

  it('changes only z-index in the layer comparison', () => {
    const { root, group, body } = fixture();
    const before = body.getAttribute('style');
    cleanups.push(applyGroupPaintProbe(root, 'lower-layer'));
    expect(group.style.zIndex).toBe('-1001');
    expect(group.style.backgroundColor).toBe('');
    expect(body.getAttribute('style')).toBe(before);
  });

  it('combines both comparisons and restores original property priority', () => {
    const { root, group } = fixture();
    group.style.setProperty('background-color', 'blue', 'important');
    const stop = applyGroupPaintProbe(root, 'reference');
    cleanups.push(stop);
    expect(group.style.zIndex).toBe('-1001');
    expect(group.style.backgroundColor).toBe('rgba(255, 59, 48, 0.1)');
    stop();
    expect(group.style.zIndex).toBe('0');
    expect(group.style.backgroundColor).toBe('blue');
    expect(group.style.getPropertyPriority('background-color')).toBe('important');
  });

  it('leaves later edits intact on cleanup', () => {
    const { root, group, body } = fixture();
    const stop = applyGroupPaintProbe(root, 'reference');
    cleanups.push(stop);
    group.style.setProperty('z-index', '17');
    body.style.setProperty('background-color', 'green');
    stop();
    expect(group.style.zIndex).toBe('17');
    expect(body.style.backgroundColor).toBe('green');
  });

  it('handles new groups, stays scoped, and stops observing on cleanup', async () => {
    const { root, group } = fixture();
    const outside = fixture();
    const fresh = group.cloneNode(true) as HTMLElement;
    const stop = applyGroupPaintProbe(root, 'reference');
    cleanups.push(stop);
    root.append(fresh);
    await Promise.resolve();
    expect(fresh.style.zIndex).toBe('-1001');
    expect(outside.group.style.zIndex).toBe('0');
    fresh.remove();
    await Promise.resolve();
    expect(fresh.style.zIndex).toBe('0');
    stop();
    root.append(fresh);
    await Promise.resolve();
    expect(fresh.style.zIndex).toBe('0');
  });
});
