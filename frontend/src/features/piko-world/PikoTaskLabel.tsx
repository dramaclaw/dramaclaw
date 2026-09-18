// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PIKO_TASK_LABEL_CYCLE_MS, PIKO_TASK_LABEL_FADE_MS, PIKO_TASK_LABEL_VISIBLE_MS, holdPikoLabelClock, pikoLabelPhase, updatePikoLabelClock } from "./piko-task-label";
import type { PikoOwnTaskStatus } from "./use-piko-task-status";
import type { Point } from "./runtime/character-movement";
import type { PikoViewportFit } from "./runtime/viewport-fit";
import styles from "./piko-task-label.module.css";

/** Fixed end caps with the user-provided middle slice stretched horizontally. */
export function PikoTaskLabel({ task, position, fit, available, onInteract, headOffset = 142 }: {
  task: PikoOwnTaskStatus; position: Point; fit: PikoViewportFit; available: boolean; onInteract: () => void; headOffset?: number;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const hovered = useRef(false), focused = useRef(false);
  const [placement, setPlacement] = useState({ left: 0, top: 0 });
  const [tick, setTick] = useState(0);
  const [reduced, setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const redraw = () => setTick(value => value + 1);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(query?.matches ?? false);
    query?.addEventListener("change", change);
    return () => query?.removeEventListener("change", change);
  }, []);
  useLayoutEffect(() => {
    if (!task.status) { task.clock.current = null; redraw(); return; }
    if (!available && !task.clock.current) return;
    task.clock.current = updatePikoLabelClock(task.clock.current, task.revision, Date.now(), reduced);
    redraw();
  }, [task.status, task.revision, task.clock, reduced, available]);
  useEffect(() => {
    const clock = task.clock.current;
    if (!clock || !task.status || document.hidden) return;
    if (clock.heldAt !== null) return;
    const fade = reduced ? 0 : PIKO_TASK_LABEL_FADE_MS;
    const cycle = PIKO_TASK_LABEL_CYCLE_MS;
    const elapsed = Math.max(0, Date.now() - clock.startedAt) % cycle;
    const next = [fade, fade + PIKO_TASK_LABEL_VISIBLE_MS, fade * 2 + PIKO_TASK_LABEL_VISIBLE_MS, cycle].find(boundary => boundary > elapsed)!;
    const timer = window.setTimeout(redraw, Math.max(1, next - elapsed));
    return () => clearTimeout(timer);
  }, [tick, task.status, task.revision, task.clock, reduced]);
  useEffect(() => {
    const release = () => {
      hovered.current = false; focused.current = false;
      if (task.clock.current) task.clock.current = holdPikoLabelClock(task.clock.current, false, Date.now(), reduced);
      redraw();
    };
    const visibility = () => { if (document.hidden) release(); else redraw(); };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", visibility);
      if (task.clock.current) task.clock.current = holdPikoLabelClock(task.clock.current, false, Date.now(), reduced);
    };
  }, [task.clock, reduced]);
  useEffect(() => {
    if (!available) {
      hovered.current = false; focused.current = false;
      if (task.clock.current) task.clock.current = holdPikoLabelClock(task.clock.current, false, Date.now(), reduced);
      redraw();
    }
  }, [available, task.clock, reduced]);
  useLayoutEffect(() => {
    const element = ref.current, parent = element?.parentElement;
    if (!element || !parent) return;
    const place = () => setPlacement({
      left: Math.max(8, Math.min(fit.x + position.x * fit.scale - element.offsetWidth / 2, parent.clientWidth - element.offsetWidth - 8)),
      top: Math.max(8, Math.min(fit.y + (position.y - headOffset) * fit.scale - element.offsetHeight, parent.clientHeight - element.offsetHeight - 8)),
    });
    place();
    const observer = new ResizeObserver(place);
    observer.observe(parent); observer.observe(element);
    return () => observer.disconnect();
  }, [position.x, position.y, fit.x, fit.y, fit.scale, task.status, headOffset]);
  const hold = () => {
    if (task.clock.current) task.clock.current = holdPikoLabelClock(task.clock.current, hovered.current || focused.current, Date.now(), reduced);
    redraw();
  };
  if (!task.status) return null;
  const phase = task.clock.current ? pikoLabelPhase(task.clock.current, Date.now(), reduced) : "hidden";
  const visible = available && phase !== "hidden" && !document.hidden;
  return <button ref={ref} type="button" className={styles.label} style={placement}
    data-phase={phase} data-available={visible} data-status={task.status}
    aria-label={t("pikoWorld.taskLabel.open", { status: t(`pikoWorld.taskLabel.${task.status}`) })}
    aria-hidden={!visible} aria-busy={task.opening} tabIndex={visible ? 0 : -1}
    onPointerEnter={() => { hovered.current = true; hold(); }}
    onPointerLeave={() => { hovered.current = false; hold(); }}
    onFocus={() => { focused.current = true; hold(); }}
    onBlur={() => { focused.current = false; hold(); }}
    onPointerDown={event => { event.stopPropagation(); onInteract(); }}
    onKeyDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); if (visible && !task.opening) { onInteract(); void task.open(); } }}>
    <span className={styles.skin} aria-hidden="true">
      <img src="/piko/world/ui/task-label/task-label-left-v1.png" alt="" draggable={false} />
      <img className={styles.middle} src="/piko/world/ui/task-label/task-label-middle-v1.png" alt="" draggable={false} />
      <img src="/piko/world/ui/task-label/task-label-right-v1.png" alt="" draggable={false} />
    </span>
    <span className={styles.text}>{t(`pikoWorld.taskLabel.${task.status}`)}</span><ChevronRight size={11} aria-hidden="true" />
  </button>;
}
