// SPDX-License-Identifier: Elastic-2.0
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { PikoWelcomeDialog } from "./PikoWelcomeDialog";
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
vi.mock("./piko-audio", () => ({ playPikoUiSound: vi.fn(), unlockPikoNotifications: vi.fn() }));
it("does not open automatically and completes only after both pages",async()=>{
  const onComplete=vi.fn(), onOpenChange=vi.fn();
  const {rerender}=render(<PikoWelcomeDialog open={false} onOpenChange={onOpenChange} onComplete={onComplete}/>);
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<PikoWelcomeDialog open onOpenChange={onOpenChange} onComplete={onComplete}/>);
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(screen.getByText(/欢迎来到 Piko 小镇/)).toBeInTheDocument();
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

it("plays once per opening, not per page, and stops on close", async () => {
  const { rerender } = render(<PikoWelcomeDialog open={false} onOpenChange={() => {}} />);
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  rerender(<PikoWelcomeDialog open onOpenChange={() => {}} />);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  fireEvent.click(await screen.findByRole("button", { name: "继续听听" }));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  rerender(<PikoWelcomeDialog open={false} onOpenChange={() => {}} />);
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
});
