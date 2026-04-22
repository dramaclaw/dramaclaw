<div align="center">

<!-- TBD: 替换为正式 logo assets/logo.svg -->
<h1>DramaClaw</h1>

## Make Your Own DC Universe.

<p align="left">

他们说你过时了。<br/>
也许是「打工」这件事过时了。<br/>
<br/>
AI 时代，真正的问题不是机器会不会替代人。<br/>
真正的问题是：<br/>
谁拥有机器？<br/>
谁拥有流程？<br/>
谁拥有工业化生产力？<br/>
<br/>
如果答案永远是大厂，<br/>
那 AI 就不是平权。<br/>
那只是新的高墙。<br/>
<br/>
我是 Eric。<br/>
DramaClaw 即将开源。<br/>
<br/>
这不是 demo。<br/>
不是玩具。<br/>
不是阉割版。<br/>
<br/>
这是一条我们团队自己每天在跑的漫剧工业化生产线。<br/>
从脚本到分镜，从资产到成片，全链路。<br/>
<br/>
我们会完整开源。<br/>
<br/>
因为人不是牛马。<br/>
因为创造力，是人类最后的防线。<br/>
<br/>
DramaClaw 要做的事很简单：<br/>
<br/>
<strong>拆墙。</strong><br/>
<br/>
把过去只有大厂才有的漫剧工业化能力，<br/>
交到普通创作者手里。<br/>
<br/>
代码在路上。<br/>
认同的话，留下一颗 ⭐。<br/>
我们继续拆。

</p>

<br/>

[![License](https://img.shields.io/badge/License-TBD-lightgrey.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/dramaclaw/dramaclaw?style=social)](https://github.com/dramaclaw/dramaclaw/stargazers)
[![Release](https://img.shields.io/github/v/release/dramaclaw/dramaclaw?include_prereleases&sort=semver)](https://github.com/dramaclaw/dramaclaw/releases)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)](#quick-start)

[English](./README.md) &nbsp;|&nbsp; **简体中文** &nbsp;|&nbsp; [文档](#documentation) &nbsp;|&nbsp; [快速开始](#quick-start)

</div>

<br/>

<p align="center">
  <img src="./assets/hero.png" alt="DramaClaw — 讲故事的人，重新走回镜头前" width="820"/>
</p>

<!--
  演示视频 —— 上传完成后，把 user-attachments 链接单独一行粘到下面。
  上传方式：在 github.com 新建一个 Issue（别提交），把 demo 视频拖进正文，
  等它上传完会自动生成 https://github.com/user-attachments/assets/...mp4 链接，
  复制后粘到下面，再把 Issue 取消即可。GitHub 会把独占一行的 URL 渲染成内联播放器。

  https://github.com/user-attachments/assets/REPLACE-AFTER-UPLOAD
-->

<p align="center">
  <sub>更多画面：<a href="./SHOWCASE.md">作品画廊 &rarr;</a></sub>
</p>

<br/>

## DramaClaw 是什么？

DramaClaw 是一条**即将开源的漫剧工业化生产线**。丢进一本原稿，DramaClaw 会接管全部繁重工作：抽取角色、规划剧集、生成剧本、绘制分镜与首帧、合成配音、最终剪成成片。

它为创作者、独立工作室以及创意工程师而生 —— 让你在自己的基础设施上跑完整个「漫剧智造工厂」，不必再去拼接十几个割裂的工具，也不必把素材交给一个看不见内部的黑盒云服务。

<br/>

## 核心能力

- **小说解析与故事图谱** &mdash; 解析原稿，构建可查询的角色、关系、时间线图谱
- **角色抽取与身份一致性** &mdash; 多集之间保持稳定身份，生成角色肖像与单集变体
- **剧集规划与叙事节奏** &mdash; 自动章节切分、节拍规划、多集叙事弧
- **剧本生成** &mdash; 多种模式（改编、直译、分镜稿），带审校 / 修复循环
- **分镜与首帧** &mdash; 按节拍风格化生成图像，网格切分，图像池选优
- **配音合成** &mdash; 带情绪的语音合成，可切换多家服务商
- **视频合成与导出** &mdash; 组装剧集，导出视频 + 字幕文件、整套素材包

<br/>

## 全流程一览

```
┌─ 摄取 ───────────┐   ┌─ 规划 ─────────────┐   ┌─ 生产 ──────────────┐   ┌─ 交付 ──────┐
│                  │   │                    │   │                      │   │              │
│ 1. 创建项目       │   │ 5. 抽取角色        │   │ 9. 角色身份图        │   │ 15. 合成剪辑 │
│ 2. 上传原稿       │   │ 6. 剧集规划        │   │ 10. 剧本生成         │   │ 16. 导出成片 │
│ 3. 解析摄取       │──▶│ 7. 角色肖像        │──▶│ 11. 分镜手动调整     │──▶│              │
│ 4. 配置           │   │ 8. 身份方案        │   │ 12. 草图             │   │              │
│                  │   │                    │   │ 13. 首帧             │   │              │
│                  │   │                    │   │ 14. 配音             │   │              │
└──────────────────┘   └────────────────────┘   └──────────────────────┘   └──────────────┘
```

每一步都有独立的接口 —— 可以按顺序跑，可以跳过，也可以从任意检查点续跑，甚至接入你自己的编排器。

<br/>

## <a name="quick-start"></a>快速开始

### Docker（推荐）

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw

cp .env.example .env
# 编辑 .env —— 至少填一个大模型密钥和一个语音合成密钥

docker build -t dramaclaw:local .
docker run --rm -p 7860:7860 --env-file .env dramaclaw:local
```

打开 <http://localhost:7860> 即可进入 Web 工作台。

### 本地开发（uv + Python 3.10+）

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw

uv sync
cp .env.example .env && $EDITOR .env

make ray       # 启动 Ray 主节点（异步任务调度）
make ui        # 启动工作台，端口 :7860
```

### Kubernetes / Helm

即将发布 &mdash; [查看进度 &rarr;](./ROADMAP.md)

<br/>

## 支持的模型与服务商

DramaClaw 对模型侧保持中立。所有组件都能通过 `.env` 切换。

| 角色              | 可选服务商                                                          |
|-------------------|---------------------------------------------------------------------|
| **大模型**        | OpenAI · Anthropic · Gemini · OpenRouter · 火山引擎（豆包）          |
| **图像**          | Gemini nanobanana · 火山引擎 Seedream 4.5                           |
| **配音**          | Edge-TTS · 阿里 DashScope CosyVoice · Fish Audio                    |
| **故事图谱**      | LightRAG · Cognee（实验中）                                         |
| **异步运行时**    | Ray                                                                 |
| **存储**          | 本地文件系统 · 兼容 S3 的对象存储（MinIO / AWS / 阿里云 OSS）        |

<br/>

## 为什么是 DramaClaw？

**为小说转短剧而生。** 通用的工作流工具确实可以把节点拼起来，但它们不知道「剧集节拍」是什么，不懂为什么角色的跨场景身份一致性那么重要，也不会在图像 + 配音 + 剪辑里去守护一整章节的情绪弧。DramaClaw 把这些判断全部内建到工具里。

**每一步皆可拆解。** 每个阶段都是一个独立的异步任务，各有独立接口。你可以顺序跑、跳步跑、中途续跑，这套工具本身就是产品 —— 里面不藏黑箱。

**可自托管，模型中立。** 你的原稿、你的角色、你的模型、你的服务器。需要最好的效果时用闭源大模型；需要完全可控时切到开源模型。DramaClaw 不会把你绑死在任何一家。

<br/>

## <a name="documentation"></a>文档

- [架构概览](./docs/architecture.md) <!-- TBD -->
- [接口参考](./docs/api-reference.md) <!-- TBD -->
- [全流程详解](./docs/pipeline.md) <!-- TBD -->
- [配置与服务商](./docs/configuration.md) <!-- TBD -->

<br/>

## 加入社区 / 一起贡献

- [提交 Bug](https://github.com/dramaclaw/dramaclaw/issues/new?template=bug_report.yml)
- [提功能建议](https://github.com/dramaclaw/dramaclaw/issues/new?template=feature_request.yml)
- [参与讨论](https://github.com/dramaclaw/dramaclaw/discussions)
- [贡献指南](./CONTRIBUTING.md) <!-- TBD — 随首批代码一起发布 -->
- [安全策略](./SECURITY.md)

我们会持续整理并标记 [`good first issue`](https://github.com/dramaclaw/dramaclaw/labels/good%20first%20issue) —— 欢迎从这里起手。

<br/>

## 路线图

详见 [`ROADMAP.md`](./ROADMAP.md)。主要节点：

- **阶段一 &mdash; 小说推文解说剧**（当前聚焦）：我们打开这个引擎的第一个品类
- **阶段二 &mdash; AI 漫剧**：风格化漫画 / 动画短剧生产
- **阶段三 &mdash; AI 真人短剧**：以角色为核心的真人短剧流水线
- **阶段四 &mdash; IP 孵化**：跨形态延续的虚拟角色与 IP

<br/>

## 许可证

许可证：待定 &mdash; 将在首批代码发布时一同公布。

<br/>

## 星标走势

<a href="https://star-history.com/#dramaclaw/dramaclaw&Date">
  <img src="https://api.star-history.com/svg?repos=dramaclaw/dramaclaw&type=Date" alt="Star history" width="620"/>
</a>

<br/><br/>

<div align="center">
  <sub>为讲故事的人而建。开源给所有人。</sub>
</div>
