# 画布深度动作参考：Depth Anything 3 技术方案与一期落地

更新日期：2026-09-14。此文是用户附件逆向研究报告的 DA3 实施版；报告中的原片实测仍有效，早先以 VDA-S 为默认模型的工程设计由本文替代。

## 结论与模型边界

默认选官方 **DA3-SMALL**（0.08B，模型卡 Apache 2.0）；后续质量对比可试 **DA3-BASE**（0.12B，同许可证），而非默认引入非商业许可的 Large/Giant。DA3 主系列的 `Prediction.depth` 是 z-depth（值大表示远），不能套用 DA2 的“值大表示近”转换。这个灰度视频是相对空间结构和动作参考，不是 BVH/SMPL 骨骼，不输出米制测距，也不保证下游生成器按像素级遵从。参照 [官方仓库和模型卡](https://github.com/ByteDance-Seed/Depth-Anything-3)、[官方 Python API](https://github.com/ByteDance-Seed/Depth-Anything-3/blob/main/docs/API.md)。

LibTV 样本为 8s/25fps/200 帧；原始 832×480，平台 720P 结果实际上是 1872×1080。本产品档位改为确定性导出：480p 为 832×480，720p 为 1248×720（保持该样本 26:15 画幅，偶数宽）；不把模型 `process_res=504` 和导出分辨率混为一谈。深度图近白远黑、无音频、同 CFR 帧率和帧数。

## 已落地的一期执行链路

```text
画布视频节点 → “逐帧拉片” → 480P/720P → 项目同源静态 URL 校验
  → freezone_depth_motion 任务 / world GPU 队列
  → 可选 ST_DA3_PYTHON 子进程，按本地 ST_DA3_MODEL_DIR 加载 DA3-SMALL
  → FFprobe + FFmpeg 解码全帧 → 三个代表帧检测稳定黑边、裁切临时推理图
  → RGB 缩略差异切硬镜 → 各镜头 16 帧窗口 / 3 帧重叠推理
  → 重叠分位数仿射尺度对齐 → 每镜头统一 P2/P98
  → z-depth 反向归一化（近白远黑）→ 黑边固定补远景 0
  → 灰度 PNG → H.264/yuv420p/+faststart 静音 MP4 + JSON manifest
  → 独立派生视频节点（referenceOnly、depthMotionRole、depthManifestUrl）
  → 连入全能参考的视频节点：role=depth_motion + 专用提示词
```

关键文件：`src/novelvideo/freezone/depth_motion.py` 负责隔离启动和取消；`depth_motion_worker.py` 负责模型、场景分段、量化、导出；`api/routes/freezone.py` 做项目权限与产物 URL；`task_backend/runners/freezone.py` 做本地 leaf 分类；`frontend/src/features/canvas/nodes/VideoNode.tsx` 做画布交互与任务恢复。推理进程不在 API 进程导入 torch，任务不临时联网下载权重。GPU/world 任务和其他重任务共享容量，应保留单并发和排队上限。

API：

```http
POST /api/v1/projects/{project}/freezone/video/depth-motion
Content-Type: application/json

{"source_url":"/static/projects/{project}/freezone/_uploads/source.mp4","resolution":"720p"}
```

返回现有 `FreezoneJobAcceptedResponse`（`task_type=freezone_depth_motion`、`job_id`、`task_key`）；完成后 `GET /projects/{project}/freezone/jobs/freezone_depth_motion/{job_id}/result` 的 `data` 包含 `url`、`manifest_url`、`size`、`meta`。源视频地址不可为外链或其他项目文件。画布源节点的 `depthPending` 保存任务指针，重载后可恢复轮询；派生结果保留源节点 id 与参考角色，源视频不被改写。

## 运行环境（模型是可选能力）

1. 在带 NVIDIA CUDA 的机器上准备**独立 Python 3.11 环境**，按官方依赖安装 torch/torchvision/xformers 与官方 DA3 项目（`pip install -e .`）；固定源代码 commit 与依赖版本。官方 API 支持本地模型目录，准备 `depth-anything/DA3-SMALL` 对应权重到仅运维可写的目录，记录模型 revision/SHA；检查权重文件与模型许可证，勿提交到仓库。
2. 让 worker 进程继承 `ST_DA3_PYTHON=/absolute/path/to/venv/bin/python` 与 `ST_DA3_MODEL_DIR=/absolute/path/to/DA3-SMALL`，保证路径与 worker 所在主机可见；安装 FFmpeg/FFprobe。子进程自动继承本仓库 `src` 的 `PYTHONPATH`。
3. 重启执行 `world` 队列的任务 worker。没有本地模型目录时任务明确失败；没有 `torch`/DA3 包或 CUDA 时子进程返回说明性错误。当前没有能力探测/入口禁用，也不会自动装包、下载模型。
4. 用提供的 8 秒/25fps/200 帧素材验收：源/结果 FFprobe 帧数和 FPS，相同时间点图像对照，6.44s 切镜不跨镜混合，上下黑边保持黑色，运动补偿后背景呼吸、袖摆拖影、多人遮挡质量。

官方发布的 **DA3-Streaming** 可用于后续超长片评估，但当前一期使用官方常规 `model.inference` 加应用层短窗口；这与官方 Streaming 的内存调度不是一回事，不能借官方宣传推断“一律低于 12GB”。短窗口也会让每个窗口独立估计相机/深度，跨窗口仿射对齐只稳定全局量纲，不能保证逐像素时序一致。参考 [官方 Streaming 说明](https://github.com/ByteDance-Seed/Depth-Anything-3/tree/main/da3_streaming)。

## 一期边界与第二期质量工程

目前最多 750 解码帧、输入最大 3840×2160，只面向恒定帧率；通过 FFprobe `avg_frame_rate` 与 `r_frame_rate` 的 1% 差异快速拒绝明显 VFR，但这不是逐帧 PTS 严格验证。推理在临时 PNG 中处理，任务取消会终止子进程；manifest 记录模型名、帧率/帧数、镜头范围、导出尺寸和裁掉的黑边。它尚未记录完整源 PTS、模型 commit/hash/置信度、每镜头 P2/P98，也没有 EXR/float 原始深度主数据。

下一迭代按优先级：

1. 解码侧解析每帧 PTS、rotation/SAR；VFR 规范化必须有精确 `source_pts → output_pts`，音视频时间轴验收和输入时长/分辨率限制。
2. 从 3 帧稳定黑边提升到 16–32 帧持久掩膜；把原片字幕/水印只从临时推理帧 inpaint，不改用户素材。样本原深度输出把黑边当近景，这应优先解决。
3. 记录相机预测/置信度与窗口尺度参数，构建光流 forward-backward 可靠区域、运动补偿的背景稳定（不对快速肢体做全局 EMA），并在硬切镜重置。
4. 加显存自适应窗口与 CUDA OOM 退避、常驻模型进程/缓存；长片单独评估官方 Streaming。升级为 DA3-BASE 的质量开关必须做显存/速度与许可证审查。
5. 质量门：输出帧数=输入帧数，镜头内归一化恒定、黑边稳定远景、深度有限、切镜无跨窗残影；在原 8s 样本与舞蹈/口播/多人片库统计运动补偿残差与动作迁移 A/B，不承诺尚未测量的改善数值。

测试见 `tests/test_freezone_depth_motion.py`（无 GPU 的契约/灰度方向/切镜/黑边/角色语义）；真实模型验收需要另跑 CUDA 机器，当前 macOS CPU/MPS 路径未验证。
