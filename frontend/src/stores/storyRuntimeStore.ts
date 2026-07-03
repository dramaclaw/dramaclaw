import { create } from 'zustand';
import { Compiler } from 'inkjs/full';
import type { CompiledStory, StoryVariable } from '@/features/canvas/story/storyTypes';
import { readStorySave, writeStorySave, clearStorySave } from '@/features/canvas/story/storySave';
import { recordChoice, recordEnding, statsKeyFromSaveKey } from '@/features/canvas/story/storyStats';

type InkStory = ReturnType<Compiler['Compile']>;

/** 'loading' 当前不可达（enterPlay 是同步编译）；预留给将来 inkjs 懒加载/异步编译时使用。 */
export type StoryPhase = 'idle' | 'loading' | 'playing' | 'ended' | 'error';

export interface StoryChoiceView {
  index: number;
  text: string;
}

/** 试玩时显示的变量当前值。 */
export interface StoryVariableView {
  name: string;
  label: string;
  value: number;
}

interface StoryRuntimeState {
  mode: 'edit' | 'play';
  story: InkStory | null;
  clipByNodeId: Record<string, string>;
  /** 源节点 id → 选项窗口秒数 / 默认选项 index(限时选项)。 */
  choiceTimeByNodeId: Record<string, number>;
  defaultChoiceIndexByNodeId: Record<string, number>;
  /** 叶子结局节点 id → 结局页标题/标。 */
  endingByNodeId: Record<string, { title: string; label?: string }>;
  /** 节点 id → 占位卡文案(无视频时占位试玩用)。 */
  placeholderByNodeId: Record<string, { text: string; label?: string }>;
  /** 本故事声明的变量(用于每步读取当前值)。 */
  variables: StoryVariable[];
  currentClipUrl: string | null;
  currentChoices: StoryChoiceView[];
  /** 当前各选项的后继片段 URL(前瞻所得),供播放器针对性预取「下一跳」分支。 */
  nextClipUrls: string[];
  /** 各变量的实时值(供 HUD 显示)。 */
  currentVariables: StoryVariableView[];
  /** 当前选项窗口秒数(null = 不限时);超时自动选的默认选项 index(null = 无默认)。 */
  currentChoiceTimeSec: number | null;
  currentDefaultChoiceIndex: number | null;
  /** 当前结局(仅 ended 相位的叶子节点);null = 非结局。 */
  currentEnding: { title: string; label?: string } | null;
  /** 当前占位卡(仅无视频且有选项的 playing 节点);null = 有视频或非占位。 */
  currentPlaceholder: { text: string; label?: string } | null;
  phase: StoryPhase;
  error: string | null;
  /** 本次试玩的存档 key(localStorage),null = 不存档。 */
  saveKey: string | null;
  /** 本次试玩的统计 key(localStorage,由 saveKey 派生),null = 不统计。 */
  statsKey: string | null;
  /** 进入时检测到存档,等玩家决定「继续 / 从头」;true 期间不自动 advance。 */
  resumeAvailable: boolean;

  enterPlay: (compiled: CompiledStory, opts?: { saveKey?: string }) => void;
  /** 续玩:把存档灌回 story 并定位。返回 true=成功;false=存档损坏,已清档并回到起点。 */
  resumeSaved: () => boolean;
  /** 忽略存档,从头开始并覆盖存档为新起点。 */
  startFresh: () => void;
  choose: (index: number) => void;
  restart: () => void;
  exitPlay: () => void;
}

const CLIP_TAG_PREFIX = 'clip:';

/** 从 inkjs 读取每个声明变量的当前数值。 */
function readVariables(story: InkStory, variables: StoryVariable[]): StoryVariableView[] {
  return variables.map((v) => {
    const raw = (story.variablesState as unknown as Record<string, unknown>)[v.name];
    return { name: v.name, label: v.label, value: typeof raw === 'number' ? raw : Number(raw ?? 0) };
  });
}

/** 从当前 currentTags 解析 `# clip:` 携带的节点 id(无则 null)。 */
function nodeIdFromTags(story: InkStory): string | null {
  const tag = story.currentTags?.find((it) => it.startsWith(CLIP_TAG_PREFIX));
  return tag ? tag.slice(CLIP_TAG_PREFIX.length).trim() : null;
}

/** 从当前 currentTags 解析 `# clip:` 对应的视频 URL(无则 null)。 */
function clipUrlFromTags(story: InkStory, clipByNodeId: Record<string, string>): string | null {
  const nodeId = nodeIdFromTags(story);
  return nodeId ? (clipByNodeId[nodeId] ?? null) : null;
}

/**
 * 前瞻:快照当前运行态,对每个 currentChoice 试走一步读出其后继 `# clip:` 的视频 URL,再恢复。
 * 用于「针对性下一跳预取」——只预取玩家马上要二选一的那几个后继片段,而非全量预加载。
 * 用存档同款 toJson/LoadJson 做快照,保证探测后状态原样恢复。
 */
function peekNextClipUrls(story: InkStory, clipByNodeId: Record<string, string>): string[] {
  const choices = story.currentChoices;
  if (choices.length === 0) return [];
  const snapshot = story.state.toJson();
  const urls: string[] = [];
  try {
    for (const choice of choices) {
      story.ChooseChoiceIndex(choice.index);
      if (story.canContinue) story.Continue();
      const url = clipUrlFromTags(story, clipByNodeId);
      if (url) urls.push(url);
      story.state.LoadJson(snapshot);
    }
  } finally {
    story.state.LoadJson(snapshot);
  }
  return Array.from(new Set(urls));
}

/** 推进 story 到下一段内容，解析 `# clip:` tag 得到视频 URL、当前选项与变量值，返回新状态片段。 */
function advanceToClip(
  story: InkStory,
  clipByNodeId: Record<string, string>,
  variables: StoryVariable[],
  choiceTimeByNodeId: Record<string, number>,
  defaultChoiceIndexByNodeId: Record<string, number>,
  endingByNodeId: Record<string, { title: string; label?: string }>,
  placeholderByNodeId: Record<string, { text: string; label?: string }>,
): {
  currentClipUrl: string | null;
  currentChoices: StoryChoiceView[];
  nextClipUrls: string[];
  currentVariables: StoryVariableView[];
  currentChoiceTimeSec: number | null;
  currentDefaultChoiceIndex: number | null;
  currentEnding: { title: string; label?: string } | null;
  currentPlaceholder: { text: string; label?: string } | null;
  phase: StoryPhase;
} {
  if (story.canContinue) {
    story.Continue();
  }
  const tag = story.currentTags?.find((it) => it.startsWith(CLIP_TAG_PREFIX));
  const nodeId = tag ? tag.slice(CLIP_TAG_PREFIX.length).trim() : null;
  const currentClipUrl = nodeId ? (clipByNodeId[nodeId] ?? null) : null;
  const currentChoices = story.currentChoices.map((c) => ({ index: c.index, text: c.text }));
  const phase: StoryPhase = currentChoices.length > 0 ? 'playing' : 'ended';
  // 限时只在「有选项」时有意义;无选项(结局)不计时。
  const limit = nodeId ? choiceTimeByNodeId[nodeId] : undefined;
  const currentChoiceTimeSec =
    currentChoices.length > 0 && typeof limit === 'number' && limit > 0 ? limit : null;
  const defaultIdx = nodeId ? defaultChoiceIndexByNodeId[nodeId] : undefined;
  const currentDefaultChoiceIndex =
    currentChoices.length > 0 && typeof defaultIdx === 'number' ? defaultIdx : null;
  // 结局只在叶子(ended)有意义。
  const currentEnding = phase === 'ended' && nodeId ? (endingByNodeId[nodeId] ?? null) : null;
  // 占位卡:仅当「有选项但无视频」时出现(结局无视频走 currentEnding);无旁白也兜底给空文案卡。
  const currentPlaceholder =
    phase === 'playing' && !currentClipUrl
      ? (nodeId ? (placeholderByNodeId[nodeId] ?? { text: '' }) : { text: '' })
      : null;
  return {
    currentClipUrl,
    currentChoices,
    nextClipUrls: peekNextClipUrls(story, clipByNodeId),
    currentVariables: readVariables(story, variables),
    currentChoiceTimeSec,
    currentDefaultChoiceIndex,
    currentEnding,
    currentPlaceholder,
    phase,
  };
}

/** 存档当前 inkjs 运行态(仅当有 saveKey 时)。 */
function persist(saveKey: string | null, story: InkStory): void {
  if (saveKey) writeStorySave(saveKey, story.state.toJson());
}

const INITIAL_RUNTIME = {
  story: null as InkStory | null,
  clipByNodeId: {} as Record<string, string>,
  choiceTimeByNodeId: {} as Record<string, number>,
  defaultChoiceIndexByNodeId: {} as Record<string, number>,
  endingByNodeId: {} as Record<string, { title: string; label?: string }>,
  placeholderByNodeId: {} as Record<string, { text: string; label?: string }>,
  variables: [] as StoryVariable[],
  currentClipUrl: null as string | null,
  currentChoices: [] as StoryChoiceView[],
  nextClipUrls: [] as string[],
  currentVariables: [] as StoryVariableView[],
  currentChoiceTimeSec: null as number | null,
  currentDefaultChoiceIndex: null as number | null,
  currentEnding: null as { title: string; label?: string } | null,
  currentPlaceholder: null as { text: string; label?: string } | null,
  phase: 'idle' as StoryPhase,
  error: null as string | null,
  saveKey: null as string | null,
  statsKey: null as string | null,
  resumeAvailable: false,
};

export const useStoryRuntimeStore = create<StoryRuntimeState>()((set, get) => ({
  mode: 'edit',
  ...INITIAL_RUNTIME,

  enterPlay: (compiled, opts) => {
    try {
      const story = new Compiler(compiled.ink).Compile();
      const saveKey = opts?.saveKey ?? null;
      const statsKey = statsKeyFromSaveKey(saveKey);
      const tables = {
        clipByNodeId: compiled.clipByNodeId,
        choiceTimeByNodeId: compiled.choiceTimeByNodeId,
        defaultChoiceIndexByNodeId: compiled.defaultChoiceIndexByNodeId,
        endingByNodeId: compiled.endingByNodeId,
        placeholderByNodeId: compiled.placeholderByNodeId,
        variables: compiled.variables,
      };
      // 有存档:暂不 advance,挂起等玩家选「继续 / 从头」。
      if (saveKey && readStorySave(saveKey) !== null) {
        set({
          mode: 'play',
          story,
          ...tables,
          error: null,
          currentClipUrl: null,
          currentChoices: [],
          nextClipUrls: [],
          currentVariables: [],
          currentChoiceTimeSec: null,
          currentDefaultChoiceIndex: null,
          currentEnding: null,
          currentPlaceholder: null,
          phase: 'idle',
          saveKey,
          statsKey,
          resumeAvailable: true,
        });
        return;
      }
      // 无存档:照旧直接进入起点,并写入初始存档。
      set({
        mode: 'play',
        story,
        ...tables,
        error: null,
        saveKey,
        statsKey,
        resumeAvailable: false,
        ...advanceToClip(
          story,
          compiled.clipByNodeId,
          compiled.variables,
          compiled.choiceTimeByNodeId,
          compiled.defaultChoiceIndexByNodeId,
          compiled.endingByNodeId,
          compiled.placeholderByNodeId,
        ),
      });
      persist(saveKey, story);
    } catch (err) {
      set({ mode: 'play', ...INITIAL_RUNTIME, phase: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  resumeSaved: () => {
    const {
      story, saveKey, clipByNodeId, variables,
      choiceTimeByNodeId, defaultChoiceIndexByNodeId, endingByNodeId, placeholderByNodeId,
    } = get();
    if (!story || !saveKey) return false;
    const json = readStorySave(saveKey);
    try {
      if (json === null) throw new Error('no save');
      story.state.LoadJson(json);
    } catch {
      // 存档与当前 ink 不匹配/损坏:清档,从头开始。
      clearStorySave(saveKey);
      get().startFresh();
      return false;
    }
    set({
      resumeAvailable: false,
      ...advanceToClip(story, clipByNodeId, variables, choiceTimeByNodeId, defaultChoiceIndexByNodeId, endingByNodeId, placeholderByNodeId),
    });
    persist(saveKey, story);
    return true;
  },

  startFresh: () => {
    const {
      story, saveKey, clipByNodeId, variables,
      choiceTimeByNodeId, defaultChoiceIndexByNodeId, endingByNodeId, placeholderByNodeId,
    } = get();
    if (!story) return;
    story.ResetState();
    set({
      resumeAvailable: false,
      ...advanceToClip(story, clipByNodeId, variables, choiceTimeByNodeId, defaultChoiceIndexByNodeId, endingByNodeId, placeholderByNodeId),
    });
    persist(saveKey, story);
  },

  choose: (index) => {
    const {
      story,
      clipByNodeId,
      variables,
      choiceTimeByNodeId,
      defaultChoiceIndexByNodeId,
      endingByNodeId,
      placeholderByNodeId,
      currentChoices,
      statsKey,
      phase,
    } = get();
    if (!story) return;
    if (phase === 'ended') return;
    // 试玩埋点(选择分布):在推进前抓当前选择点 nodeId 与所选选项文案。
    if (statsKey) {
      const pointNodeId = nodeIdFromTags(story);
      const chosen = currentChoices.find((c) => c.index === index);
      if (pointNodeId && chosen) {
        recordChoice(statsKey, {
          nodeId: pointNodeId,
          index,
          text: chosen.text,
          pointLabel: placeholderByNodeId[pointNodeId]?.label,
        });
      }
    }
    story.ChooseChoiceIndex(index);
    const next = advanceToClip(
      story,
      clipByNodeId,
      variables,
      choiceTimeByNodeId,
      defaultChoiceIndexByNodeId,
      endingByNodeId,
      placeholderByNodeId,
    );
    set(next);
    // 试玩埋点(结局达成率):推进后若到达结局叶子,记一次通关。
    if (statsKey && next.phase === 'ended') {
      const endNodeId = nodeIdFromTags(story);
      if (endNodeId) {
        const ending = endingByNodeId[endNodeId] ?? { title: '' };
        recordEnding(statsKey, { nodeId: endNodeId, title: ending.title, label: ending.label });
      }
    }
    persist(get().saveKey, story);
  },

  restart: () => {
    const {
      story,
      clipByNodeId,
      variables,
      choiceTimeByNodeId,
      defaultChoiceIndexByNodeId,
      endingByNodeId,
      placeholderByNodeId,
    } = get();
    if (!story) return;
    story.ResetState();
    set(
      advanceToClip(
        story,
        clipByNodeId,
        variables,
        choiceTimeByNodeId,
        defaultChoiceIndexByNodeId,
        endingByNodeId,
        placeholderByNodeId,
      ),
    );
    persist(get().saveKey, story);
  },

  // 退出仅清运行态;存档保留,下次试玩可续。
  exitPlay: () => set({ mode: 'edit', ...INITIAL_RUNTIME }),
}));
