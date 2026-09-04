/** storyChoiceEdge 的 edge.type 字面量,集中导出避免散落字符串。 */
export const STORY_CHOICE_EDGE_TYPE = 'storyChoiceEdge' as const;

/** 选项条件:某变量与阈值的比较,满足才显示此选项。第一版每条选项最多一个条件。 */
export interface StoryChoiceCondition {
  var: string; // 引用 StoryVariable.name
  op: '>=' | '<=' | '==' | '>' | '<';
  value: number;
}

/** 访问计数条件:某片段被进入的次数 op value(满足才显示此选项)。 */
export interface StoryVisitCondition {
  visitedNodeId: string; // 引用同组某视频节点 id
  op: '>=' | '<=' | '==' | '>' | '<';
  value: number;
}

/** 条件叶子:变量比较 或 访问计数。判别:'visitedNodeId' in c。 */
export type StoryConditionLeaf = StoryChoiceCondition | StoryVisitCondition;

/** 复合条件组:扁平的多个叶子 + 单一连接词(v1 不嵌套,items 至少 1)。 */
export interface StoryConditionGroup {
  join: 'and' | 'or';
  items: StoryConditionLeaf[];
}

/** 选项条件:单叶子或复合组。判别:'join' in cond。 */
export type StoryConditionExpr = StoryConditionLeaf | StoryConditionGroup;

/** 选项效果:选了此选项后,某变量 += delta(delta 可正可负)。 */
export interface StoryChoiceEffect {
  var: string; // 引用 StoryVariable.name
  delta: number;
}

/** 选项在播放器中的呈现方式。默认 overlay 沿用底部选项；其它两种都需要锚点热区。 */
export type StoryChoicePresentation = 'overlay' | 'object-anchor' | 'baked-video';
/** 前端绘制的锚定选项外观；baked-video 只保留透明热区。 */
export type StoryChoiceUiStyle = 'glass' | 'tag' | 'warning';
/** 选项进入选择点时的动画。 */
export type StoryChoiceMotion = 'fade' | 'pop' | 'pulse';
/** 确认选择、进入下一片段时的前端切换效果。 */
export type StoryChoiceTransition = 'fade' | 'flash' | 'cut';

export const DEFAULT_BAKED_HOTSPOT_WIDTH = 0.24;
export const DEFAULT_BAKED_HOTSPOT_HEIGHT = 0.14;

/**
 * 相对于原始视频画幅的比例坐标，0–1。x/y 是中心点；width/height 仅用于
 * baked-video 的矩形点击区域。objectLabel 仅供创作与 AI 理解，不参与命中计算。
 */
export interface StoryChoiceAnchor {
  x: number;
  y: number;
  width?: number;
  height?: number;
  objectLabel?: string;
}

export function defaultStoryChoiceAnchor(
  presentation: StoryChoicePresentation,
): StoryChoiceAnchor {
  return {
    x: 0.5,
    y: 0.5,
    ...(presentation === 'baked-video'
      ? { width: DEFAULT_BAKED_HOTSPOT_WIDTH, height: DEFAULT_BAKED_HOTSPOT_HEIGHT }
      : {}),
  };
}

/**
 * 前端互动呈现规格：同一选择点的 presentation 统一同步到全部出边；
 * anchor / 外观 / 动画仍由各选项独立保存，可分别落在不同物品或视频 UI 上。
 */
export interface StoryChoiceInteraction {
  presentation?: StoryChoicePresentation;
  anchor?: StoryChoiceAnchor;
  uiStyle?: StoryChoiceUiStyle;
  motion?: StoryChoiceMotion;
  transition?: StoryChoiceTransition;
}

/** 容错处理画布/导入数据，保证播放器只消费合法比例坐标和已知枚举。 */
export function normalizeStoryChoiceInteraction(
  value: StoryChoiceInteraction | undefined,
): Required<Pick<StoryChoiceInteraction, 'presentation' | 'uiStyle' | 'motion' | 'transition'>> & Pick<StoryChoiceInteraction, 'anchor'> {
  const rawPresentation = value?.presentation;
  const presentation: StoryChoicePresentation = rawPresentation === 'object-anchor' || rawPresentation === 'baked-video'
    ? rawPresentation
    : 'overlay';
  const uiStyle = value?.uiStyle as string | undefined;
  const motion = value?.motion;
  const transition = value?.transition;
  const rawAnchor = value?.anchor;
  const rawWidth = rawAnchor && Number.isFinite(rawAnchor.width) && Number(rawAnchor.width) > 0
    ? Math.min(1, Math.max(0.02, Number(rawAnchor.width)))
    : undefined;
  const rawHeight = rawAnchor && Number.isFinite(rawAnchor.height) && Number(rawAnchor.height) > 0
    ? Math.min(1, Math.max(0.02, Number(rawAnchor.height)))
    : undefined;
  const width = rawWidth;
  const height = rawHeight;
  const hasRequiredBakedSize = presentation !== 'baked-video' || (width !== undefined && height !== undefined);
  const anchor = rawAnchor && Number.isFinite(rawAnchor.x) && Number.isFinite(rawAnchor.y) && hasRequiredBakedSize
    ? {
        x: width && presentation === 'baked-video'
          ? Math.min(1 - width / 2, Math.max(width / 2, rawAnchor.x))
          : Math.min(1, Math.max(0, rawAnchor.x)),
        y: height && presentation === 'baked-video'
          ? Math.min(1 - height / 2, Math.max(height / 2, rawAnchor.y))
          : Math.min(1, Math.max(0, rawAnchor.y)),
        ...(width && height ? { width, height } : {}),
        ...(typeof rawAnchor.objectLabel === 'string' && rawAnchor.objectLabel.trim()
          ? { objectLabel: rawAnchor.objectLabel.trim() }
          : {}),
      }
    : undefined;
  const normalizedPresentation = presentation !== 'overlay' && !anchor ? 'overlay' : presentation;
  return {
    presentation: normalizedPresentation,
    uiStyle: uiStyle === 'tag'
    ? 'tag'
    : uiStyle === 'warning' ? 'warning' : 'glass',
    motion: motion === 'pop' || motion === 'pulse' ? motion : 'fade',
    transition: transition === 'flash' || transition === 'cut' ? transition : 'fade',
    ...(anchor ? { anchor } : {}),
  };
}

/** 玩家可见的语义状态变化；只显示变量标签与方向，不暴露内部数值。 */
export interface StoryStateChange {
  label: string;
  direction: 'up' | 'down';
}

/** 选项边携带的数据。 */
export interface StoryChoiceEdgeData {
  /** Agent 领域协议中的稳定选择 ID，不随边重连或显示顺序变化。 */
  storyChoiceId?: string;
  /** 玩家看到的选项文案,如「先自我介绍」。空串视为无文字纯跳转。 */
  choiceText: string;
  /** 同一源节点多个选项的显示顺序,升序。 */
  order: number;
  /** 满足条件才出现此选项(可选)。单叶子或复合 AND/OR 组(向后兼容:旧数据是叶子)。 */
  condition?: StoryConditionExpr;
  /** 选了此选项触发的变量变更(可选,可多条)。 */
  effects?: StoryChoiceEffect[];
  /** 玩家做出该选择后短暂看见的剧情反馈；不会生成或替换视频。 */
  feedbackText?: string;
  /** 选项 UI 的呈现、锚点和动画；省略即沿用底部选项。 */
  interaction?: StoryChoiceInteraction;
  /** 超时自动选中的默认选项。同一源节点至多一条为 true。 */
  isDefault?: boolean;
  /** 导入的超模型边(自动分支/复合条件),需手动处理。 */
  needsReview?: boolean;
  /** needsReview 的说明文字。 */
  reviewNote?: string;
}

/** 故事数值变量(好感度等),注册表持久化在画布 metadata。 */
export interface StoryVariable {
  /** ink 标识符:字母数字下划线、字母开头、全画布唯一、创建后不可改。 */
  name: string;
  /** 显示名(可改),如「林·好感度」。 */
  label: string;
  /** 初始值(整数)。 */
  initial: number;
}

/** 编译产物:knot 名 ↔ 节点 id 互查 + 节点 id → 视频 URL。 */
export interface CompiledStory {
  ink: string;
  /** originalNodeId -> 视频 URL(可能为空串,占位片段)。 */
  clipByNodeId: Record<string, string>;
  /** 选择源节点 id → 独立互动循环片段 URL；缺失时播放器冻结主视频尾帧。 */
  choiceLoopClipByNodeId: Record<string, string>;
  /** originalNodeId -> knot 名。 */
  knotByNodeId: Record<string, string>;
  /** 源节点 id → 选项窗口秒数(>0 才计时)。限时选项用。 */
  choiceTimeByNodeId: Record<string, number>;
  /** 源节点 id → 默认选项的 order(超时自动选)。 */
  defaultChoiceIndexByNodeId: Record<string, number>;
  /** 叶子结局节点 id → 结局页标题/标(title=旁白,label=GE/NE/BE)。 */
  endingByNodeId: Record<string, { title: string; label?: string }>;
  /** 节点 id → 占位卡文案(text=旁白,label=显示名)。视频未生成时播放器据此渲染占位卡,可先跑通结构再生成视频。 */
  placeholderByNodeId: Record<string, { text: string; label?: string }>;
  /** Ink 选项 tag id → 玩家选择后展示的短暂剧情反馈。 */
  choiceFeedbackById: Record<string, string>;
  /** Ink 选项 tag id → 与剧情反馈同屏展示的语义状态变化。 */
  choiceStateChangesById: Record<string, StoryStateChange[]>;
  /** Ink 选项 tag id → 仅非默认的互动呈现规格。 */
  choiceInteractionById: Record<string, StoryChoiceInteraction>;
  /** 编译期非致命警告(如引用了已删变量),供 UI 提示。 */
  warnings: string[];
  /** 本故事声明的变量(供运行时读取/显示当前值)。 */
  variables: StoryVariable[];
}
