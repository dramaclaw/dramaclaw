---
version: 1.0.7
attention: low
---
# v1.0.7

## User-facing Highlights (zh)

- **剧本导入更准确**: 章节标题边界识别更严格,减少正文里的“第一集/Chapter 1”被误切成新章节的情况。
- **虾画视频节点更稳定**: 修复首尾帧和画布上下文串用导致的视频节点报错,跨画布编辑更可靠。
- **登录与公开页面更可靠**: 登录页视频、商务微信二维码和浏览器 CSP 兼容性完成收口,减少黑屏、花屏和控制台告警。

## User-facing Highlights (en)

- **More accurate script imports**: Chapter title boundary detection is stricter, reducing accidental splits when text mentions “Episode 1” or “Chapter 1” inside body copy.
- **More stable Xiahua video nodes**: Video nodes now avoid first/last-frame and canvas-context leakage that could break cross-canvas editing.
- **More reliable login and public pages**: Login video assets, business WeCom QR assets, and browser CSP compatibility were tightened to reduce black screens, visual glitches, and console warnings.

## Fixes

- 其余修复与内部改动见 GitHub Release 页的 Bug Fixes 与 What's Changed。
