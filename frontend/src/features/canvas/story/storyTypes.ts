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

/** 选项边携带的数据。 */
export interface StoryChoiceEdgeData {
  /** 玩家看到的选项文案,如「先自我介绍」。空串视为无文字纯跳转。 */
  choiceText: string;
  /** 同一源节点多个选项的显示顺序,升序。 */
  order: number;
  /** 满足条件才出现此选项(可选)。单叶子或复合 AND/OR 组(向后兼容:旧数据是叶子)。 */
  condition?: StoryConditionExpr;
  /** 选了此选项触发的变量变更(可选,可多条)。 */
  effects?: StoryChoiceEffect[];
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
  /** originalNodeId -> knot 名。 */
  knotByNodeId: Record<string, string>;
  /** 源节点 id → 选项窗口秒数(>0 才计时)。限时选项用。 */
  choiceTimeByNodeId: Record<string, number>;
  /** 源节点 id → 默认选项的 order(超时自动选)。 */
  defaultChoiceIndexByNodeId: Record<string, number>;
  /** 叶子结局节点 id → 结局页标题/标(title=旁白,label=GE/NE/BE)。 */
  endingByNodeId: Record<string, { title: string; label?: string }>;
  /** 编译期非致命警告(如引用了已删变量),供 UI 提示。 */
  warnings: string[];
  /** 本故事声明的变量(供运行时读取/显示当前值)。 */
  variables: StoryVariable[];
}
