---
version: 2.0.1
attention: medium
---
# v2.0.1

## User-facing Highlights (zh)

- **视频生成失败原因更明确**: 组织账号遇到参考图尺寸不合规、版权或敏感内容审核失败时会显示具体原因；Seedance 参考图会在任务提交前检查尺寸，避免无效排队和积分预扣。
- **登录页与虾画交互更顺手**: 优化登录弹窗、公告中心、画布列表、资产库上传、风格图墙和搭子画廊，并恢复登录页公告的正常加载。
- **大型资产库浏览更流畅**: 图片仅在真正进入可见区域后加载，减少大型项目打开画布和滚动资产列表时的图片请求与解码压力。
- **画布与项目分享增加配额提示**: 单个用户在项目内最多创建 25 张画布，单个项目最多分享给 25 人；达到上限时会直接说明原因。

## User-facing Highlights (en)

- **Clearer video generation failures**: Organization users now receive specific reasons for invalid reference dimensions, copyright checks, or content moderation failures. Seedance reference dimensions are validated before queueing to avoid unnecessary task submission and credit reservation.
- **Smoother login and Canvas interactions**: The login dialog, announcement center, canvas list, asset upload flow, style gallery, and companion gallery have been refined, and login-page announcements load correctly again.
- **Faster browsing in large asset libraries**: Images now load only after they actually enter the visible viewport, reducing unnecessary requests and decoding work in large projects.
- **Quota guidance for canvases and sharing**: A user can create up to 25 canvases per project, and a project can be shared with up to 25 people. The interface explains the limit when it is reached.

## Fixes

- 修复组织账号视频生成失败时只显示通用出口错误的问题，并增加 Seedance 参考图尺寸与宽高比预检 (#406).
- 修复公告 JSON 域名未被前端 CSP 放行，导致登录页公告静默不显示的问题 (#395).

## Improvements

- 优化登录页、公告中心、画布列表、资产库和搭子画廊的视觉与交互体验 (#405).
- 增加画布与项目分享的前端配额提示，并让画布列表滚动时底部操作保持可见 (#391).
- 资产图片改为进入真实可见区域后再加载，降低大项目浏览压力 (#396).
