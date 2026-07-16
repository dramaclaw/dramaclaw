---
version: 1.1.1
attention: low
---
# v1.1.1

## User-facing Highlights (zh)

- **桌面端 · 下载与自动更新全面提速**: 安装包分发与应用内自动更新接入国内 CDN。本版起,检查更新与差分下载不再受国际链路影响;从 v1.1.0 升级到本版的这一次仍走原渠道,升级完成后即切换至加速通道。
- **资产库升级**: 资产库支持多媒介类型并与主线同步;历史资产不再限制每类仅显示 20 条,创作素材一览无余。
- **自建网关更省心**: 本地网关一键初始化流程简化,媒体模型命名与网关侧对齐;桌面端内置网关默认端口迁移至 18780,避开与常见开发工具端口 3000 的冲突。

## User-facing Highlights (en)

- **Desktop · Faster downloads and updates**: Installer distribution and in-app auto-updates now ride a China-friendly CDN. From this version onward, update checks and differential downloads are no longer throttled by cross-border links; the one-time upgrade from v1.1.0 still uses the original channel, after which the accelerated channel takes over.
- **Asset library upgrade**: The asset library now supports multiple media types with mainline sync, and the 20-items-per-category display cap is removed.
- **Smoother self-hosted gateway**: One-click local gateway setup is simplified, media model names are aligned with the gateway, and the desktop bundled gateway default port moves to 18780 to avoid clashing with common dev tools on port 3000.

## Improvements

- 画布连线支持一键隐藏/显示,仅视觉隐藏,连线关系保留 (#129).
- 视频时长支持直接输入,生成面板视觉收敛 (#128).
- 统一导航反馈与素材页控件交互 (#125).
- 文本生成默认不再开启深度推理,响应更快 (#135).

## Bug Fixes

- 修复 FAQ 弹层在短视口下的重叠问题 (#128).
- NewAPI 媒体模型命名对齐,修正自建网关下部分媒体模型无法命中的问题 (#131).
- 本地开发态的兜底版本号改为从 git tag 派生,不再显示过期版本 (#126).

## Known Issues 已知问题

- 已使用「一键初始化自建网关」的用户:升级后请在设置页将网关地址更新为 `http://127.0.0.1:18780`,或清除自定义配置后重新初始化。网关端口已迁移;仅影响自定义网关模式,官方 DC Key 模式无感。
- 桌面端 · Windows 首次启动时,系统防火墙会询问是否允许 `new-api.exe` 联网:这是一次性提示,选「允许访问」或「取消」均不影响使用,应用仅使用本机回环通信。
- 桌面端 · Windows 安装包暂未代码签名,SmartScreen 可能提示「未知发布者」:点「更多信息 -> 仍要运行」即可。
