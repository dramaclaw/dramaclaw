// SPDX-License-Identifier: Elastic-2.0
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PikoWelcomeDialog } from "./PikoWelcomeDialog";
vi.mock("./piko-audio", () => ({ playPikoUiSound: vi.fn(), unlockPikoNotifications: vi.fn() }));
it("does not open automatically and completes only after all three pages",async()=>{
  const onComplete=vi.fn(), onOpenChange=vi.fn();
  const {rerender}=render(<PikoWelcomeDialog open={false} onOpenChange={onOpenChange} onComplete={onComplete}/>);
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<PikoWelcomeDialog open onOpenChange={onOpenChange} onComplete={onComplete}/>);
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText(/欢迎来到 Piko 小镇/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"继续听听"}));
  fireEvent.click(screen.getByRole("button",{name:"继续听听"}));
  expect(onComplete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"去庭院逛逛"}));
  expect(onComplete).toHaveBeenCalledOnce();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
it("allows Escape without marking the welcome complete",async()=>{
  const onComplete=vi.fn(),onOpenChange=vi.fn();
  render(<PikoWelcomeDialog open onComplete={onComplete} onOpenChange={onOpenChange}/>);
  await screen.findByRole("dialog");
  fireEvent.keyDown(document.activeElement ?? document.body,{key:"Escape",code:"Escape"});
  await waitFor(()=>expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(onComplete).not.toHaveBeenCalled();
});
