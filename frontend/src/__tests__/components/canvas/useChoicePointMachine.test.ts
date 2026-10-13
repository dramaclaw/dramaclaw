import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useChoicePointMachine,
  CHOICE_STAGE_TIMING,
} from '@/components/canvas/useChoicePointMachine';

const { initMs, confirmMs } = CHOICE_STAGE_TIMING;

type Props = {
  active: boolean;
  resetKey: string | number | null;
  seconds: number | null;
  defaultIndex: number | null;
  firstIndex: number | null;
  onCommit: (index: number) => void;
};

function setup(overrides: Partial<Props> = {}) {
  const onCommit = overrides.onCommit ?? vi.fn();
  const initial: Props = {
    active: true,
    resetKey: 'a',
    seconds: null,
    defaultIndex: null,
    firstIndex: 0,
    onCommit,
    ...overrides,
  };
  const view = renderHook((p: Props) => useChoicePointMachine(p), {
    initialProps: initial,
  });
  return { ...view, onCommit };
}

describe('useChoicePointMachine — 选择点四阶段状态机', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('active 后先进 init,initMs 后转 select', () => {
    const { result } = setup({ active: true });
    expect(result.current.stage).toBe('init');
    act(() => vi.advanceTimersByTime(initMs));
    expect(result.current.stage).toBe('select');
    expect(result.current.fraction).toBe(1);
  });

  it('select 后进 hide、标记 selectedIndex,confirmMs 后提交一次', () => {
    const { result, onCommit } = setup({ firstIndex: 0 });
    act(() => vi.advanceTimersByTime(initMs));
    act(() => result.current.select(2));
    expect(result.current.stage).toBe('hide');
    expect(result.current.selectedIndex).toBe(2);
    expect(onCommit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(confirmMs));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(2);
  });

  it('init 阶段(动画未完)点击也能选中', () => {
    const { result } = setup();
    expect(result.current.stage).toBe('init');
    act(() => result.current.select(1));
    expect(result.current.stage).toBe('hide');
    expect(result.current.selectedIndex).toBe(1);
  });

  it('超时:无操作到点走 timeout 阶段并选默认项,confirmMs 后提交默认', () => {
    const { result, onCommit } = setup({ seconds: 2, defaultIndex: 3 });
    act(() => vi.advanceTimersByTime(initMs));
    expect(result.current.stage).toBe('select');
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.stage).toBe('timeout');
    expect(result.current.selectedIndex).toBe(3);
    act(() => vi.advanceTimersByTime(confirmMs));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(3);
  });

  it('超时无默认项时回退到 firstIndex', () => {
    const { result, onCommit } = setup({ seconds: 1, defaultIndex: null, firstIndex: 5 });
    act(() => vi.advanceTimersByTime(initMs));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.selectedIndex).toBe(5);
    act(() => vi.advanceTimersByTime(confirmMs));
    expect(onCommit).toHaveBeenCalledWith(5);
  });

  it('seconds 为 null(不限时)时永不超时,停在 select', () => {
    const { result, onCommit } = setup({ seconds: null });
    act(() => vi.advanceTimersByTime(initMs));
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current.stage).toBe('select');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('重复点击只提交一次', () => {
    const { result, onCommit } = setup();
    act(() => vi.advanceTimersByTime(initMs));
    act(() => {
      result.current.select(0);
      result.current.select(1);
    });
    act(() => vi.advanceTimersByTime(confirmMs));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(0);
  });

  it('active 转 false:回到 idle,即便 hide 中途也不提交', () => {
    const { result, rerender, onCommit } = setup();
    act(() => vi.advanceTimersByTime(initMs));
    act(() => result.current.select(1));
    rerender({
      active: false,
      resetKey: 'a',
      seconds: null,
      defaultIndex: null,
      firstIndex: 0,
      onCommit,
    });
    expect(result.current.stage).toBe('idle');
    expect(result.current.selectedIndex).toBe(null);
    act(() => vi.advanceTimersByTime(confirmMs * 3));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('resetKey 变化(连续占位卡换一跳)时重置回 init', () => {
    const { result, rerender, onCommit } = setup({ resetKey: 'node-1' });
    act(() => vi.advanceTimersByTime(initMs));
    act(() => result.current.select(1));
    expect(result.current.stage).toBe('hide');
    rerender({
      active: true,
      resetKey: 'node-2',
      seconds: null,
      defaultIndex: null,
      firstIndex: 0,
      onCommit,
    });
    expect(result.current.stage).toBe('init');
    expect(result.current.selectedIndex).toBe(null);
  });
});
