// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export type GroupPaintMode = 'normal' | 'no-fill' | 'no-label'
  | 'wrapper-fill' | 'lower-layer' | 'reference';

/** Development-only comparison: move paint without changing the group's measured box. */
export function applyGroupPaintProbe(root: HTMLElement, mode: GroupPaintMode): () => void {
  if (mode !== 'wrapper-fill' && mode !== 'lower-layer' && mode !== 'reference') return () => {};
  const moveFill = mode !== 'lower-layer';
  const lowerLayer = mode !== 'wrapper-fill';
  const applied = new Map<HTMLElement, { body: HTMLElement; restore: () => void }>();

  const scan = () => {
    const groups = new Set(root.querySelectorAll<HTMLElement>('.react-flow__node-groupNode'));
    for (const [group, entry] of applied) {
      if (!groups.has(group) || group.querySelector(':scope > .group') !== entry.body) {
        entry.restore();
        applied.delete(group);
      }
    }
    for (const group of groups) {
      if (applied.has(group)) continue;
      const body = group.querySelector<HTMLElement>(':scope > .group');
      if (!body) continue;
      const originalStyles = new Map([group, body].map(element => [element, element.getAttribute('style')]));
      const undo: Array<{ element: HTMLElement; restore: () => void }> = [];
      const set = (element: HTMLElement, property: string, value: string) => {
        const before = element.style.getPropertyValue(property);
        const priority = element.style.getPropertyPriority(property);
        element.style.setProperty(property, value, 'important');
        const written = element.style.getPropertyValue(property);
        undo.push({ element, restore: () => {
          // Do not overwrite an edit made by React/user after this probe's write.
          if (element.style.getPropertyValue(property) !== written
            || element.style.getPropertyPriority(property) !== 'important') return;
          if (before) element.style.setProperty(property, before, priority);
          else element.style.removeProperty(property);
        } });
      };
      if (moveFill) {
        const paint = getComputedStyle(body);
        // Copy values first: computed style is live and changes when the body is cleared.
        const background = paint.backgroundColor;
        const radius = paint.borderRadius;
        const border = `${paint.borderTopWidth} ${paint.borderTopStyle} ${paint.borderTopColor}`;
        const offset = `-${paint.borderTopWidth}`;
        set(group, 'background-color', background);
        set(group, 'border-radius', radius);
        set(group, 'outline', border);
        set(group, 'outline-offset', offset);
        set(body, 'transition', 'none');
        set(body, 'background-color', 'transparent');
        // Keep the inner border width as a spacer, so content and label geometry stay put.
        set(body, 'border-color', 'transparent');
      }
      if (lowerLayer) set(group, 'z-index', '-1001');
      const writtenStyles = new Map([group, body].map(element => [element, element.getAttribute('style')]));
      applied.set(group, { body, restore: () => {
        const changed = new Set<HTMLElement>();
        for (const [element, before] of originalStyles) {
          if (element.getAttribute('style') === writtenStyles.get(element)) {
            // An exact restore also preserves original shorthand/longhand ordering.
            if (before === null) element.removeAttribute('style');
            else element.setAttribute('style', before);
          } else changed.add(element);
        }
        for (const entry of [...undo].reverse()) {
          if (changed.has(entry.element)) entry.restore();
        }
      } });
    }
  };

  scan();
  const observer = new MutationObserver(scan);
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    for (const entry of applied.values()) entry.restore();
    applied.clear();
  };
}
