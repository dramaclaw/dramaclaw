---
version: 2.0.4
attention: medium
---
# v2.0.4

## User-facing Highlights (zh)

- **新增越南语界面**: DramaClaw 现已提供完整的越南语界面，并修正英文剧本格式指引和多语言回退逻辑，让更多社区用户可以直接使用熟悉的语言完成创作。
- **支持可选手机号验证码登录**: 部署方启用对应入口后，用户可以通过手机号和验证码登录并设置密码；登录能力默认受开关控制，不影响现有部署。
- **跨项目媒体引用更安全**: 虾画会识别来自其他项目的图片和视频引用，阻止无效引用继续写入，并为历史遗留引用提供复制到当前项目的一键修复入口。
- **本地 CE 启动更省配置**: 本地启动现在默认使用社区版，不再要求额外声明版本；并发初始化配置时也会自动重试。
- **画布任务计费参数更加准确**: 画布主线生成任务会携带完整的模型计费参数，减少预估与实际结算不一致的情况。

## User-facing Highlights (en)

- **Vietnamese interface support**: DramaClaw now includes a complete Vietnamese interface, along with corrected English screenplay guidance and safer language fallback behavior.
- **Optional phone OTP sign-in**: When enabled by the deployment operator, users can sign in with a phone number and verification code and set a password. The entry remains gated and does not affect existing deployments by default.
- **Safer cross-project media references**: XiaHua detects image and video references that belong to another project, prevents new invalid references from being saved, and offers one-click repair for legacy references by copying them into the current project.
- **Simpler local CE startup**: Local startup now defaults to the Community Edition without requiring an explicit edition setting, with automatic retries for concurrent settings initialization.
- **More accurate canvas task billing**: Mainline canvas generation tasks now include complete model-pricing inputs, reducing differences between estimated and settled usage.

## Fixes

- 修正英文剧本格式指引、多语言回退和越南语手机号登录文案 (#500, #516).
- 修复跨项目媒体引用可能导致素材无法访问或画布保存异常的问题 (#513).
- 修复本地启动必须额外配置版本，以及并发初始化配置可能失败的问题 (#511).
- 修复画布主线任务缺少模型计费参数的问题 (#497).

## Improvements

- 新增受部署开关控制的手机号验证码登录和密码设置能力 (#471).
