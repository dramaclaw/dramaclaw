---
version: 2.0.5
attention: low
---
# v2.0.5

## User-facing Highlights (zh)

- **素材归档更完整**: 视频、图片和音频生成结果支持归档后的交付与访问，减少临时结果链接失效带来的影响。
- **参考素材提前校验**: 虾画生成前会检查参考素材的时长等限制，并标出不符合要求的文件，方便及时调整。
- **新增灵山图片模型**: 社区版新增 LingShan G25 Fast 和 LingShan G25 Pro 图片模型配置。
- **账号与充值体验改进**: 密码账号支持首次绑定手机号，并新增积分充值和独立结账流程。

## User-facing Highlights (en)

- **More reliable archived media**: Generated videos, images, and audio can be delivered from archives, reducing reliance on expiring result links.
- **Earlier reference validation**: XiaHua checks reference media limits before generation and identifies files that need adjustment.
- **New LingShan image models**: Community Edition adds configurations for LingShan G25 Fast and LingShan G25 Pro.
- **Improved accounts and checkout**: Password accounts can bind a phone number for the first time, with a new credit top-up and checkout flow.

## Fixes

- 修复并发草图重生成时输出路径冲突的问题 (#612)。
- 修复视频编辑错误提示及参考素材校验体验问题 (#597, #625)。
- 修复按集配音任务身份传递和完成后的刷新问题 (#551, #552)。
- 修复每日备份包含已弃用项目数据的问题 (#531)。

## Improvements

- 优化视频、图片和音频归档结果的交付与访问 (#574, #616)。
- 减少上传及媒体读取对服务响应速度的影响 (#560, #566, #578)。
