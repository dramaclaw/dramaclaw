DramaClaw - macOS 便携测试版(Apple Silicon)
=============================================

这是未签名的测试构建,用于验证原生 macOS 运行,不是正式发布物。
仅支持 Apple Silicon(M 系列);Intel Mac 需要另出 x86_64 包。

使用方法
--------
1. 解压本 zip 到任意目录
2. 双击 DramaClaw-Start.command 启动;双击 DramaClaw-Stop.command 停止
   - 若提示「无法打开,因为它来自身份不明的开发者」:
     右键点击 → 打开 → 再点「打开」;
     或在终端执行: xattr -dr com.apple.quarantine <解压目录>
3. 等待浏览器自动打开 http://127.0.0.1:8780
4. 首次使用:到「设置 → 模型配置 → 官方渠道」粘贴你的 DC key

数据位置
--------
~/Library/Application Support/DramaClaw(删除本目录不影响数据)

world / 3D 场景(3DGS/SHARP)
----------------------------
本包已内置 world 能力(CPU/MPS 推理 + 内置 Node 的 PLY->SOG 压缩)。
首次运行相关任务会自动从 HuggingFace 下载模型权重(数 GB,只下一次)。

已知限制
--------
- 更换 DC key 后请重启一次(Stop 再 Start)才会全面生效
- 停止服务时若有任务在跑,该任务会残留"运行中"状态,重启后请在任务中心手动终止
- 未签名/未公证:首次打开需按上述方式绕过 Gatekeeper
- Hermes worker 使用 macOS seatbelt 沙箱;若沙箱不可用会警告降级
- 「导出提示词」等受护动作默认关闭(未设 PROMPT_EXPORT_PASSWORD)

停止服务:关闭启动时弹出的终端窗口即可。
