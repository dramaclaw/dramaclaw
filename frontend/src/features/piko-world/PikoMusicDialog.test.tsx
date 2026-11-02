import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PikoMusicDialog } from "./PikoMusicDialog";
import { playPikoUiSound } from "./piko-audio";
const state = vi.hoisted(() => ({ playback: { src: "/piko/world/audio/bgm/welcome-courtyard-01.mp3", playing: false, error: false }, mute: vi.fn(), select: vi.fn() }));
vi.mock("./piko-bgm", () => ({ usePikoSelection: () => null, usePikoPlayback: () => state.playback, setPikoMusicMuted: state.mute, selectPikoMusic: state.select }));
vi.mock("./piko-audio", () => ({ playPikoUiSound: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
it("uses the shared icon feedback and close sound", () => {
  const onOpenChange = vi.fn();
  render(<PikoMusicDialog open onOpenChange={onOpenChange} />);
  const close = screen.getByRole("button", { name: "关闭音乐播放器" });
  expect(close.className).toContain("button");
  fireEvent.click(close);
  expect(playPikoUiSound).toHaveBeenCalledWith("close");
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
it("toggles the current song from its row and delays rotation until the arm lands", () => {
  vi.useFakeTimers();
  const props = { open: true, onOpenChange: vi.fn() };
  const { rerender } = render(<PikoMusicDialog {...props} />);
  expect(screen.getByText("Piko小镇原声OST")).toBeTruthy();
  expect(screen.queryByText("跟随地图")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "播放风栖初逢之庭-初见" }));
  expect(state.mute).toHaveBeenLastCalledWith(false);
  state.playback = { ...state.playback, playing: true };
  rerender(<PikoMusicDialog {...props} />);
  const disc = () => document.querySelector<HTMLElement>('[style*="animation-play-state"]')!;
  expect(disc().style.animationPlayState).toBe("paused");
  act(() => vi.advanceTimersByTime(650));
  expect(disc().style.animationPlayState).toBe("running");
  fireEvent.click(screen.getByRole("button", { name: "暂停风栖初逢之庭-初见" }));
  expect(state.mute).toHaveBeenLastCalledWith(true);
  state.playback = { ...state.playback, playing: false };
  rerender(<PikoMusicDialog {...props} />);
  expect(disc().style.animationPlayState).toBe("paused");
  state.playback = { ...state.playback, playing: true };
  rerender(<PikoMusicDialog {...props} />);
  act(() => vi.advanceTimersByTime(200));
  state.playback = { ...state.playback, playing: false };
  rerender(<PikoMusicDialog {...props} />);
  act(() => vi.advanceTimersByTime(650));
  expect(disc().style.animationPlayState).toBe("paused");
});

it("reveals a current track below the first page on opening and reopening", () => {
  vi.useFakeTimers();
  const scrollTo = vi.fn();
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  const offsets = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "LI" ? Array.from(this.parentElement!.children).indexOf(this) * 50 : 0;
  });
  state.playback = { src: "/piko/world/audio/bgm/whalesong-skyport.mp3", playing: true, error: false };
  try {
    const { rerender } = render(<PikoMusicDialog open={false} onOpenChange={vi.fn()} />);
    rerender(<PikoMusicDialog open onOpenChange={vi.fn()} />);
    act(() => vi.advanceTimersByTime(32));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 400, behavior: "instant" });
    expect(scrollTo.mock.instances[scrollTo.mock.instances.length - 1]).toBe(screen.getByRole("list", { name: "地图音乐列表" }));
    rerender(<PikoMusicDialog open={false} onOpenChange={vi.fn()} />);
    act(() => vi.advanceTimersByTime(1000));
    scrollTo.mockClear();
    rerender(<PikoMusicDialog open onOpenChange={vi.fn()} />);
    act(() => vi.advanceTimersByTime(32));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 400, behavior: "instant" });
  } finally {
    cleanup(); offsets.mockRestore();
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollTo", original);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    state.playback = { src: "/piko/world/audio/bgm/welcome-courtyard-01.mp3", playing: false, error: false };
  }
});
