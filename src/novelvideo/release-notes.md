---
version: 2.0.3
attention: medium
---
# v2.0.3

## User-facing Highlights (zh)

- **自部署组合更加完整**: Docker 源码版会同时构建 DramaClaw、虾画前端和同级目录中的 dramaclaw-gateway；镜像版继续提供直接拉取已发布镜像的独立入口，社区用户可以更清楚地选择开发或稳定部署方式。
- **自定义模型配置补齐角色构建**: 自定义模式现在可以正确映射 DC-character-builder-LLM，使用自定义模型网关时角色提取不再因缺少模型映射而失败。
- **跨项目复制素材更可靠**: 在虾画中跨项目粘贴节点时，图片和视频素材由后端完成复制，并在迁移结束前暂停自动保存，减少引用丢失或保存到旧地址的问题。
- **失败原因更容易定位**: 项目分享会明确提示用户不存在、已加入或邀请冲突等原因；角色提取重试耗尽时，日志会保留真正的失败原因，方便排查模型输出问题。
- **社区文档覆盖更多语言**: README 新增越南语和泰语版本，并重新梳理源码开发、镜像部署、模型网关和许可证说明。

## User-facing Highlights (en)

- **A more complete self-hosted stack**: The source Docker entry point now builds DramaClaw, the XiaHua frontend, and a sibling dramaclaw-gateway checkout together, while the release entry point remains dedicated to published images. Community users can choose development or stable deployment more clearly.
- **Character building works in Custom mode**: Custom model configurations can now map DC-character-builder-LLM, preventing character extraction failures caused by a missing model mapping when using a custom gateway.
- **More reliable cross-project asset copying**: When nodes are pasted across XiaHua projects, image and video assets are copied by the backend and autosave pauses until migration finishes, reducing broken or stale references.
- **Clearer failure details**: Project sharing now distinguishes missing users, existing members, and invitation conflicts. Character extraction logs also preserve the actual cause after output retries are exhausted.
- **More accessible community documentation**: Vietnamese and Thai READMEs are now available, with clearer guidance for source development, image-based deployment, model gateways, and licensing.

## Fixes

- 修复自定义模式无法映射角色构建模型的问题 (#491).
- 修复角色提取重试耗尽后只记录通用错误、无法定位真实原因的问题 (#492).
- 修复项目分享失败时提示不明确的问题 (#479).

## Improvements

- 跨项目粘贴改由后端复制素材，并在迁移期间暂停自动保存 (#493).
- 将源码开发和镜像部署拆分为清晰的 Docker Compose 入口，并默认集成同级 dramaclaw-gateway (#476, #482).
- 重构 README 的产品、部署、网关和许可证说明，新增越南语与泰语文档 (#481, #483, #484, #486, #495).
