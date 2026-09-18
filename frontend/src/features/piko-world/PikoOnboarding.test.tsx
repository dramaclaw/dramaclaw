// SPDX-License-Identifier: Elastic-2.0
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PikoOnboarding } from "./PikoOnboarding";
vi.mock("@tanstack/react-router", () => ({ Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a> }));
const sound = vi.hoisted(() => vi.fn());
const music = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock("./piko-bgm", () => ({ startPikoMusic: music.start }));
vi.mock("./piko-audio", () => ({ playPikoUiSound: sound }));
vi.mock("./PikoCreationBackground", () => ({ PikoCreationBackground: () => null }));
let imageFailure = false;
beforeEach(() => {
  vi.useFakeTimers(); imageFailure = false; sound.mockClear();
  music.start.mockReset().mockReturnValue(music.stop); music.stop.mockReset();
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_src: string) { Promise.resolve().then(() => imageFailure ? this.onerror?.() : this.onload?.()); }
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("gesture required"));
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

it("plays courtyard music only during creation and stops before entering the map", async () => {
  const onEnter = vi.fn();
  render(<PikoOnboarding initialNickname="小叶" onSave={() => true} onEnter={onEnter} />);
  await ready(); expect(music.start).not.toHaveBeenCalled();
  await enterCreation();
  expect(music.start).toHaveBeenCalledExactlyOnceWith([
    "/piko/world/audio/bgm/welcome-courtyard-01.mp3",
    "/piko/world/audio/bgm/welcome-courtyard-warm.mp3",
  ]);
  fireEvent.click(screen.getByRole("radio", { name: "女生" }));
  expect(music.start).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "开始旅程" }));
  expect(music.stop).toHaveBeenCalledTimes(1); expect(onEnter).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(800)); expect(onEnter).toHaveBeenCalledTimes(1);
});

it("respects explicit intro mute and releases creation music on exit", async () => {
  const first = render(<PikoOnboarding initialNickname="" onSave={() => true} onEnter={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "静音" }));
  await enterCreation(); expect(music.start).not.toHaveBeenCalled(); expect(sound).not.toHaveBeenCalled(); first.unmount();
  const second = render(<PikoOnboarding initialNickname="" onSave={() => true} onEnter={vi.fn()} />);
  await enterCreation(); expect(music.start).toHaveBeenCalledTimes(1);
  second.unmount(); expect(music.stop).toHaveBeenCalledTimes(1);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function ready() { await act(async () => { await Promise.resolve(); }); }
async function enterCreation() {
  await ready(); fireEvent.ended(document.querySelector("video")!);
  act(() => vi.advanceTimersByTime(500));
  fireEvent.click(screen.getByRole("button", { name: "你也一起来吧" }));
  act(() => vi.advanceTimersByTime(800)); act(() => vi.advanceTimersByTime(800));
}
it("enters creation through the invitation, transitions under black, validates and saves selected identity once", async () => {
  const onSave = vi.fn(() => true), onEnter = vi.fn();
  render(<PikoOnboarding initialNickname="" onSave={onSave} onEnter={onEnter} />);
  await enterCreation();
  fireEvent.click(screen.getByRole("radio", { name: "女生" }));
  fireEvent.click(screen.getByRole("button", { name: "开始旅程" }));
  expect(onSave).not.toHaveBeenCalled(); expect(screen.getByRole("alert")).toHaveTextContent("昵称");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "  小花  " } });
  fireEvent.click(screen.getByRole("button", { name: "开始旅程" }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith("female", "小花");
  expect(onEnter).not.toHaveBeenCalled(); act(() => vi.advanceTimersByTime(800));
  expect(onEnter).toHaveBeenCalledTimes(1);
});
it("retains the form and permits retry when storage fails", async () => {
  const onSave = vi.fn(() => false), onEnter = vi.fn();
  render(<PikoOnboarding initialNickname="小叶" onSave={onSave} onEnter={onEnter} />);
  await enterCreation(); fireEvent.click(screen.getByRole("button", { name: "开始旅程" }));
  expect(screen.getByRole("alert")).toHaveTextContent("保存失败");
  expect(screen.getByRole("textbox")).toHaveValue("小叶"); expect(onEnter).not.toHaveBeenCalled();
  onSave.mockReturnValue(true); fireEvent.click(screen.getByRole("button", { name: "开始旅程" }));
  act(() => vi.advanceTimersByTime(800)); expect(onEnter).toHaveBeenCalledTimes(1);
});
it("does not get stuck on a failed video and treats duplicate ended events as one transition", async () => {
  const { container } = render(<PikoOnboarding initialNickname="" onSave={() => true} onEnter={vi.fn()} />);
  await ready(); const video = container.querySelector("video")!;
  fireEvent.error(video); expect(screen.getByRole("status")).toHaveTextContent("无法播放");
  fireEvent.ended(video); fireEvent.ended(video);
  act(() => vi.advanceTimersByTime(500));
  expect(screen.getByRole("button", { name: "你也一起来吧" })).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "你也一起来吧" }));
  act(() => vi.advanceTimersByTime(800)); act(() => vi.advanceTimersByTime(800));
  expect(screen.getByRole("textbox")).toBeInTheDocument(); expect(container.querySelector("video")).toBeNull();
});
it("keeps black coverage while artwork fails and supports retry", async () => {
  imageFailure = true;
  render(<PikoOnboarding initialNickname="" onSave={() => true} onEnter={vi.fn()} />);
  await ready(); fireEvent.ended(document.querySelector("video")!);
  act(() => vi.advanceTimersByTime(500));
  fireEvent.click(screen.getByRole("button", { name: "你也一起来吧" }));
  act(() => vi.advanceTimersByTime(1600)); expect(screen.getByRole("status")).toHaveTextContent("角色画面加载失败");
  expect(screen.queryByRole("textbox")).toBeNull();
  imageFailure = false; fireEvent.click(screen.getByRole("button", { name: "重试" })); await ready();
  act(() => vi.advanceTimersByTime(800)); act(() => vi.advanceTimersByTime(800));
  expect(screen.getByRole("textbox")).toBeInTheDocument();
});
it("cancels departure on unmount", async () => {
  const onEnter = vi.fn(); const { unmount } = render(<PikoOnboarding initialNickname="小叶" onSave={() => true} onEnter={onEnter} />);
  await enterCreation(); fireEvent.click(screen.getByRole("button", { name: "开始旅程" })); unmount();
  act(() => vi.advanceTimersByTime(5000)); expect(onEnter).not.toHaveBeenCalled();
});

it("autoplays without an invitation gate, retrying silently if audible playback is blocked", async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error("blocked")).mockResolvedValue(undefined);
  render(<PikoOnboarding initialNickname="" onSave={() => true} onEnter={vi.fn()} />);
  await ready(); expect(screen.queryByText("播放邀请影片")).toBeNull();
  await act(async () => { vi.advanceTimersByTime(800); });
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "开启声音" })).toBeInTheDocument();
});

it("uses the existing click sound for invitation, changed gender and valid confirmation", async () => {
  render(<PikoOnboarding initialNickname="小叶" onSave={() => true} onEnter={vi.fn()} />);
  await enterCreation();
  expect(sound).toHaveBeenCalledExactlyOnceWith("open");
  fireEvent.click(screen.getByRole("radio", { name: "女生" }));
  fireEvent.click(screen.getByRole("radio", { name: "女生" }));
  expect(sound).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "开始旅程" }));
  expect(sound).toHaveBeenCalledTimes(3);
  expect(sound).toHaveBeenLastCalledWith("open");
});

it("holds the last frame until invited and exposes mute and skip controls while playing", async () => {
  const { container } = render(<PikoOnboarding initialNickname="" onSave={() => true} onEnter={vi.fn()} />);
  await ready();
  expect(screen.getByRole("button", { name: "跳过动画" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "回到工作台" })).toBeNull();
  const video = container.querySelector("video")!;
  fireEvent.ended(video);
  act(() => vi.advanceTimersByTime(499));
  expect(screen.queryByRole("button", { name: "你也一起来吧" })).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("button", { name: "你也一起来吧" })).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(30000));
  expect(container.querySelector("video")).toBe(video);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(music.start).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "你也一起来吧" })).toHaveFocus();
});

it("allows proceeding when the intro cannot load", async () => {
  const { container } = render(<PikoOnboarding initialNickname="" onSave={() => true} onEnter={vi.fn()} />);
  await ready(); fireEvent.error(container.querySelector("video")!);
  fireEvent.click(screen.getByRole("button", { name: "你也一起来吧" }));
  act(() => vi.advanceTimersByTime(800)); act(() => vi.advanceTimersByTime(800));
  expect(screen.getByRole("textbox")).toBeInTheDocument();
});

it("starts the silent loop only after the half-second hold and retains the last frame on failure", async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockResolvedValue(undefined);
  const { container } = render(<PikoOnboarding initialNickname="" onSave={() => true} onEnter={vi.fn()} />);
  await ready();
  const [intro, loop] = container.querySelectorAll("video");
  const playedLoop = () => vi.mocked(HTMLMediaElement.prototype.play).mock.contexts.includes(loop);
  expect(loop.loop).toBe(true);
  expect(loop.muted).toBe(true);
  expect(playedLoop()).toBe(false);
  fireEvent.ended(intro);
  act(() => vi.advanceTimersByTime(499));
  expect(playedLoop()).toBe(false);
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(playedLoop()).toBe(true);
  expect(loop).toHaveAttribute("data-ready", "false");
  fireEvent.playing(loop);
  expect(loop).toHaveAttribute("data-ready", "true");
  fireEvent.error(loop);
  expect(loop).toHaveAttribute("data-ready", "false");
  expect(intro).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "你也一起来吧" }));
  act(() => vi.advanceTimersByTime(800));
  expect(container.querySelector("video")).toBeNull();
  expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).toContain(loop);
});


it("does not start delayed intro playback after the page becomes hidden", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  render(<PikoOnboarding initialNickname="" onSave={() => true} onEnter={vi.fn()} />);
  await ready();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => { vi.advanceTimersByTime(800); });
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});

it("does not restart the invitation hold when creation artwork finishes loading", async () => {
  const loaded: Array<() => void> = [];
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_src: string) { loaded.push(() => this.onload?.()); }
  });
  render(<PikoOnboarding initialNickname="" onSave={() => true} onEnter={vi.fn()} />);
  fireEvent.ended(document.querySelector("video")!);
  act(() => vi.advanceTimersByTime(300));
  await act(async () => { loaded.forEach(finish => finish()); });
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByRole("button", { name: "你也一起来吧" })).toBeInTheDocument();
});

it("does not retry audible autoplay silently after the page is hidden", async () => {
  let rejectPlay!: (reason: Error) => void;
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectPlay = reject; }));
  render(<PikoOnboarding initialNickname="" onSave={() => true} onEnter={vi.fn()} />);
  await ready();
  act(() => vi.advanceTimersByTime(800));
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => { rejectPlay(new Error("blocked")); });
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
});

it("skips the intro into the invitation and pauses its video", async () => {
  const { container } = render(<PikoOnboarding initialNickname="" onSave={vi.fn()} onEnter={vi.fn()} />);
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "跳过动画" }));
  expect(screen.queryByRole("button", { name: "跳过动画" })).toBeNull();
  expect(container.querySelector('img[src*="invitation-wordmark"]')).toBeTruthy();
});
