// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasNode, NodeToolType } from '../domain/canvasNodes';
import type { ToolProcessorResult } from '../application/ports';

export type ToolOptionPrimitive = string | number | boolean;
export type ToolOptions = Record<string, ToolOptionPrimitive>;

interface ToolFieldBase {
  key: string;
  /** 展示名的词条 key——工具 schema 里只留 key，文案跟着界面语言走。 */
  labelKey: string;
}

export interface ToolTextField extends ToolFieldBase {
  type: 'text';
  placeholder?: string;
}

export interface ToolNumberField extends ToolFieldBase {
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
}

export interface ToolSelectField extends ToolFieldBase {
  type: 'select';
  options: Array<{
    value: string;
    /** 词条 key。与 `label` 二选一，两者都在时以它为准。 */
    labelKey?: string;
    /** 「16:9」这类跟语言无关的字面量，直接照原样显示。 */
    label?: string;
  }>;
}

export interface ToolColorField extends ToolFieldBase {
  type: 'color';
}

export type ToolFieldSchema =
  | ToolTextField
  | ToolNumberField
  | ToolSelectField
  | ToolColorField;

export interface ToolExecutionContext {
  processTool: (
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>
  ) => Promise<ToolProcessorResult>;
}

export type ToolIconKey = 'crop' | 'annotate' | 'split';
export type ToolEditorKind = 'form' | 'crop' | 'annotate' | 'split';

export interface CanvasToolPlugin {
  type: NodeToolType;
  labelKey: string;
  icon: ToolIconKey;
  editor: ToolEditorKind;
  supportsNode: (node: CanvasNode) => boolean;
  createInitialOptions: (node: CanvasNode) => ToolOptions;
  fields: ToolFieldSchema[];
  execute: (
    sourceImageUrl: string,
    options: ToolOptions,
    context: ToolExecutionContext
  ) => Promise<ToolProcessorResult>;
}
