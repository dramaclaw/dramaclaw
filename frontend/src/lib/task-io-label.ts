// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFn } from "@/lib/i18n-types";

/**
 * 任务详情里的「输入 → 产物」两行（metadata 的 source_label / target_label）是
 * freezone 路由写死的中文，英文界面下会整段漏出来。
 *
 * 这里走展示层字典而不是「后端改发 code」：`source_label` 不只是展示串，
 * freezone.py:1395 还把它当生成管线的数据用（写进 canvas_scene_refs[].label），
 * 在产出端换成 code 会连带改掉管线输入。所以后端一个字不动，只在渲染时翻译，
 * 认不出的值原样回显（新增的标签在补词条前显示中文，总好过显示裸 key）。
 *
 * 词条的中文值与这里的 key 逐字相同，中文界面渲染结果不变。
 */
// i18n-exempt-start
const TASK_IO_LABEL_KEYS: Record<string, string> = {
  // source_label
  "Beat 上下文": "taskCenter.io.beatContext",
  "Master + Reverse": "taskCenter.io.masterReverse",
  "场景 Master + Reverse": "taskCenter.io.sceneMasterReverse",
  导演合成图: "taskCenter.io.directorComposite",
  背景: "taskCenter.io.background",
  当前背景: "taskCenter.io.currentBackground",
  背景候选: "taskCenter.io.backgroundCandidate",
  输入参考: "taskCenter.io.inputReference",
  "草图 + 背景 + 身份/道具": "taskCenter.io.sketchBackgroundIdentityProps",
  // target_label
  "360 全景": "taskCenter.io.pano360",
  当前草图: "taskCenter.io.currentSketch",
  草图候选: "taskCenter.io.sketchCandidate",
  当前草图候选: "taskCenter.io.currentSketchCandidate",
  当前分镜: "taskCenter.io.currentStoryboard",
  分镜候选: "taskCenter.io.storyboardCandidate",
};
// i18n-exempt-end

/** 认得的输入/产物标签返回本地化文案，认不得就原样回显。 */
export function taskIoLabel(value: string | null | undefined, t: TFn): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const key = TASK_IO_LABEL_KEYS[raw];
  return key ? t(key) : raw;
}
