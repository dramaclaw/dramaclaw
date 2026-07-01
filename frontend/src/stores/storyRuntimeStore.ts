import { create } from 'zustand';
import { Compiler } from 'inkjs/full';
import type { CompiledStory, StoryVariable } from '@/features/canvas/story/storyTypes';
import { readStorySave, writeStorySave, clearStorySave } from '@/features/canvas/story/storySave';

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
  /** 本故事声明的变量(用于每步读取当前值)。 */
  variables: StoryVariable[];
  currentClipUrl: string | null;
  currentChoices: StoryChoiceView[];
  /** 各变量的实时值(供 HUD 显示)。 */
  currentVariables: StoryVariableView[];
  /** 当前选项窗口秒数(null = 不限时);超时自动选的默认选项 index(null = 无默认)。 */
  currentChoiceTimeSec: number | null;
  currentDefaultChoiceIndex: number | null;
  /** 当前结局(仅 ended 相位的叶子节点);null = 非结局。 */
  currentEnding: { title: string; label?: string } | null;
  phase: StoryPhase;
  error: string | null;
  /** 本次试玩的存档 key(localStorage),null = 不存档。 */
  saveKey: string | null;
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

/** 推进 story 到下一段内容，解析 `# clip:` tag 得到视频 URL、当前选项与变量值，返回新状态片段。 */
function advanceToClip(
  story: InkStory,
  clipByNodeId: Record<string, string>,
  variables: StoryVariable[],
  choiceTimeByNodeId: Record<string, number>,
  defaultChoiceIndexByNodeId: Record<string, number>,
  endingByNodeId: Record<string, { title: string; label?: string }>,
): {
  currentClipUrl: string | null;
  currentChoices: StoryChoiceView[];
  currentVariables: StoryVariableView[];
  currentChoiceTimeSec: number | null;
  currentDefaultChoiceIndex: number | null;
  currentEnding: { title: string; label?: string } | null;
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
  return {
    currentClipUrl,
    currentChoices,
    currentVariables: readVariables(story, variables),
    currentChoiceTimeSec,
    currentDefaultChoiceIndex,
    currentEnding,
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
  variables: [] as StoryVariable[],
  currentClipUrl: null as string | null,
  currentChoices: [] as StoryChoiceView[],
  currentVariables: [] as StoryVariableView[],
  currentChoiceTimeSec: null as number | null,
  currentDefaultChoiceIndex: null as number | null,
  currentEnding: null as { title: string; label?: string } | null,
  phase: 'idle' as StoryPhase,
  error: null as string | null,
  saveKey: null as string | null,
  resumeAvailable: false,
};

export const useStoryRuntimeStore = create<StoryRuntimeState>()((set, get) => ({
  mode: 'edit',
  ...INITIAL_RUNTIME,

  enterPlay: (compiled, opts) => {
    try {
      const story = new Compiler(compiled.ink).Compile();
      const saveKey = opts?.saveKey ?? null;
      const tables = {
        clipByNodeId: compiled.clipByNodeId,
        choiceTimeByNodeId: compiled.choiceTimeByNodeId,
        defaultChoiceIndexByNodeId: compiled.defaultChoiceIndexByNodeId,
        endingByNodeId: compiled.endingByNodeId,
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
          currentVariables: [],
          currentChoiceTimeSec: null,
          currentDefaultChoiceIndex: null,
          currentEnding: null,
          phase: 'idle',
          saveKey,
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
        resumeAvailable: false,
        ...advanceToClip(
          story,
          compiled.clipByNodeId,
          compiled.variables,
          compiled.choiceTimeByNodeId,
          compiled.defaultChoiceIndexByNodeId,
          compiled.endingByNodeId,
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
      choiceTimeByNodeId, defaultChoiceIndexByNodeId, endingByNodeId,
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
      ...advanceToClip(story, clipByNodeId, variables, choiceTimeByNodeId, defaultChoiceIndexByNodeId, endingByNodeId),
    });
    persist(saveKey, story);
    return true;
  },

  startFresh: () => {
    const {
      story, saveKey, clipByNodeId, variables,
      choiceTimeByNodeId, defaultChoiceIndexByNodeId, endingByNodeId,
    } = get();
    if (!story) return;
    story.ResetState();
    set({
      resumeAvailable: false,
      ...advanceToClip(story, clipByNodeId, variables, choiceTimeByNodeId, defaultChoiceIndexByNodeId, endingByNodeId),
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
      phase,
    } = get();
    if (!story) return;
    if (phase === 'ended') return;
    story.ChooseChoiceIndex(index);
    set(
      advanceToClip(
        story,
        clipByNodeId,
        variables,
        choiceTimeByNodeId,
        defaultChoiceIndexByNodeId,
        endingByNodeId,
      ),
    );
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
      ),
    );
    persist(get().saveKey, story);
  },

  // 退出仅清运行态;存档保留,下次试玩可续。
  exitPlay: () => set({ mode: 'edit', ...INITIAL_RUNTIME }),
}));
