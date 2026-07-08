---
version: 1.0.4
attention: low
---
# v1.0.4

## User-facing Highlights (zh)

- **登录状态更稳**: 后端滚动更新或短暂 5xx 波动时,前端不再误判为登录失效并把用户踢出。
- **历史素材复用更完整**: 从画布历史中「使用」视频素材创建新视频节点时,会自动带回原始提示词,方便继续迭代。

## User-facing Highlights (en)

- **More stable sign-in state**: Temporary backend 5xx responses during rolling updates no longer make the frontend treat the session as expired and sign the user out.
- **Better history reuse**: Creating a new video node from a canvas history asset now restores the original prompt so you can keep iterating from it.

## Fixes

- 其余修复与内部改动见 GitHub Release 页的 Bug Fixes 与 What's Changed。
