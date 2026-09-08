// SPDX-License-Identifier: Elastic-2.0
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PikoResidentInteraction } from "./PikoResidentInteraction";
import { playPikoUiSound } from "./piko-audio";
import { PIKO_SIMULATED_RESIDENT } from "./piko-simulated-resident";
vi.mock("./piko-audio", () => ({ playPikoUiSound: vi.fn(), unlockPikoNotifications: vi.fn() }));
vi.mock("./runtime/resident-actor", () => ({ RESIDENT_WORLD_SCALE: 2 }));
beforeEach(() => {
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? "mouse"; }
  });
});
afterEach(() => vi.unstubAllGlobals());
const props = () => ({ target: PIKO_SIMULATED_RESIDENT, position: { x: 100, y: 200 }, fit: { x: 10, y: 20, scale: 1 }, onBusyChange: vi.fn(), onHover: vi.fn() });
it("shows the clicked resident profile and releases movement after closing", async () => {
  const user = userEvent.setup(), input = props();
  render(<PikoResidentInteraction {...input} />);
  await user.click(screen.getByRole("button", { name: "与小苔互动" }));
  expect((await screen.findAllByRole("menuitem")).map(el => el.textContent)).toEqual(["查看信息", "聊一聊", "关闭"]);
  expect(input.onBusyChange).toHaveBeenLastCalledWith(true);
  await user.click(await screen.findByRole("menuitem", { name: "查看信息" }));
  expect(await screen.findByRole("dialog", { name: "小苔" })).toBeVisible();
  expect(screen.getByText(PIKO_SIMULATED_RESIDENT.bio)).toBeVisible();
  expect(screen.queryByText("临时模拟居民")).toBeNull();
  expect(screen.getByRole("dialog").querySelectorAll("img")).toHaveLength(1);
  expect(playPikoUiSound).toHaveBeenLastCalledWith("open");
  expect(screen.queryByRole("textbox")).toBeNull();
  await user.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(input.onBusyChange).toHaveBeenLastCalledWith(false);
});
it("closes with Escape and shows a non-modal local chat request notice", async () => {
  const user = userEvent.setup(), input = props();
  render(<PikoResidentInteraction {...input} />);
  const trigger = screen.getByRole("button", { name: "与小苔互动" });
  await user.click(trigger);
  await screen.findByRole("menu");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(input.onBusyChange).toHaveBeenLastCalledWith(false);
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "聊一聊" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已发送聊天申请，请等待对方回复"));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(playPikoUiSound).toHaveBeenLastCalledWith("open");
  expect(input.onBusyChange).toHaveBeenLastCalledWith(false);
});
it("tracks position and viewport changes and clears interaction state on removal", () => {
  const input = props();
  const { rerender, unmount } = render(<PikoResidentInteraction {...input} />);
  const trigger = screen.getByRole("button", { name: "与小苔互动" });
  expect(trigger.style.left).toBe("78px");
  rerender(<PikoResidentInteraction {...input} position={{ x: 300, y: 200 }} fit={{ x: 0, y: 0, scale: 0.5 }} />);
  expect(trigger.style.left).toBe("134px");
  unmount();
  expect(input.onBusyChange).toHaveBeenLastCalledWith(false);
  expect(input.onHover).toHaveBeenLastCalledWith(false);
});
it("dismisses the menu on outside click and through its close option", async () => {
  const user = userEvent.setup(), input = props();
  render(<><button>地图外部</button><PikoResidentInteraction {...input} /></>);
  const trigger = screen.getByRole("button", { name: "与小苔互动" });
  await user.click(trigger);
  await screen.findByRole("menu");
  await user.click(screen.getByRole("button", { name: "地图外部" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(input.onBusyChange).toHaveBeenLastCalledWith(false);
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "关闭" }));
  expect(playPikoUiSound).toHaveBeenLastCalledWith("close");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(input.onBusyChange).toHaveBeenLastCalledWith(false);
});
