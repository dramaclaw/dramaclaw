// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  propRefCandidateCapability,
  renderRepairCandidateCapability,
  scene360CandidateCapability,
  sceneMasterCandidateCapability,
  startFrameCandidateCapability,
} from "./candidate_capabilities";
import {
  characterMultiViewCapability,
  portraitFromRefCapability,
} from "./portrait_from_ref";
import { realSceneSketchRepairCapability } from "./real_scene_sketch_repair";

export type CapabilityCategory = "character" | "scene" | "beat" | "video" | "utility";
export type CapabilityParamType = "enum" | "multiselect" | "slider" | "text" | "boolean";

export interface CapabilityInputDefinition {
  key: string;
  labelKey: string;
  required: boolean;
  acceptKinds: string[];
  descriptionKey?: string;
}

export interface CapabilityParamOption {
  /** 协议值：会原样拼进提示词或写进节点参数，不跟界面语言走。 */
  value: string;
  labelKey: string;
  /**
   * 少数能力（实景草图修复）把选项文案本身拼进提示词。那串是模型输入不是界面文案，
   * 改动会直接改变生成结果，所以单独放一份，不跟界面语言走。
   */
  promptLabel?: string;
}

export interface CapabilityParamDefinition {
  key: string;
  labelKey: string;
  type: CapabilityParamType;
  defaultValue?: unknown;
  options?: CapabilityParamOption[];
  min?: number;
  max?: number;
  step?: number;
  descriptionKey?: string;
}

export interface CapabilityComposeContext {
  inputUrls: string[];
  params: Record<string, unknown>;
  nodePrompt?: string;
  metadata?: Record<string, unknown> | null;
}

export interface ComposedCapabilityJob {
  prompt: string;
  referenceUrls: string[];
  model: string;
  aspectRatio: string;
  imageSize: string;
  quality?: string;
  outputKind?: string;
}

export interface GenerationCapability {
  id: string;
  /** 能力的展示文案全部落成词条 key（`canvas.capabilities.<id>.*`），渲染时才解析。 */
  nameKey: string;
  shortNameKey: string;
  category: CapabilityCategory;
  descriptionKey: string;
  outputKind: string;
  model: string;
  aspectRatio: string;
  imageSize: string;
  inputs: CapabilityInputDefinition[];
  params: CapabilityParamDefinition[];
  compose: (context: CapabilityComposeContext) => ComposedCapabilityJob;
}

export const CAPABILITIES: GenerationCapability[] = [
  realSceneSketchRepairCapability,
  portraitFromRefCapability,
  characterMultiViewCapability,
  sceneMasterCandidateCapability,
  scene360CandidateCapability,
  propRefCandidateCapability,
  renderRepairCandidateCapability,
  startFrameCandidateCapability,
];

const capabilityMap = new Map(CAPABILITIES.map((capability) => [capability.id, capability]));

export function listCapabilities(): GenerationCapability[] {
  return CAPABILITIES;
}

export function getCapability(capabilityId: string | null | undefined): GenerationCapability | null {
  if (!capabilityId) return null;
  return capabilityMap.get(capabilityId) ?? null;
}

export function defaultCapabilityParams(capability: GenerationCapability): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const param of capability.params) {
    if (param.defaultValue !== undefined) {
      params[param.key] = param.defaultValue;
    } else if (param.type === "multiselect") {
      params[param.key] = [];
    } else if (param.options?.[0]) {
      params[param.key] = param.options[0].value;
    } else if (param.type === "boolean") {
      params[param.key] = false;
    } else {
      params[param.key] = "";
    }
  }
  return params;
}

export function composeCapability(
  capabilityId: string,
  context: CapabilityComposeContext,
): ComposedCapabilityJob | null {
  const capability = getCapability(capabilityId);
  if (!capability) return null;
  return capability.compose(context);
}

export function stringifyParamValue(value: unknown): string {
  if (Array.isArray(value)) return value.filter(Boolean).join(" / ");
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
