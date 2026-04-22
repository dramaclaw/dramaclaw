<div align="center">

<!-- TBD: replace with real logo at assets/logo.svg -->
<h1>DramaClaw</h1>

## Make Your Own DC Universe.

<p align="left">

They say you're obsolete.<br/>
Maybe it's the "day job" that's obsolete.<br/>
<br/>
In the age of AI, the real question is not whether machines will replace people.<br/>
The real question is:<br/>
Who owns the machines?<br/>
Who owns the workflow?<br/>
Who owns industrialized production?<br/>
<br/>
If the answer is always big companies,<br/>
then AI is not democratization.<br/>
It is just a new wall.<br/>
<br/>
I'm Eric.<br/>
DramaClaw is about to be open-sourced.<br/>
<br/>
This is not a demo.<br/>
Not a toy.<br/>
Not a crippled edition.<br/>
<br/>
This is the industrialized drama-production line our team runs every day.<br/>
From scripts to storyboards, from assets to final cuts, end to end.<br/>
<br/>
We will open-source the whole thing.<br/>
<br/>
Because people are not workhorses.<br/>
Because creativity is humanity's last line of defense.<br/>
<br/>
What DramaClaw does is simple:<br/>
<br/>
<strong>Tear down the wall.</strong><br/>
<br/>
Put industrialized drama production,<br/>
once available only to large studios,<br/>
into the hands of ordinary creators.<br/>
<br/>
Code is on the way.<br/>
If this resonates, leave a ⭐.<br/>
We keep tearing down walls.

</p>

<br/>

[![License](https://img.shields.io/badge/License-TBD-lightgrey.svg)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/dramaclaw/dramaclaw?style=social)](https://github.com/dramaclaw/dramaclaw/stargazers)
[![Release](https://img.shields.io/github/v/release/dramaclaw/dramaclaw?include_prereleases&sort=semver)](https://github.com/dramaclaw/dramaclaw/releases)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)](#quick-start)
<!-- TBD: Discord / Discussions / CI badges -->

**English** &nbsp;|&nbsp; [简体中文](./README.md) &nbsp;|&nbsp; [Docs](#documentation) &nbsp;|&nbsp; [Quick Start](#quick-start)

</div>

<br/>

<!-- Hero demo -->
<p align="center">
  <img src="./assets/hero.png" alt="DramaClaw &mdash; stories for the ones life held on to" width="820"/>
</p>

<!--
  DEMO VIDEO — paste the user-attachments URL here on its own line after uploading.
  Upload flow: open github.com → new issue (do NOT submit) → drag the demo mp4 into
  the issue body → copy the resulting https://github.com/user-attachments/assets/...mp4
  URL → paste below, cancel the issue draft. GitHub renders a bare URL as an inline player.

  https://github.com/user-attachments/assets/REPLACE-AFTER-UPLOAD
-->

<p align="center">
  <sub>See more: <a href="./SHOWCASE.md">Showcase gallery &rarr;</a></sub>
</p>

<br/>

## What is DramaClaw?

DramaClaw is a **soon-to-be-open-sourced industrialized production line for turning novels into short-form dramas**. Drop in a manuscript and DramaClaw handles the heavy lifting end-to-end: extracting characters, planning episodes, writing scripts, generating storyboards and first-frame images, synthesising voice-over, and composing the final cut.

It is built for writers, indie studios, and creative engineers who want to run the entire drama factory on infrastructure they control &mdash; without gluing together a dozen disjoint tools or handing source material to an opaque SaaS.

<br/>

## Key Capabilities

- **Novel ingestion & story graph** &mdash; parse raw manuscripts, build a queryable graph of characters, relationships, and timeline
- **Character extraction & identity consistency** &mdash; per-character identity anchors that hold up across episodes, with portrait generation and per-episode variants
- **Episode planning & narrative pacing** &mdash; automatic chapter detection, beat planning, multi-episode arc construction
- **Script generation** &mdash; multiple modes (adaptive rewrite, literal, staged) with reviewer/fixer loops
- **Storyboards & first-frame images** &mdash; style-controlled generation per beat, grid cutting, pool selection
- **Voice-over (TTS)** &mdash; emotional speech synthesis with swappable provider backends
- **Video composition & export** &mdash; compose episodes, export MP4 + SRT subtitles, per-project asset bundles

<br/>

## The Pipeline

```
┌─ Ingestion ──────┐   ┌─ Planning ────────┐   ┌─ Production ─────────┐   ┌─ Delivery ──┐
│                  │   │                    │   │                      │   │              │
│  1. Create       │   │  5. Extract chars  │   │  9. Identity images  │   │ 15. Compose  │
│  2. Upload novel │   │  6. Plan episodes  │   │ 10. Script gen       │   │ 16. Export   │
│  3. Parse/ingest │──▶│  7. Portraits      │──▶│ 11. Staging manual   │──▶│              │
│  4. Configure    │   │  8. Plan identity  │   │ 12. Sketches         │   │              │
│                  │   │                    │   │ 13. First frames     │   │              │
│                  │   │                    │   │ 14. Voice-over (TTS) │   │              │
└──────────────────┘   └────────────────────┘   └──────────────────────┘   └──────────────┘
```

Every stage is addressable through the REST API &mdash; call stages individually, resume from checkpoints, or drive them from your own orchestrator.

<br/>

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw

cp .env.example .env
# edit .env — at minimum set one LLM key and one TTS key

docker build -t dramaclaw:local .
docker run --rm -p 7860:7860 --env-file .env dramaclaw:local
```

Open <http://localhost:7860> for the web studio.

### Local development (uv + Python 3.10+)

```bash
git clone https://github.com/dramaclaw/dramaclaw.git
cd dramaclaw

uv sync
cp .env.example .env && $EDITOR .env

make ray       # start Ray head (async tasks)
make ui        # start the studio on :7860
```

### Kubernetes / Helm

<!-- TBD: publish Helm chart once ready. -->
Coming soon &mdash; [track progress &rarr;](./ROADMAP.md)

<br/>

## Supported Models & Providers

DramaClaw is model-agnostic. Swap any component by editing `.env`.

| Role              | Providers                                                           |
|-------------------|---------------------------------------------------------------------|
| **LLM**           | OpenAI · Anthropic · Gemini · OpenRouter · Volcengine (Doubao)      |
| **Image**         | Gemini nanobanana · Volcengine Seedream 4.5                         |
| **TTS**           | Edge-TTS · Alibaba DashScope CosyVoice · Fish Audio                 |
| **Story graph**   | LightRAG · Cognee (experimental)                                    |
| **Async runtime** | Ray                                                                 |
| **Storage**       | Local filesystem · S3-compatible (MinIO / AWS / OSS)                |

<br/>

## Why DramaClaw?

**Purpose-built for novel-to-drama.** General-purpose workflow tools can stitch nodes together, but none of them understand what an *episode beat* is, why identity consistency across scenes matters, or how to keep a chapter's emotional arc intact through image + voice + cut. DramaClaw encodes those assumptions directly into the pipeline.

**Composable by design.** Every stage is a discrete async task with a REST endpoint. Call them in order, skip the ones you don't need, or resume from an intermediate checkpoint. The pipeline is the product &mdash; there's no hidden magic.

**Self-hosted and model-agnostic.** Your manuscripts, your characters, your models, your infrastructure. Use closed-source LLMs when you want the best quality; switch to open models when you need control. DramaClaw doesn't lock you to any single vendor.

<br/>

## Documentation

- [Architecture overview](./docs/architecture.md) <!-- TBD -->
- [API reference](./docs/api-reference.md) <!-- TBD -->
- [Pipeline deep-dive](./docs/pipeline.md) <!-- TBD -->
- [Configuration & providers](./docs/configuration.md) <!-- TBD -->

<br/>

## Community & Contribute

- [Report a bug](https://github.com/dramaclaw/dramaclaw/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/dramaclaw/dramaclaw/issues/new?template=feature_request.yml)
- [Join the discussion](https://github.com/dramaclaw/dramaclaw/discussions) <!-- TBD: enable Discussions -->
- [Contribution guide](./CONTRIBUTING.md) <!-- TBD — arrives with first code drop -->
- [Security policy](./SECURITY.md)

Good first issues are labelled [`good first issue`](https://github.com/dramaclaw/dramaclaw/labels/good%20first%20issue) &mdash; we actively triage them.

<br/>

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for the milestones ahead. Highlights:

- **Stage 1 &mdash; Novel-to-drama narration** (current focus): 小说推文解说剧, the category we're opening the engine on
- **Stage 2 &mdash; Animated shorts (AI 漫剧)**: stylised comic/animation output
- **Stage 3 &mdash; Live-action shorts (AI 真人短剧)**: character-driven live-action pipelines
- **Stage 4 &mdash; IP incubation**: virtual character continuity across formats

<br/>

## License

<!-- TBD: license to be finalised before first code drop. -->
License: TBD &mdash; will be finalised with the first code release.

<br/>

## Star History

<a href="https://star-history.com/#dramaclaw/dramaclaw&Date">
  <img src="https://api.star-history.com/svg?repos=dramaclaw/dramaclaw&type=Date" alt="Star history" width="620"/>
</a>

<br/><br/>

<div align="center">
  <sub>Built for storytellers. Open-sourced for everyone.</sub>
</div>
