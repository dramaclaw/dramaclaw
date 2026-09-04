---
version: 2.0.2
attention: medium
---
# v2.0.2

## User-facing Highlights (zh)

- **视频参考能力进一步扩展**: 视频节点新增文件和网页链接参考，并支持从画布选择图片或视频作为参考素材、在提示词中替换引用素材；CE 推荐模型列表新增 Seedance 2.5。
- **英文创作流程更加完整**: 完善前后端英文文案、英文剧本场景识别和 Fountain 格式指引，并确保英文剧本生成的资产继续使用原始语言。
- **虾画创作效率提升**: 优化画布切换、节点对齐、历史资产、资产库管理和虾导消息体验，减少切换画布时的整页加载和重复操作。
- **视频任务更稳定透明**: 在排队前检查缺失的提示词和参考素材，保留安全的上游错误原因，并确保已提交任务在组织 Key 轮换后仍能完成。
- **账号与项目管理更方便**: 新增用户自助修改密码入口，并将项目名称长度上限统一为 64 个字符。

## User-facing Highlights (en)

- **More flexible video references**: Video nodes now accept file and public web-link references, support picking image or video references directly from the canvas, and can replace referenced materials in prompts. Seedance 2.5 is included in the CE recommended model catalog.
- **A more complete English workflow**: Frontend and backend English coverage, English screenplay scene parsing, and Fountain-format guidance have been improved, while generated assets preserve the screenplay's source language.
- **Faster Canvas workflows**: Canvas switching, node alignment, generation history, asset management, and Xia Director messages have been refined to reduce full-page loading and repeated actions.
- **More reliable and transparent video tasks**: Missing prompts and references are checked before queueing, safe upstream rejection details are retained, and accepted jobs can finish after an organization key rotation.
- **Easier account and project management**: Users can now change their own password, and project names consistently support up to 64 characters.

## Fixes

- 修复视频任务缺少必要提示词或素材时仍进入队列的问题，并完善上游明确拒绝的错误分类 (#413, #454, #464).
- 修复组织 Gateway Key 轮换后，已被上游接受的视频任务无法继续查询的问题 (#422).
- 修复英文剧本场景标记识别、生成资产语言继承和任务进度翻译问题 (#441, #462, #463, #469).
- 修复部分同步工作阻塞 API 事件循环，以及上传取消和并发锁处理问题 (#444).

## Improvements

- 增加视频文件/链接参考、画布素材选择和提示词素材替换能力 (#419, #424).
- 优化画布切换、节点对齐、历史资产、资产库和虾导交互体验 (#409, #412, #417, #435).
- 完善英文界面覆盖、Fountain 剧本格式说明，并增加中英文硬编码检查 (#447, #448).
- 新增 Seedance 2.5 推荐配置、自助修改密码和项目名称长度统一限制 (#450, #453, #458).
