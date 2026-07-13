// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { isActive } from "@/task-center/derivations";
import { useTaskCenterStore } from "@/task-center/store";
import type { TaskState } from "@/task-center/types";
import {
  DEFAULT_MYBUDDY_ACTION,
  MYBUDDY_IDLE_ACTIONS,
  type MyBuddyAction,
} from "@/features/companion/mybuddy-actions";
import {
  MYBUDDY_BUBBLE_KEYS,
  type MyBuddyBubbleKind,
} from "@/features/companion/mybuddy-bubbles";
import {
  type ActivePikoFestival,
  getActivePikoFestival,
} from "@/features/companion/piko-festivals";

const INTRO_ACTION_MS = 5200;
/** 任务成功/失败的动画时长，也复用为 petdex 气泡的可见时长，让气泡与动作同步收尾。 */
export const SUCCESS_ACTION_MS = 2600;
export const FAILURE_ACTION_MS = 3600;
const IDLE_PATROL_DURATION_MS = 15000;
const IDLE_SAFE_WINDOW_MS = 5000;
const IDLE_DELAY_CYCLE_COUNT = 2;
const IDLE_ACTION_LOOP_COUNT = 3;
/** 气泡默认可见时长 + 淡出时长，petdex 气泡与 Piko 气泡共用同一组节奏。 */
export const BUBBLE_VISIBLE_MS = 3500;
export const BUBBLE_FADE_OUT_MS = 220;
const IDLE_BUBBLE_MIN_DELAY_MS = 25000;
const IDLE_BUBBLE_DELAY_SPREAD_MS = 20000;
const TERMINAL_FEEDBACK_COOLDOWN_MS = 8000;
const RECENT_IDLE_MEMORY = 2;
const DIVE_ACTION_MS = 1900;
const DIVE_RECOVERY_DELAY_MS = 760;
const DIVE_IDLE_DELAY_MS = 120000;
const DIVE_CHECK_INTERVAL_MS = 15000;
const DIVE_TRIGGER_CHANCE = 0.15;
const DIVE_COOLDOWN_MS = 360000;

export type MyBuddySpecialAction = "dive";

const MYBUDDY_IDLE_ACTION_DURATIONS_MS: Partial<Record<MyBuddyAction, number>> = {
  "count-stars": 5400,
  sleep: 4200,
  "walk-by": 5000,
  "carry-box": 4000,
  stretch: 3600,
  "watch-meteor": 5200,
  "read-map": 4600,
  fish: 5200,
  "blow-bubbles": 5200,
  "dragon-boat-paddle": 7200,
  "zongzi-check": 4600,
};

function latestTerminalTask(tasks: Iterable<TaskState>): TaskState | null {
  let latest: TaskState | null = null;
  for (const task of tasks) {
    if (task.status !== "completed" && task.status !== "failed") continue;
    if (!task.completed_at) continue;
    if (!latest || Date.parse(task.completed_at) > Date.parse(latest.completed_at)) {
      latest = task;
    }
  }
  return latest;
}

function randomIdleAction(
  recentActions: readonly MyBuddyAction[],
  festival: ActivePikoFestival | null,
): MyBuddyAction {
  const weightedActions: MyBuddyAction[] = [];
  for (const action of MYBUDDY_IDLE_ACTIONS) {
    weightedActions.push(action);
  }
  for (const action of festival?.idleActions ?? []) {
    for (let index = 0; index < action.weight; index += 1) {
      weightedActions.push(action.id);
    }
  }

  const candidates = weightedActions.filter((action) => !recentActions.includes(action));
  const pool = candidates.length > 0 ? candidates : weightedActions;
  return pool[Math.floor(Math.random() * pool.length)] ?? DEFAULT_MYBUDDY_ACTION;
}

function randomIdleDelay() {
  const patrolCycles = 1 + Math.floor(Math.random() * IDLE_DELAY_CYCLE_COUNT);
  return patrolCycles * IDLE_PATROL_DURATION_MS + Math.floor(Math.random() * IDLE_SAFE_WINDOW_MS);
}

function randomIdleBubbleDelay() {
  return IDLE_BUBBLE_MIN_DELAY_MS + Math.floor(Math.random() * IDLE_BUBBLE_DELAY_SPREAD_MS);
}

function idleActionDuration(action: MyBuddyAction) {
  const loopDuration = MYBUDDY_IDLE_ACTION_DURATIONS_MS[action] ?? 5200;
  return loopDuration * IDLE_ACTION_LOOP_COUNT;
}

function isDocumentVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function hasBlockingOverlay() {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector('[role="dialog"], [aria-modal="true"], [data-radix-dialog-content]'),
  );
}

export function useMyBuddyCompanionController() {
  const tasks = useTaskCenterStore((state) => state.tasks);
  const isHydrated = useTaskCenterStore((state) => state.isHydrated);
  const reducedMotion = useReducedMotion();
  const [isPageVisible, setIsPageVisible] = useState(isDocumentVisible);
  const [baseAction, setBaseAction] = useState<MyBuddyAction>(DEFAULT_MYBUDDY_ACTION);
  const [momentAction, setMomentAction] = useState<MyBuddyAction | null>("peek");
  const [specialAction, setSpecialAction] = useState<MyBuddySpecialAction | null>(null);
  const [isDiveRecovering, setIsDiveRecovering] = useState(false);
  const [bubbleKey, setBubbleKey] = useState<string | null>(null);
  const [isBubbleLeaving, setIsBubbleLeaving] = useState(false);
  const momentTimerRef = useRef<number | null>(null);
  const idleResetTimerRef = useRef<number | null>(null);
  const bubbleTimerRef = useRef<number | null>(null);
  const bubbleLeaveTimerRef = useRef<number | null>(null);
  const idleBubbleTimerRef = useRef<number | null>(null);
  const diveTimerRef = useRef<number | null>(null);
  const diveEndTimerRef = useRef<number | null>(null);
  const diveRecoveryTimerRef = useRef<number | null>(null);
  const lastDiveAtRef = useRef(0);
  const lastDiveRollAtRef = useRef(0);
  const lastUserActivityAtRef = useRef(Date.now());
  const latestTerminalKeyRef = useRef<string | null>(null);
  const lastTerminalFeedbackAtRef = useRef(0);
  const recentIdleActionsRef = useRef<MyBuddyAction[]>([DEFAULT_MYBUDDY_ACTION]);
  const wasActiveTaskRef = useRef(false);
  const lastBubbleKeyRef = useRef<string | null>(null);
  const momentActionRef = useRef<MyBuddyAction | null>("peek");

  const hasActiveTask = useMemo(
    () => Array.from(tasks.values()).some(isActive),
    [tasks],
  );
  const activeFestival = useMemo<ActivePikoFestival | null>(() => getActivePikoFestival(), []);

  const automaticMomentAction = reducedMotion ? null : momentAction;
  const action = automaticMomentAction ?? (hasActiveTask && !reducedMotion ? "typing" : baseAction);

  const triggerDiveAction = useCallback((force = false) => {
    if (reducedMotion || !isPageVisible || specialAction) return false;
    if (!force && hasBlockingOverlay()) return false;
    if (!force && action !== DEFAULT_MYBUDDY_ACTION) return false;
    const now = Date.now();
    if (!force && now - lastDiveAtRef.current < DIVE_COOLDOWN_MS) return false;
    lastDiveAtRef.current = now;
    setIsDiveRecovering(false);
    setMomentAction(null);
    if (momentTimerRef.current) {
      window.clearTimeout(momentTimerRef.current);
      momentTimerRef.current = null;
    }
    setSpecialAction("dive");
    if (diveEndTimerRef.current) {
      window.clearTimeout(diveEndTimerRef.current);
      diveEndTimerRef.current = null;
    }
    if (diveRecoveryTimerRef.current) {
      window.clearTimeout(diveRecoveryTimerRef.current);
      diveRecoveryTimerRef.current = null;
    }
    diveEndTimerRef.current = window.setTimeout(() => {
      diveEndTimerRef.current = null;
      diveRecoveryTimerRef.current = window.setTimeout(() => {
        setSpecialAction(null);
        setMomentAction("peek");
        setIsDiveRecovering(true);
        diveRecoveryTimerRef.current = null;
        momentTimerRef.current = window.setTimeout(() => {
          setMomentAction(null);
          setIsDiveRecovering(false);
          momentTimerRef.current = null;
        }, INTRO_ACTION_MS);
      }, DIVE_RECOVERY_DELAY_MS);
    }, DIVE_ACTION_MS);
    return true;
  }, [action, isPageVisible, reducedMotion, specialAction]);

  const showBubble = useCallback((kind: MyBuddyBubbleKind, durationMs = BUBBLE_VISIBLE_MS) => {
    const pool = MYBUDDY_BUBBLE_KEYS[kind];
    const candidates = pool.filter((key) => key !== lastBubbleKeyRef.current);
    const nextKey = candidates[Math.floor(Math.random() * candidates.length)] ?? pool[0] ?? null;
    if (!nextKey) return;
    lastBubbleKeyRef.current = nextKey;
    if (bubbleTimerRef.current) {
      window.clearTimeout(bubbleTimerRef.current);
      bubbleTimerRef.current = null;
    }
    if (bubbleLeaveTimerRef.current) {
      window.clearTimeout(bubbleLeaveTimerRef.current);
      bubbleLeaveTimerRef.current = null;
    }
    setIsBubbleLeaving(false);
    setBubbleKey(nextKey);
    bubbleTimerRef.current = window.setTimeout(() => {
      bubbleTimerRef.current = null;
      setIsBubbleLeaving(true);
      bubbleLeaveTimerRef.current = window.setTimeout(() => {
        setBubbleKey(null);
        setIsBubbleLeaving(false);
        bubbleLeaveTimerRef.current = null;
      }, BUBBLE_FADE_OUT_MS);
    }, durationMs);
  }, []);

  useEffect(() => {
    momentActionRef.current = momentAction;
  }, [momentAction]);

  useEffect(() => {
    if (reducedMotion) {
      setMomentAction(null);
      setSpecialAction(null);
      setIsDiveRecovering(false);
      return;
    }

    momentTimerRef.current = window.setTimeout(() => {
      setMomentAction(null);
      momentTimerRef.current = null;
    }, INTRO_ACTION_MS);

    return () => {
      if (momentTimerRef.current) {
        window.clearTimeout(momentTimerRef.current);
        momentTimerRef.current = null;
      }
      if (idleResetTimerRef.current) {
        window.clearTimeout(idleResetTimerRef.current);
        idleResetTimerRef.current = null;
      }
      if (bubbleTimerRef.current) {
        window.clearTimeout(bubbleTimerRef.current);
        bubbleTimerRef.current = null;
      }
      if (bubbleLeaveTimerRef.current) {
        window.clearTimeout(bubbleLeaveTimerRef.current);
        bubbleLeaveTimerRef.current = null;
      }
      if (idleBubbleTimerRef.current) {
        window.clearTimeout(idleBubbleTimerRef.current);
        idleBubbleTimerRef.current = null;
      }
      if (diveTimerRef.current) {
        window.clearInterval(diveTimerRef.current);
        diveTimerRef.current = null;
      }
      if (diveEndTimerRef.current) {
        window.clearTimeout(diveEndTimerRef.current);
        diveEndTimerRef.current = null;
      }
      if (diveRecoveryTimerRef.current) {
        window.clearTimeout(diveRecoveryTimerRef.current);
        diveRecoveryTimerRef.current = null;
      }
    };
  }, [reducedMotion]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const handleVisibilityChange = () => {
      setIsPageVisible(isDocumentVisible());
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const updateActivity = () => {
      lastUserActivityAtRef.current = Date.now();
      lastDiveRollAtRef.current = 0;
    };
    window.addEventListener("pointerdown", updateActivity, { passive: true });
    window.addEventListener("keydown", updateActivity);
    window.addEventListener("wheel", updateActivity, { passive: true });
    window.addEventListener("touchstart", updateActivity, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", updateActivity);
      window.removeEventListener("keydown", updateActivity);
      window.removeEventListener("wheel", updateActivity);
      window.removeEventListener("touchstart", updateActivity);
    };
  }, []);

  useEffect(() => {
    if (hasActiveTask || momentAction || specialAction || reducedMotion || !isPageVisible) return;

    const timeout = window.setTimeout(() => {
      const nextAction = randomIdleAction(recentIdleActionsRef.current, activeFestival);
      recentIdleActionsRef.current = [
        nextAction,
        ...recentIdleActionsRef.current,
      ].slice(0, RECENT_IDLE_MEMORY);
      setBaseAction(nextAction);

      if (idleResetTimerRef.current) {
        window.clearTimeout(idleResetTimerRef.current);
      }
      if (bubbleTimerRef.current) {
        window.clearTimeout(bubbleTimerRef.current);
        bubbleTimerRef.current = null;
      }
      if (bubbleLeaveTimerRef.current) {
        window.clearTimeout(bubbleLeaveTimerRef.current);
        bubbleLeaveTimerRef.current = null;
      }
      setIsBubbleLeaving(false);
      setBubbleKey(null);
      idleResetTimerRef.current = window.setTimeout(() => {
        setBaseAction(DEFAULT_MYBUDDY_ACTION);
        idleResetTimerRef.current = null;
      }, idleActionDuration(nextAction));
    }, randomIdleDelay());

    return () => window.clearTimeout(timeout);
  }, [activeFestival, hasActiveTask, momentAction, specialAction, baseAction, reducedMotion, isPageVisible]);

  useEffect(() => {
    if (hasActiveTask || reducedMotion || !isPageVisible) return;

    diveTimerRef.current = window.setInterval(() => {
      const now = Date.now();
      if (now - lastUserActivityAtRef.current < DIVE_IDLE_DELAY_MS) return;
      if (now - lastDiveRollAtRef.current < DIVE_IDLE_DELAY_MS) return;
      if (specialAction || action !== DEFAULT_MYBUDDY_ACTION) return;
      if (hasBlockingOverlay()) return;
      if (now - lastDiveAtRef.current < DIVE_COOLDOWN_MS) return;
      lastDiveRollAtRef.current = now;
      if (Math.random() > DIVE_TRIGGER_CHANCE) return;
      triggerDiveAction();
    }, DIVE_CHECK_INTERVAL_MS);

    return () => {
      if (diveTimerRef.current) {
        window.clearInterval(diveTimerRef.current);
        diveTimerRef.current = null;
      }
    };
  }, [action, hasActiveTask, isPageVisible, reducedMotion, specialAction, triggerDiveAction]);

  useEffect(() => {
    if (reducedMotion || !isPageVisible) {
      wasActiveTaskRef.current = hasActiveTask;
      return;
    }
    if (hasActiveTask && !wasActiveTaskRef.current) {
      showBubble("running");
    }
    wasActiveTaskRef.current = hasActiveTask;
  }, [hasActiveTask, isPageVisible, reducedMotion, showBubble]);

  useEffect(() => {
    if (hasActiveTask || reducedMotion || !isPageVisible) return;

    const scheduleIdleBubble = () => {
      idleBubbleTimerRef.current = window.setTimeout(() => {
        if (momentActionRef.current === null) {
          showBubble(activeFestival?.bubbleKind ?? "idle", 3800);
        }
        scheduleIdleBubble();
      }, randomIdleBubbleDelay());
    };

    scheduleIdleBubble();
    return () => {
      if (idleBubbleTimerRef.current) {
        window.clearTimeout(idleBubbleTimerRef.current);
        idleBubbleTimerRef.current = null;
      }
    };
  }, [activeFestival, hasActiveTask, isPageVisible, reducedMotion, showBubble]);

  useEffect(() => {
    if (!isHydrated || reducedMotion || !isPageVisible) return;

    const latest = latestTerminalTask(tasks.values());
    if (!latest) return;

    const latestKey = `${latest.task_key}:${latest.status}:${latest.completed_at}`;
    if (latestTerminalKeyRef.current === null) {
      latestTerminalKeyRef.current = latestKey;
      return;
    }
    if (latestTerminalKeyRef.current === latestKey) return;
    latestTerminalKeyRef.current = latestKey;

    const now = Date.now();
    if (now - lastTerminalFeedbackAtRef.current < TERMINAL_FEEDBACK_COOLDOWN_MS) return;
    lastTerminalFeedbackAtRef.current = now;

    if (momentTimerRef.current) {
      window.clearTimeout(momentTimerRef.current);
    }

    const nextAction: MyBuddyAction = latest.status === "completed" ? "flag" : "repair";
    const duration = latest.status === "completed" ? SUCCESS_ACTION_MS : FAILURE_ACTION_MS;
    setIsDiveRecovering(false);
    setMomentAction(nextAction);
    showBubble(latest.status === "completed" ? "success" : "failure", duration);
    momentTimerRef.current = window.setTimeout(() => {
      setMomentAction(null);
      momentTimerRef.current = null;
    }, duration);
  }, [isHydrated, tasks, reducedMotion, isPageVisible, showBubble]);

  return {
    action,
    bubbleKey,
    isBubbleLeaving,
    specialAction,
    isDiveRecovering,
    triggerDiveAction,
    festivalSkin: activeFestival?.skin ?? null,
    festivalPhase: activeFestival?.phase ?? null,
  };
}
