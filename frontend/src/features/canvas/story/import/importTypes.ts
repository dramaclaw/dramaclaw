/** 导入解析的中间结构:两个解析器(.ink / .js.json)的共同产物。 */
export interface ImportedStory {
  variables: { name: string; initial: number }[];
  startKnot: string;
  knots: ImportedKnot[];
  warnings: string[];
}

export interface ImportedKnot {
  name: string;
  narration: string;
  videoHint?: string;
  tags: string[];
  isEnding: boolean;
  /** 结局标(# ending: X 的 X),仅结局 knot。 */
  endingLabel?: string;
  /** 选项窗口秒数(# choiceTime / # timeout)。未指定则不限时。 */
  choiceTimeLimitSec?: number;
  outgoing: ImportedLink[];
  warnings: string[];
}

export type ImportedLinkKind = 'choice' | 'divert' | 'autoConditional';

export interface ImportedLink {
  kind: ImportedLinkKind;
  text?: string;
  target: string;
  effects: { var: string; delta: number }[];
  condition?: string; // 原始条件文本(可能复合)
  needsReview: boolean;
  reviewNote?: string;
  /** 超时自动选中的默认选项(# default: N)。 */
  isDefault?: boolean;
}
