// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 这里拼的是发给图像模型的提示词，不是界面文案。改动会直接改变生成结果，
 * 所以整份保持中文，不跟界面语言走。
 */
// i18n-exempt-start
import type { ContextMatch } from "./contextMatching";
import type { MainlineContext } from "./mainlineContext";

function compactList(values: Array<string | undefined | null>): string {
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join("、");
}

function beatLabel(beat: MainlineContext | undefined): string {
  if (!beat || typeof beat.episode !== "number" || typeof beat.beat !== "number") {
    return "未知 Beat";
  }
  return `EP${beat.episode} / Beat ${beat.beat}`;
}

function renderMap(title: string, values: Record<string, string> | undefined): string[] {
  if (!values || Object.keys(values).length === 0) return [];
  return [
    `${title}: ${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("、")}`,
  ];
}

function renderCommonFacts(match: ContextMatch): string[] {
  const beat = match.beat;
  const lines = [
    `主线目标: ${beatLabel(beat)}`,
  ];

  if (beat?.visualDescription) {
    lines.push(`草图首帧 visual_description: ${beat.visualDescription}`);
  }

  if (beat?.sceneId || match.scene?.sceneId) {
    lines.push(`场景: ${beat?.sceneId || match.scene?.sceneId}`);
  }

  const identities = compactList(
    match.identities.map((ctx) => ctx.identityId || ctx.character || ctx.label),
  );
  if (identities) {
    lines.push(`匹配身份: ${identities}`);
  }

  const props = compactList(match.props.map((ctx) => ctx.propId || ctx.label));
  if (props) {
    lines.push(`匹配道具: ${props}`);
  }

  lines.push(...renderMap("身份颜色映射", beat?.sketchColors));
  lines.push(...renderMap("道具颜色映射", beat?.propMarkerColors));

  if (beat?.narrationSegment) {
    lines.push(`旁白/台词参考: ${beat.narrationSegment}`);
  }

  return lines;
}

function compileHeader(operation: string, match: ContextMatch): string {
  return [
    "[主线上下文]",
    `操作: ${operation}`,
    `匹配: ${match.reason}`,
    ...renderCommonFacts(match),
  ].join("\n");
}

export function compileDirectorCombinedToSketchPrompt(match: ContextMatch): string {
  return [
    compileHeader("导演合成图生成草图", match),
    "把输入的导演合成图作为当前 beat 的导演构图参考，生成可用于主线的草图候选。",
    "保持图中的角色站位、机位、镜头裁切、背景锚点和颜色标记关系。",
    "不要把颜色标记当成真实服装或道具；它们只用于身份/道具绑定。",
    "输出应服务于 visual_description 的 t=0 首帧，不要提前画到动作结果帧。",
  ].join("\n");
}

export function compileSelectedBackgroundToSketchPrompt(match: ContextMatch): string {
  return [
    compileHeader("当前背景生成草图", match),
    "把输入的 selected_background 作为当前 beat 的背景/机位参考，生成可用于主线的草图候选。",
    "selected_background 是这个 beat 的当前背景 slot，可来源于 master、reverse、director_env、360、上传图或编辑图。",
    "保持背景透视、地面/墙面关系、桌椅/门窗等大形位置和主线场景一致。",
    "根据 visual_description 补入角色、道具和 t=0 首帧动作状态。",
  ].join("\n");
}

export function compileBeatToSketchPrompt(match: ContextMatch): string {
  return [
    compileHeader("Beat 生成草图", match),
    "根据当前 Beat 的 visual_description 生成可用于主线的草图候选。",
    "草图必须表达视频 t=0 首帧，不要提前画到后续动作峰值或结果帧。",
    "身份、道具和颜色标记关系以后端主线 DB 为准；画面应清晰可读，便于导演判断分镜。",
  ].join("\n");
}

export function compileFrameGenerationContextPrompt(match: ContextMatch): string {
  return [
    compileHeader("草图生成分镜", match),
    "把输入草图作为主线 beat 的首帧构图，生成分镜候选。",
    "严格保留草图中的人物位置、身份颜色映射、道具颜色映射、镜头视角和画面布局。",
    "使用匹配的身份、场景、道具参考来提升一致性，但不要改写 beat 的 t=0 首帧事实。",
    "输出应该是干净可用的分镜画面，不要保留草图标注、箭头、色块或文字标签。",
  ].join("\n");
}
// i18n-exempt-end
