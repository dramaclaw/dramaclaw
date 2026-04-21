# Roadmap

> **Last updated:** 2026-04-21
>
> DramaClaw's roadmap is organised around **four content scenarios**. Each scenario
> is a real production format we want the open pipeline to cover end-to-end. Under
> each scenario we list the capabilities that need to land before it can be called
> «shipped». Technical infrastructure milestones sit in a separate section below.

<br/>

## Stage 1 &mdash; Novel-to-drama narration (小说推文解说剧)

**Status:** 🟢 *in progress &mdash; this is what the first public release targets*

The category DramaClaw is opening the engine on. A long-form novel walks in,
a narrated short-drama series walks out &mdash; script, storyboards, first frames,
voice-over, finished episodes.

- [x] Novel ingestion & story graph
- [x] Character extraction & identity management
- [x] Episode planning & beat decomposition
- [x] Script generation (adaptive / literal / staged modes)
- [x] Storyboards & first-frame image generation
- [x] Voice-over synthesis (multi-provider)
- [x] Video composition & export
- [ ] One-command local setup (`docker run` works out of the box)
- [ ] Web studio polish &mdash; in-browser editing for scripts and beat revisions
- [ ] Cookbook: three reference novels with step-by-step walkthroughs

<br/>

## Stage 2 &mdash; Animated shorts (AI 漫剧)

**Status:** 🟡 *scoped, not started*

Stylised comic / animated shorts. Same pipeline, swap the render stage for
frame-consistent animation and panel-based composition.

- [ ] Panel layout planner (beat &rarr; panel grid)
- [ ] Animation-style image pipeline (consistent line art, palette lock)
- [ ] Lip-sync and subtle motion between beats
- [ ] Sound design hooks (ambient track per scene)

<br/>

## Stage 3 &mdash; Live-action shorts (AI 真人短剧)

**Status:** 🟠 *exploring*

Character-driven live-action short dramas. The hard part is identity persistence
across shots when the renderer is a video model, not a still image generator.

- [ ] Character identity anchors that survive a video model
- [ ] Shot planning with cinematic grammar (establishing / close-up / cutaway)
- [ ] Dialogue-driven clip generation
- [ ] Continuity pass (costume / prop / lighting consistency checker)

<br/>

## Stage 4 &mdash; IP incubation (虚拟角色 IP 孵化)

**Status:** 🔵 *research*

The long game: treat a character as a persistent IP that can appear across
formats &mdash; one protagonist, many stories, many episodes, many mediums.

- [ ] Character bible that travels with the IP across projects
- [ ] Style/voice locks that outlast a single series
- [ ] Cross-series memory for recurring cast
- [ ] Publishing hooks for distribution platforms

<br/>

---

## Infrastructure milestones

Not scenario-specific &mdash; the foundation that benefits every stage above.

### Deployment
- [ ] Helm chart + one-command Kubernetes install
- [ ] Prebuilt cloud templates (AWS / GCP / Aliyun)
- [ ] Remote render cluster mode (decouple control plane from GPU pool)

### Extensibility
- [ ] Plugin system for custom pipeline stages
- [ ] Webhook hooks between stages (trigger external tooling)
- [ ] Additional LLM / image / TTS providers (community PRs welcome)

### Observability
- [ ] Per-stage cost & token tracking surfaced in the studio
- [ ] Timing / quality metrics dashboard
- [ ] Structured event stream for downstream analytics

<br/>

---

## How to influence the roadmap

- **Vote on issues** labelled [`roadmap`](https://github.com/dramaclaw/dramaclaw/issues?q=is%3Aopen+label%3Aroadmap) &mdash; the ones with the most reactions move up.
- **Propose a new stage** via the [feature request form](./.github/ISSUE_TEMPLATE/feature_request.yml).
- **Sponsor a milestone** &mdash; targeted funding accelerates specific items. See [FUNDING.yml](./.github/FUNDING.yml) when channels are live.

We keep this document honest: if an item is not started, we say so.
