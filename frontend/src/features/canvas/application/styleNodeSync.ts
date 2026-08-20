// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 图片节点的「选中风格」与画布上那个上游风格节点之间的对账规则。
 *
 * 单向真源是图片节点的 `styleTemplateId` —— 提交生成请求读的是它,风格节点只是
 * 它在画布上的投影。风格节点自己的弹窗改风格时也是先写下游图片节点,再由这里把
 * 节点数据拉齐,避免两边各写一半、谁也说不清以谁为准。
 *
 * 抽成纯函数是因为真正难的不是「建/删」,而是几个时序上的坑:
 *
 * - 刚 addNode 完、store 还没回流的那一帧,上游看起来是空的。若直接按「选了风格
 *   却没有节点 ⇒ 用户删了」判断,会立刻把用户刚选的风格清掉。所以要靠
 *   `everObservedStyleNode` 区分「还没建出来」和「建过又没了」。
 * - 存量画布(改动上线前存的)有 styleTemplateId 却没有风格节点,首次对账必须补建
 *   而不是反过来清空选择,所以首次对账用 `lastSyncedTemplateId === undefined`
 *   单独走一支。
 */

export interface StyleNodeSnapshot {
  id: string;
  templateId: string | null;
  /**
   * 这个风格节点是否还连着别的下游节点。正常情况恒为 false —— 一对一是本模块
   * 全部规则的前提，见 {@link resolveStyleNodeSyncAction} 里的共用分支。
   */
  sharedWithOtherTargets: boolean;
}

export interface StyleNodeSyncInput {
  /** 图片节点当前选中的风格 id。 */
  selectedTemplateId: string | null;
  /** 连在图片节点上游的风格节点;没有则为 null。 */
  styleNode: StyleNodeSnapshot | null;
  /** 上一次对账时的选择;`undefined` 表示这是本节点挂载后的第一次对账。 */
  lastSyncedTemplateId: string | null | undefined;
  /** 本节点是否曾经真的看见过上游风格节点。 */
  everObservedStyleNode: boolean;
}

export type StyleNodeSyncAction =
  | { kind: 'none' }
  /** 在图片节点左侧建一个风格节点并连边。 */
  | { kind: 'create'; templateId: string }
  /** 复用已有节点,只改它承载的风格。 */
  | { kind: 'update'; nodeId: string; templateId: string }
  /** 清除风格 ⇒ 收掉画布上的风格节点。 */
  | { kind: 'remove'; nodeId: string }
  /** 用户把风格节点删了 ⇒ 反向把图片节点的风格也清掉。 */
  | { kind: 'clear-selection' };

const NONE: StyleNodeSyncAction = { kind: 'none' };

/**
 * 对账的准入判据:清单已经到手,且当前选择在清单里认得出来。
 *
 * 两条都不能省。清单还没到就动手,`create` 会拿着一个查不到的 id 建节点;而
 * 「认得出来」防的是另一件事 —— 这一版把 30 套旧风格整体换成了 45 套新的,新旧
 * id 零重叠,存量画布里那些旧 id 在新清单里一个都查不到。照建就是用户只打开看一眼,
 * 画布上就凭空长出一个空壳风格节点,还顺带判脏、自动落盘、进 undo 栈。
 *
 * 查不到就一直不动手:节点数据里那个失效 id 留着无害(后端对失效 id 是降级忽略),
 * 用户下次真选了风格自然覆盖掉。不写永远比写错安全。
 */
export function isStyleSyncReady(
  selectedTemplateId: string | null,
  templates: ReadonlyArray<{ id: string }>,
): boolean {
  if (templates.length === 0) return false;
  if (selectedTemplateId === null) return true;
  return templates.some((template) => template.id === selectedTemplateId);
}

export function resolveStyleNodeSyncAction({
  selectedTemplateId,
  styleNode,
  lastSyncedTemplateId,
  everObservedStyleNode,
}: StyleNodeSyncInput): StyleNodeSyncAction {
  const isFirstSync = lastSyncedTemplateId === undefined;

  if (selectedTemplateId === null) {
    // 首次对账时「没选风格」是常态,别把画布上碰巧连着的节点当脏数据删掉 ——
    // 那可能是用户自己拖出来的,等他真的动了选择再说。
    if (isFirstSync || lastSyncedTemplateId === null) return NONE;
    // 共用节点不是本节点一个人的，清自己的选择不该把别人的投影一起删掉。
    if (!styleNode || styleNode.sharedWithOtherTargets) return NONE;
    return { kind: 'remove', nodeId: styleNode.id };
  }

  if (!styleNode) {
    // 选择变了(或首次对账)就建;否则只有「确实看见过它」才能判定是用户删的。
    if (isFirstSync || selectedTemplateId !== lastSyncedTemplateId) {
      return { kind: 'create', templateId: selectedTemplateId };
    }
    return everObservedStyleNode ? { kind: 'clear-selection' } : NONE;
  }

  if (styleNode.sharedWithOtherTargets) {
    // 一个风格节点连着两个图片节点时，谁都不许改它 —— A 把它改成自己的选择，
    // B 的对账立刻看见不匹配又改回去，两边 effect 靠 store 写入互相触发，
    // 每轮都是一次 commit，React 到 50 层就抛 Maximum update depth exceeded。
    // 收敛不了，所以这里干脆不动手：画布上两边显示不一致，但不会把画布跑挂。
    //
    // 共用本身是异常态。SYSTEM_ONLY_CONNECTIONS 挡了手工连线，复制节点时克隆
    // 入边那条路已经在 canvasStore 里按类型跳过了，这里只是最后一道兜底。
    return NONE;
  }

  if (styleNode.templateId !== selectedTemplateId) {
    return { kind: 'update', nodeId: styleNode.id, templateId: selectedTemplateId };
  }

  return NONE;
}

/** 对账在两次调用之间要记住的东西,与 {@link StyleNodeSyncInput} 的后两项一一对应。 */
export interface StyleNodeSyncState {
  lastSyncedTemplateId: string | null | undefined;
  everObservedStyleNode: boolean;
}

export const INITIAL_STYLE_NODE_SYNC_STATE: StyleNodeSyncState = {
  lastSyncedTemplateId: undefined,
  everObservedStyleNode: false,
};

/**
 * 一步对账:算出该做什么,顺带把下一次要用的记账状态一并算出来。
 *
 * 记账跟着动作走,不能只按「这一帧看没看见节点」更新 —— `create` / `remove` 之后
 * 画布上那个节点的存在性正在翻转,store 回流前 `styleNode` 必然是 null,此时把
 * `everObservedStyleNode` 留成 true,下一轮就会把刚建好的选择判成「用户删了节点」
 * 并反手清空。所以这两个动作都要把它压回 false,等真正再看见节点时才置位。
 */
export function advanceStyleNodeSync(
  state: StyleNodeSyncState,
  input: Pick<StyleNodeSyncInput, 'selectedTemplateId' | 'styleNode'>,
): { action: StyleNodeSyncAction; state: StyleNodeSyncState } {
  const everObservedStyleNode = state.everObservedStyleNode || input.styleNode !== null;
  const action = resolveStyleNodeSyncAction({
    ...input,
    lastSyncedTemplateId: state.lastSyncedTemplateId,
    everObservedStyleNode,
  });

  switch (action.kind) {
    case 'create':
    case 'remove':
      return {
        action,
        state: {
          lastSyncedTemplateId: input.selectedTemplateId,
          everObservedStyleNode: false,
        },
      };
    case 'clear-selection':
      // 选择被反向清空,下一轮的「上一次选择」就是 null。
      return {
        action,
        state: { lastSyncedTemplateId: null, everObservedStyleNode: false },
      };
    default:
      return {
        action,
        state: {
          lastSyncedTemplateId: input.selectedTemplateId,
          everObservedStyleNode,
        },
      };
  }
}

/* ------------------------------------------------------------------------- *
 * 记账状态的存放处
 *
 * 不能放在 ImageGenNode 的 ref 里：低缩放档下 imageGenNode 会被换成 LodShellNode，
 * 组件真卸载，ref 跟着没。于是「缩小 → 删掉风格节点 → 放大」时组件重新挂载，
 * `lastSyncedTemplateId` 回到 undefined，对账按首次处理，把用户刚删掉的节点又
 * 建回来。提到模块级按 nodeId 存，跨卸载存活。
 *
 * 换画布必须清空：重新 hydrate 后风格节点可能压根没被存下来（比如画布被旧版本
 * 前端打开过、未知类型的节点连边一起被丢掉），此时残留的记账会让对账把「该补建」
 * 判成「用户删了节点」，反手把选择也清掉。
 * ------------------------------------------------------------------------- */

const syncStates = new Map<string, StyleNodeSyncState>();

export function readStyleNodeSyncState(nodeId: string): StyleNodeSyncState {
  return syncStates.get(nodeId) ?? INITIAL_STYLE_NODE_SYNC_STATE;
}

export function writeStyleNodeSyncState(nodeId: string, state: StyleNodeSyncState): void {
  syncStates.set(nodeId, state);
}

/** 换画布 / 清空画布时调用，见上面的注释。 */
export function resetStyleNodeSyncStates(): void {
  syncStates.clear();
}

/** 风格节点与图片节点之间留的水平间距（px）。 */
export const STYLE_NODE_GAP = 28;

/**
 * 补建风格节点时把它摆在图片节点正左方、垂直居中。抽出来是因为图片节点的高度有
 * 三个来源（实测高度 / 显式 height / 默认值），落点算错就是一个盖在别的节点上、
 * 或者飘到视口外的新节点，而这在组件里几乎测不到。
 */
export function resolveStyleNodePlacement(input: {
  imageNodePosition: { x: number; y: number };
  imageNodeHeight: number;
  styleNodeWidth: number;
  styleNodeHeight: number;
}): { x: number; y: number } {
  return {
    x: input.imageNodePosition.x - input.styleNodeWidth - STYLE_NODE_GAP,
    y:
      input.imageNodePosition.y
      + (input.imageNodeHeight - input.styleNodeHeight) / 2,
  };
}
