// SPDX-License-Identifier: Elastic-2.0
import { useEffect } from "react";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PikoWorldShell } from "./PikoWorldShell";
import { PikoProfileDialog } from "./PikoProfileDialog";
import { readPikoProfile, usePikoProfile } from "./piko-profile";

vi.mock("./piko-audio", () => ({ playPikoUiSound: vi.fn(), unlockPikoNotifications: vi.fn() }));
vi.mock("@/stores/auth-store", () => ({ useAuthStore: (select: (state: { username: string }) => unknown) => select({ username: "alice" }) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("./PikoWorldCanvas", () => ({
  PikoWorldCanvas: ({ nickname, speech, movementBlocked, onLoadStateChange }: {
    nickname: string; speech?: { body: string } | null; movementBlocked: boolean; onLoadStateChange: (state: "ready") => void;
  }) => {
    useEffect(() => onLoadStateChange("ready"), [onLoadStateChange]);
    return <div data-testid="map" data-blocked={String(movementBlocked)} data-speech={speech?.body ?? ""}>{nickname}</div>;
  },
}));
vi.mock("./PikoLoadingScreen", () => ({ PikoLoadingScreen: ({ onEnter }: { onEnter: () => void }) => <button onClick={onEnter}>Enter test map</button> }));
vi.mock("./PikoWardrobeDialog", () => ({
  PikoWardrobeDialog: ({ open }: { open: boolean }) => open ? <div data-testid="wardrobe" /> : null,
}));

beforeEach(() => {
  localStorage.clear();
  // Base UI distinguishes the pointer mousedown from the subsequent click.
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "mouse";
    }
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("opens settings before either dialog, saves the nickname to the map and preserves cancelled edits", async () => {
  const user = userEvent.setup();
  render(<PikoWorldShell />);
  await user.click(screen.getByRole("button", { name: "Enter test map" }));
  await waitFor(() => expect(screen.getByTestId("map").parentElement).not.toHaveAttribute("inert"), { timeout: 2000 });
  expect(screen.getByTestId("map")).toHaveTextContent("alice");
  await user.click(screen.getByRole("button", { name: "设置" }));
  expect(await screen.findByRole("menuitem", { name: "修改个人信息" })).toBeVisible();
  expect(screen.queryByTestId("wardrobe")).toBeNull();
  await user.click(await screen.findByRole("menuitem", { name: "修改个人信息" }));
  await user.clear(screen.getByLabelText("昵称"));
  await user.type(screen.getByLabelText("昵称"), "小禾");
  await user.type(screen.getByLabelText("个人简介"), "喜欢在庭院散步。");
  await user.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(screen.getByTestId("map")).toHaveTextContent("小禾");
  expect(readPikoProfile("alice")).toEqual({ nickname: "小禾", bio: "喜欢在庭院散步。" });
  await user.click(screen.getByRole("button", { name: "设置" }));
  await user.click(await screen.findByRole("menuitem", { name: "修改个人信息" }));
  await user.clear(screen.getByLabelText("昵称"));
  await user.type(screen.getByLabelText("昵称"), "未保存");
  await user.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(screen.getByTestId("map")).toHaveTextContent("小禾");
  await user.click(screen.getByRole("button", { name: "设置" }));
  await user.click(await screen.findByRole("menuitem", { name: "角色装扮" }));
  expect(screen.getByTestId("wardrobe")).toBeInTheDocument();
});

it("rejects blank nicknames and keeps the profile form open if persistence fails", () => {
  const onSave = vi.fn(() => false), onOpenChange = vi.fn();
  render(<PikoProfileDialog open profile={{ nickname: "Alice", bio: "" }} onSave={onSave} onOpenChange={onOpenChange} />);
  fireEvent.change(screen.getByLabelText("昵称"), { target: { value: "   " } });
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("昵称"), { target: { value: "  小禾  " } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(onSave).toHaveBeenCalledWith({ nickname: "小禾", bio: "" });
  expect(screen.getByRole("alert")).toBeVisible();
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("isolates profiles by account and restores the saved nickname on return", () => {
  const { result, rerender } = renderHook(({ username }) => usePikoProfile(username), { initialProps: { username: "alice" } });
  act(() => { expect(result.current.saveProfile({ nickname: "小禾", bio: "散步" })).toBe(true); });
  rerender({ username: "bob" });
  expect(result.current.profile).toEqual({ nickname: "bob", bio: "" });
  rerender({ username: "alice" });
  expect(result.current.profile).toEqual({ nickname: "小禾", bio: "散步" });
});

it("does not claim a save succeeded when local storage is unavailable", () => {
  const { result } = renderHook(() => usePikoProfile("alice"));
  vi.spyOn(localStorage instanceof Storage ? Storage.prototype : localStorage, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
  act(() => { expect(result.current.saveProfile({ nickname: "小禾", bio: "" })).toBe(false); });
  expect(result.current.profile.nickname).toBe("alice");
});

it("sends public chat to the player bubble and blocks repeated Enter without losing the draft", async () => {
  const user = userEvent.setup();
  render(<PikoWorldShell />);
  await user.click(screen.getByRole("button", { name: "Enter test map" }));
  await waitFor(() => expect(screen.getByTestId("map").parentElement).not.toHaveAttribute("inert"), { timeout: 2000 });
  await user.click(screen.getByRole("button", { name: /打开或收起世界聊天/ }));
  const input = screen.getByPlaceholderText("和小镇的大家说点什么吧…");
  await user.type(input, "大家好{Enter}");
  expect(screen.getByTestId("map")).toHaveAttribute("data-speech", "大家好");
  expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  expect(screen.getByText(/请等待 [123] 秒/)).toBeVisible();
  await user.type(input, "再说一句{Enter}");
  expect(input).toHaveValue("再说一句");
  expect(screen.getByTestId("map")).toHaveAttribute("data-speech", "大家好");
  expect(screen.queryByText("再说一句", { selector: "article p" })).toBeNull();
});
