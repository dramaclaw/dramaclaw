import { useCallback, useEffect, useRef, useState } from 'react';
import { useChoiceCountdown } from './useChoiceCountdown';

/**
 * 选择点四阶段状态机(参照 Bandersnatch 的 Init → Select → Timeout → Hide)。
 *
 * - `idle`   :选项未出现(播视频/结局/未激活)。
 * - `init`   :选项刚出现,进入动画阶段;仍可点击。
 * - `select` :可交互;有时限时倒计时在此阶段运行。
 * - `timeout`:计时归零,自动选默认项(退出动画的「超时」变体)。
 * - `hide`   :玩家已点选,展示选中确认反馈并淡出(退出动画的「主动」变体)。
 *
 * `timeout`/`hide` 都在停留 `confirmMs` 让玩家看清所选后,调用一次 `onCommit(index)` 推进故事。
 * 计时/选中/提交纯逻辑,与播放器 UI 解耦,便于单测。
 */

export type ChoiceStage = 'idle' | 'init' | 'select' | 'timeout' | 'hide';

/** 各阶段时长(ms)。init=进入动画;confirm=选中确认+退出停留。 */
export const CHOICE_STAGE_TIMING = { initMs: 220, confirmMs: 480 };

export interface ChoicePointMachine {
  stage: ChoiceStage;
  /** 已选/将选的选项 index(timeout 为默认项);未定为 null。 */
  selectedIndex: number | null;
  /** 倒计时剩余比例 0..1(仅 select 阶段有意义,其余为 1)。 */
  fraction: number;
  /** 玩家点击某选项。仅 init/select 阶段生效,进入 hide。 */
  select: (index: number) => void;
}

export function useChoicePointMachine({
  active,
  resetKey,
  seconds,
  defaultIndex,
  firstIndex,
  onCommit,
}: {
  /** 选项当前应可见且可交互(false = 视频播放中/结局/退出)。 */
  active: boolean;
  /** 当前这一跳的稳定标识(通常是节点 id);变化即重置状态机——连续占位卡换跳时 active 不变但 resetKey 变。 */
  resetKey: string | number | null;
  /** 选项窗口秒数(null = 不限时,不会超时)。 */
  seconds: number | null;
  /** 超时自动选的默认项 index(null = 无默认,回退 firstIndex)。 */
  defaultIndex: number | null;
  /** 无默认项时超时回退到的第一个选项 index。 */
  firstIndex: number | null;
  /** 确认后推进故事(store.choose)。 */
  onCommit: (index: number) => void;
}): ChoicePointMachine {
  const [stage, setStage] = useState<ChoiceStage>('idle');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  // 用 ref 持有最新值,避免它们变化重启计时器 / 造成回调闭包过期。
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const onCommitRef = useRef(onCommit);
  const defaultIndexRef = useRef(defaultIndex);
  const firstIndexRef = useRef(firstIndex);
  useEffect(() => {
    onCommitRef.current = onCommit;
    defaultIndexRef.current = defaultIndex;
    firstIndexRef.current = firstIndex;
  });
  const committedRef = useRef(false);
  // 同步锁:选中/超时一旦定案立即置位,挡住同一 tick 内 setState 尚未 re-render 时的二次触发。
  const lockedRef = useRef(false);

  // 激活 / 换跳:重置到 init;失活:回 idle。confirmMs 未到就失活/换跳则不提交。
  useEffect(() => {
    committedRef.current = false;
    lockedRef.current = false;
    if (active) {
      setStage('init');
    } else {
      setStage('idle');
    }
    setSelectedIndex(null);
  }, [active, resetKey]);

  // init → select:进入动画结束后转为可交互。
  useEffect(() => {
    if (stage !== 'init') return;
    const id = window.setTimeout(() => setStage('select'), CHOICE_STAGE_TIMING.initMs);
    return () => window.clearTimeout(id);
  }, [stage]);

  const select = useCallback((index: number) => {
    if (lockedRef.current) return;
    if (stageRef.current !== 'init' && stageRef.current !== 'select') return;
    lockedRef.current = true;
    setSelectedIndex(index);
    setStage('hide');
  }, []);

  // 倒计时仅在 select 阶段运行;归零走 timeout 阶段并自动选默认项。
  const handleTimeout = useCallback(() => {
    if (lockedRef.current) return;
    if (stageRef.current !== 'select') return;
    lockedRef.current = true;
    const idx = defaultIndexRef.current ?? firstIndexRef.current ?? 0;
    setSelectedIndex(idx);
    setStage('timeout');
  }, []);
  const { fraction } = useChoiceCountdown({
    seconds,
    active: stage === 'select',
    onTimeout: handleTimeout,
  });

  // hide/timeout:停留 confirmMs 展示选中反馈后提交一次。
  useEffect(() => {
    if (stage !== 'hide' && stage !== 'timeout') return;
    if (selectedIndex == null) return;
    const target = selectedIndex;
    const id = window.setTimeout(() => {
      if (committedRef.current) return;
      committedRef.current = true;
      onCommitRef.current(target);
    }, CHOICE_STAGE_TIMING.confirmMs);
    return () => window.clearTimeout(id);
  }, [stage, selectedIndex]);

  return { stage, selectedIndex, fraction, select };
}
