---
version: 2.1.1
attention: high
---
# v2.1.1

## User-facing Highlights (zh)

- **修复桌面虾导**: 桌面版与绿色版使用凭据保护版 Codex 0.164.0，修复升级后虾导无法回复的问题。
- **更可靠的启动**: 改善 Windows 启动兼容性，并为 Mac 首次初始化助手留出足够时间。
- **更准确的错误提示**: 本地助手启动失败会提示检查应用，避免误报为上游模型连接失败。

## User-facing Highlights (en)

- **Desktop assistant repaired**: Desktop and portable apps use the credential-safe Codex 0.164.0 runtime, fixing assistant failures after upgrading.
- **More reliable startup**: Improved Windows compatibility and allowed enough time for the assistant's first initialization on Mac.
- **Clearer errors**: Local assistant startup failures now suggest checking the app instead of reporting an upstream model connection failure.

## Fixes

- 保留每轮凭据隔离、只读沙箱和默认拒绝本地命令及文件修改审批。
- 修复 Windows 文件锁、进程存活探测及私有助手通信目录的兼容性。
- 桌面出包增加真实请求、凭据轮换与防落盘检查，并校验签名、公证及必要资源。
