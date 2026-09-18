// SPDX-License-Identifier: Elastic-2.0
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PikoTaskLabel } from "./PikoTaskLabel";
import type { PikoOwnTaskStatus } from "./use-piko-task-status";
vi.mock("react-i18next",()=>({useTranslation:()=>({t:(key:string)=>key})}));
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(100000);vi.stubGlobal("ResizeObserver",class {observe(){} disconnect(){}});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
const model=():PikoOwnTaskStatus=>({status:"running",revision:"running",clock:{current:null},opening:false,open:vi.fn().mockResolvedValue(undefined)});
const props={position:{x:300,y:300},fit:{x:0,y:0,scale:1},available:true,onInteract:vi.fn()};
it("cycles, disables hidden hit targets and interrupts waiting immediately on completion",()=>{
  const task=model(); const view=render(<PikoTaskLabel {...props} task={task}/>);
  const button=screen.getByRole("button");
  expect(button).toHaveAttribute("data-phase","fade-in");
  act(()=>vi.advanceTimersByTime(5500));
  expect(button).toHaveAttribute("data-available","false");expect(button).toHaveAttribute("tabindex","-1");
  fireEvent.click(button);expect(task.open).not.toHaveBeenCalled();
  view.rerender(<PikoTaskLabel {...props} task={{...task,status:"completed",revision:"completed:r1"}}/>);
  expect(button).toHaveAttribute("data-available","true");expect(button).toHaveAttribute("data-phase","fade-in");
  fireEvent.click(button);expect(task.open).toHaveBeenCalledOnce();
});
it("holds until both pointer and focus leave and resumes remaining display time",()=>{
  render(<PikoTaskLabel {...props} task={model()}/>);
  const button=screen.getByRole("button");
  act(()=>vi.advanceTimersByTime(1000));
  fireEvent.pointerEnter(button);fireEvent.focus(button);
  act(()=>vi.advanceTimersByTime(30000));
  fireEvent.pointerLeave(button);
  expect(button).toHaveAttribute("data-phase","visible");
  act(()=>vi.advanceTimersByTime(30000));
  expect(button).toHaveAttribute("data-phase","visible");
  fireEvent.blur(button);
  act(()=>vi.advanceTimersByTime(4500));
  expect(button).toHaveAttribute("data-phase","hidden");
});
it("does not restart when a map remounts and cleans up its timers",()=>{
  const task=model();const first=render(<PikoTaskLabel {...props} task={task}/>);
  act(()=>vi.advanceTimersByTime(6000));first.unmount();
  expect(vi.getTimerCount()).toBe(0);
  const second=render(<PikoTaskLabel {...props} task={task}/>);
  expect(second.container.querySelector("button")).toHaveAttribute("data-phase","hidden");
  act(()=>vi.advanceTimersByTime(9000));
  expect(screen.getByRole("button")).toHaveAttribute("data-phase","fade-in");
  second.unmount();expect(vi.getTimerCount()).toBe(0);
});
it("starts the first display only when the map is ready and blocks bubbling movement clicks",()=>{
  const task=model();const move=vi.fn();
  const view=render(<div onPointerDown={move} onClick={move}><PikoTaskLabel {...props} available={false} task={task}/></div>);
  act(()=>vi.advanceTimersByTime(20000));expect(task.clock.current).toBeNull();
  view.rerender(<div onPointerDown={move} onClick={move}><PikoTaskLabel {...props} task={task}/></div>);
  const button=screen.getByRole("button");expect(button).toHaveAttribute("data-phase","fade-in");
  fireEvent.pointerDown(button);fireEvent.click(button);expect(move).not.toHaveBeenCalled();
});
