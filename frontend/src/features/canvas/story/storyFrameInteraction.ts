/** 媒体控件、编辑输入和拖动/抓手平移不属于“点击视频框编辑”。 */
export function canOpenStoryFrameEditor(target: Element, frame: Element, dragged: boolean): boolean {
  return !dragged
    && !target.closest('button, input, select, textarea, a, [role="button"], [contenteditable="true"], .nodrag')
    && !frame.closest('[data-canvas-tool="hand"]');
}
