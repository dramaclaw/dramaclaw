---
version: 1.1.5
attention: low
---
# v1.1.5

## User-facing Highlights (zh)

- **视频素材工作流更完整**: 视频节点可一次导入多张图片、视频和音频,并按模型能力提供全能参考、图片参考和首尾帧入口,提交前会明确拦截不支持的素材与越界音频。
- **画布查找与保存更可靠**: 历史资产支持按提示词和名称搜索,并修复自动保存并发造成的虚假 409 冲突。
- **小说导入可安全重建**: 知识图谱构建会识别上游失败、空图和不完整结果,失败后可复用原小说安全重试或重建。
- **登录与设置体验更稳定**: 登录过期后会停止重复请求并正确返回登录页,媒体存储凭据支持只更新需要变更的字段,关键界面的中英文显示也更完整。

## User-facing Highlights (en)

- **More complete video reference workflows**: Import multiple images, videos, and audio clips directly into a video node, choose model-appropriate reference modes, and catch unsupported media or invalid audio durations before submission.
- **Faster asset discovery and safer saves**: Search generation history by prompt or name, while serialized canvas saves prevent false 409 conflicts caused by overlapping autosaves.
- **Safe novel import rebuilds**: Knowledge graph imports now detect provider failures, empty graphs, and incomplete runs, then reuse the original novel for a bounded retry or confirmed rebuild.
- **More reliable sessions and settings**: Expired sessions stop repeated background requests and return to sign-in, media credentials support partial updates, and key screens provide more complete Chinese and English localization.

## New Features

- 历史资产支持按提示词和名称搜索,并提供跨分类命中提示 (#178).
- 视频节点支持一次选择多张本地图片、视频和音频,自动创建上游素材节点和分组 (#181).
- EE 登录页新增可配置的“更多信息”菜单,支持链接、图片和 Markdown 内容 (#184).

## Bug Fixes

- 修复画布自动保存并发导致的虚假版本冲突和跨画布误写风险 (#179).
- 修复 Seedance 1.x 静默忽略视频、音频或多图素材的问题,提交前会给出明确原因 (#187).
- 修复 Seedance 2.0 音频参考时长越界后才由厂商返回错误的问题 (#196).
- 修复登录过期后任务流和后台请求持续重试,以及无效 cookie 无法清理的问题 (Fixes #197, #198).
- 修复 Freezone AI 摆件在发送模型请求前因失效导入而失败的问题 (#199).
- 修复知识图谱构建失败被误报成功,并支持复用原小说安全重试和重建 (#200).

## Improvements

- 视频空态入口按模型能力展示全能参考、图片参考和首尾帧等可用模式 (#185).
- OSS 与 Cloudinary 媒体存储凭据支持部分更新,无需重复填写整组配置 (Fixes #182, #183).
- 补齐角色统计、风格、Beat 工作台、分享弹窗和虾画等关键界面的中英文文案 (#191).
