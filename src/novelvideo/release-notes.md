---
version: 2.1.2
attention: high
---
# v2.1.2

## User-facing Highlights (zh)

- **移除废弃运行时**: 发行镜像和安装包仅使用自编译 Codex，不再安装或启用 Hermes；旧配置会提示切换到 Codex。
- **完整出包验收**: 安装后的 Windows、只读 Mac DMG 和 Compose 容器均验证真实 Codex 对话，并检查废弃运行时不存在。
- **视频音频选择**: Seedance 2.0 支持生成音频开关，缺少参考声线时可选择继续生成 (#893)。

- **修复桌面虾导**: 桌面版与绿色版使用凭据保护版 Codex 0.164.0，修复升级后虾导无法回复的问题。
- **更可靠的启动**: 改善 Windows 启动兼容性，并为 Mac 首次初始化助手留出足够时间。
- **更准确的错误提示**: 本地助手启动失败会提示检查应用，避免误报为上游模型连接失败。
- **原生启动更简单**: macOS 与 Linux 的 x64、ARM64 源码启动自动下载、校验并缓存配套 Codex 0.164.0，无需私有源码仓库权限。
- **部署版本一致**: 发布版 Compose 默认使用 Codex，API 与网页镜像默认版本均为 2.1.2；同步完善中英文部署指南。
- **升级页面缓存修复**: 调整应用入口页与静态资源缓存策略，避免升级后仍引用旧资源而出现空白页。

## User-facing Highlights (en)

- **Retired runtime removed**: Release images and packages use our compiled Codex without installing or enabling Hermes. Legacy configuration reports how to switch to Codex.
- **Package acceptance**: Installed Windows apps, read-only Mac DMGs and Compose containers verify actual Codex turns and the absence of the retired runtime.
- **Video audio choice**: Seedance 2.0 supports selecting generated audio and continuing without a missing reference voice (#893).

- **Desktop assistant repaired**: Desktop and portable apps use the credential-safe Codex 0.164.0 runtime, fixing assistant failures after upgrading.
- **More reliable startup**: Improved Windows compatibility and allowed enough time for the assistant's first initialization on Mac.
- **Clearer errors**: Local assistant startup failures now suggest checking the app instead of reporting an upstream model connection failure.
- **Simpler native startup**: macOS and Linux x64/ARM64 source launches automatically download, verify and cache the matching Codex 0.164.0 runtime without private repository access.
- **Consistent deployment versions**: Release Compose defaults to Codex and version 2.1.2 for both API and web images, with updated English and Chinese deployment guides.
- **Upgrade cache fix**: Corrected app-shell and static-asset caching to prevent blank pages caused by stale resource references after an upgrade.

## Fixes

- 保留每轮凭据隔离、只读沙箱和默认拒绝本地命令及文件修改审批。
- 修复 Windows 文件锁、进程存活探测及私有助手通信目录的兼容性。
- 桌面出包增加真实请求、凭据轮换与防落盘检查，并校验签名、公证及必要资源。
- 合并原生 Codex 自动下载、校验与启动回归测试，保留自定义 CODEX_BIN 配置 (#888)。
- 修复应用入口页与非成功静态资源响应的缓存策略 (#884)。
