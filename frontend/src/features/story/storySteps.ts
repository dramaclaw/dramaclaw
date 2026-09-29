// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 创作流程的步骤注册表 —— 这个文件是整块功能的扩展点。
 *
 * 加一个步骤 = 往 STORY_STEPS 里加一条，不需要动页面、路由、后端。
 * 这样安排是因为创作流程本身还会变（short-drama skill 的命令集也在演进），
 * 把顺序和产物形态写死在组件里，每改一次流程就要翻一遍 UI 代码。
 *
 * 约定：`docId` 同时是后端存储的键。改名等于换一份文档，所以不要改已上线的 id。
 */
import type { LucideIcon } from 'lucide-react';
import { BookLock, ClipboardList, Users, ListOrdered, FileText, PackageCheck } from 'lucide-react';

/** 一个步骤的产物形态。决定右侧用哪个编辑器渲染。 */
export type StoryDocKind =
  /** 结构化约束层，有专属编辑器 */
  | 'bible'
  /** 一整篇 markdown，通用编辑器 */
  | 'markdown'
  /** 一集一份的草稿集合 */
  | 'episodes'
  /** 只读的校验与交接面板 */
  | 'compile';

export interface StoryStep {
  id: string;
  /** 后端 story/docs 的 doc_id；compile 这类不落文档的步骤为 null。 */
  docId: string | null;
  kind: StoryDocKind;
  icon: LucideIcon;
  /** i18n key 前缀，实际取 `${i18nKey}.title` / `.hint` */
  i18nKey: string;
}

export const STORY_STEPS: readonly StoryStep[] = [
  { id: 'bible', docId: 'bible', kind: 'bible', icon: BookLock, i18nKey: 'story.step.bible' },
  { id: 'plan', docId: 'plan', kind: 'markdown', icon: ClipboardList, i18nKey: 'story.step.plan' },
  { id: 'characters', docId: 'characters', kind: 'markdown', icon: Users, i18nKey: 'story.step.characters' },
  { id: 'outline', docId: 'outline', kind: 'markdown', icon: ListOrdered, i18nKey: 'story.step.outline' },
  { id: 'episodes', docId: 'episodes', kind: 'episodes', icon: FileText, i18nKey: 'story.step.episodes' },
  { id: 'compile', docId: null, kind: 'compile', icon: PackageCheck, i18nKey: 'story.step.compile' },
] as const;

export function storyStepById(id: string): StoryStep | undefined {
  return STORY_STEPS.find((step) => step.id === id);
}

// ─── 故事圣经的数据形状 ───────────────────────────────────────────────────
//
// 为什么单独给它一套结构而不是也用 markdown：它不是给人读的文档，是**每一次
// 生成都要重新注入模型的约束**。要能按条目取用、按条目失效下游，就必须是结构化的。

export interface CastLockEntry {
  name: string;
  /** 绑定到哪个阶段/时期 */
  bind: string;
  /** 人物弧线一句话 */
  arc: string;
  /** 必须出现的名场面 */
  mustHave: string[];
}

export interface StructureLockEntry {
  /** 阶段名，如「宛城转折期」。同时是分集草稿引用它的键。 */
  stage: string;
  /** 主线事件 */
  plot: string;
  /** 绑定人物 */
  bind: string;
  /** 情感基调 */
  tone: string;
  /**
   * 本阶段的额外要求（例：「典韦的死要拍满，至少两个场次」）。
   *
   * 这类条款**必须挂在阶段上而不是集号上**：分集是会动的——13 个阶段压成 20 集
   * 还是 60 集，同一个阶段落在第几集完全不同，一旦重排，按集号存的条款就跟丢了，
   * 而且丢得无声无息。挂在阶段上，怎么排都不会错位。
   */
  notes?: string;
}

export interface StoryBible {
  /** 全局锁：每一次生成都注入 */
  locks: {
    positioning: string;
    era: string;
    toneRules: string[];
    dialogueStyle: string;
  };
  /** 负面清单：注入 + 用于成稿自检 */
  blacklist: string[];
  /** 角色锁：/characters 的输入而非输出 */
  castLock: CastLockEntry[];
  /** 结构锁：/outline 的输入而非输出。阶段级额外要求也放在这里（见 notes）。 */
  structureLock: StructureLockEntry[];
  /**
   * 遗留：按集号存的单集条款。
   *
   * 已被 `structureLock[].notes` 取代——按集号存会在重排分集时跟丢。保留读取与注入
   * 只是为了不把早先填过的内容变成孤儿数据；界面不再提供新增入口。
   */
  localOverrides: Record<string, string>;
}

export function emptyStoryBible(): StoryBible {
  return {
    locks: { positioning: '', era: '', toneRules: [], dialogueStyle: '' },
    blacklist: [],
    castLock: [],
    structureLock: [],
    localOverrides: {},
  };
}

/** 容忍历史/半成品数据：任何一段缺失都补成空，不让页面因为一个字段崩掉。 */
export function normalizeStoryBible(value: unknown): StoryBible {
  const base = emptyStoryBible();
  if (!value || typeof value !== 'object') return base;
  const raw = value as Partial<StoryBible>;
  const locks = (raw.locks ?? {}) as Partial<StoryBible['locks']>;
  return {
    locks: {
      positioning: typeof locks.positioning === 'string' ? locks.positioning : '',
      era: typeof locks.era === 'string' ? locks.era : '',
      toneRules: Array.isArray(locks.toneRules) ? locks.toneRules.filter((x) => typeof x === 'string') : [],
      dialogueStyle: typeof locks.dialogueStyle === 'string' ? locks.dialogueStyle : '',
    },
    blacklist: Array.isArray(raw.blacklist) ? raw.blacklist.filter((x) => typeof x === 'string') : [],
    castLock: Array.isArray(raw.castLock)
      ? raw.castLock.filter((x): x is CastLockEntry => Boolean(x) && typeof x === 'object')
      : [],
    structureLock: Array.isArray(raw.structureLock)
      ? raw.structureLock.filter((x): x is StructureLockEntry => Boolean(x) && typeof x === 'object')
      : [],
    localOverrides:
      raw.localOverrides && typeof raw.localOverrides === 'object' && !Array.isArray(raw.localOverrides)
        ? (raw.localOverrides as Record<string, string>)
        : {},
  };
}

// ─── 分集草稿 ─────────────────────────────────────────────────────────────

export interface EpisodeDraft {
  number: number;
  title: string;
  /**
   * 这一集属于哪个阶段（对应 `StructureLockEntry.stage`）。
   *
   * 有了它，阶段级条款才能找到自己该管的集——这是「条款跟着阶段走」的那根线。
   * 留空则该集只受全局锁约束。
   */
  stage?: string;
  /** 契约格式正文：`X-Y地点 日/夜 内/外` + `人物：` + 台词 */
  body: string;
}

export interface EpisodeDraftDoc {
  drafts: EpisodeDraft[];
}

export function normalizeEpisodeDrafts(value: unknown): EpisodeDraft[] {
  const raw = (value as Partial<EpisodeDraftDoc> | null)?.drafts;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is EpisodeDraft => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      number: Number(item.number) || 0,
      title: typeof item.title === 'string' ? item.title : '',
      stage: typeof item.stage === 'string' ? item.stage : undefined,
      body: typeof item.body === 'string' ? item.body : '',
    }))
    .filter((item) => item.number > 0)
    .sort((a, b) => a.number - b.number);
}
