// SPDX-License-Identifier: Elastic-2.0
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PikoWorldExperience } from "./PikoWorldExperience";
import { readPikoPlayer, savePikoPlayer } from "./piko-player";
import { selectPikoMusic, setPikoMusicMuted, usePikoSelection, usePikoMusicMuted, usePikoPlayback } from "./piko-bgm";
import { PIKO_MUSIC_PLAYLISTS } from "./piko-map-music";
import { renderHook } from "@testing-library/react";
const auth = vi.hoisted(() => ({ username: "alice" }));
const worldApi = vi.hoisted(() => ({ character: null as null | {
  id: string; nickname: string; gender: "male" | "female"; bio: string;
  scene_id: string; position_x: number; position_y: number; facing: "south";
} }));
vi.mock("@/stores/auth-store", () => ({ useAuthStore: (select: (state: typeof auth) => unknown) => select(auth) }));
vi.mock("./use-piko-task-status", () => ({ usePikoTaskStatus: () => ({ status: null }) }));
vi.mock("./PikoWorldShell", () => ({ PikoWorldShell: ({ playerGender }: { playerGender: string }) => <div data-testid="world">{playerGender}</div> }));
vi.mock("./PikoOnboarding", () => ({ PikoOnboarding: ({ onSave, onEnter, onMusicStart }: { onMusicStart: () => void; onSave: (gender: "female", name: string) => boolean | Promise<boolean>; onEnter: () => void }) => <><button onClick={onMusicStart}>listen</button><button onClick={async () => { if (await onSave("female", "小花")) onEnter(); }}>create</button></> }));
vi.mock("./piko-world-client", () => ({
  fetchPikoCharacter: vi.fn(async () => worldApi.character),
  savePikoCharacter: vi.fn(async (gender: "male" | "female", nickname: string) => ({
    id: "character-alice", nickname, gender, bio: "", scene_id: "welcome-courtyard",
    position_x: 1270, position_y: 480, facing: "south",
  })),
}));
beforeEach(() => { localStorage.clear(); auth.username = "alice"; worldApi.character = null; vi.spyOn(document, "hasFocus").mockReturnValue(true); });
afterEach(() => vi.restoreAllMocks());
it("resets manual selection, pause and progress for each new town visit", async () => {
  const clips: (EventTarget & { src: string; currentTime: number; duration: number; play: ReturnType<typeof vi.fn> })[] = [];
  vi.stubGlobal("Audio", class extends EventTarget {
    volume = 0; currentTime = 0; duration = 180;
    play = vi.fn().mockResolvedValue(undefined); pause = vi.fn(); load = vi.fn(); removeAttribute = vi.fn();
    constructor(public src: string) { super(); clips.push(this); }
  });
  const state = renderHook(() => ({ selection: usePikoSelection(), muted: usePikoMusicMuted(), playback: usePikoPlayback() }));
  try {
    const first = render(<PikoWorldExperience />);
    fireEvent.click(await screen.findByText("listen"));
    await act(async () => {});
    act(() => selectPikoMusic(PIKO_MUSIC_PLAYLISTS.skyport));
    await act(async () => {});
    act(() => { clips[clips.length - 1].currentTime = 42; clips[clips.length - 1].dispatchEvent(new Event("timeupdate")); setPikoMusicMuted(true); });
    expect(state.result.current.selection).toBe(PIKO_MUSIC_PLAYLISTS.skyport);
    expect(state.result.current.playback.currentTime).toBe(42);
    first.unmount();
    const second = render(<PikoWorldExperience />);
    expect(state.result.current.selection).toBeNull();
    expect(state.result.current.muted).toBe(false);
    expect(state.result.current.playback.currentTime).toBe(0);
    fireEvent.click(await screen.findByText("listen"));
    await act(async () => {});
    expect(clips[clips.length - 1].src).toBe(PIKO_MUSIC_PLAYLISTS.courtyard[0]);
    expect(clips[clips.length - 1].currentTime).toBe(0);
    expect(state.result.current.playback.playing).toBe(true);
    second.unmount();
  } finally { state.unmount(); vi.unstubAllGlobals(); }
});
it("mounts the world only after successful creation and isolates account state", async () => {
  const { rerender } = render(<PikoWorldExperience />);
  expect(screen.queryByTestId("world")).toBeNull(); fireEvent.click(await screen.findByText("create"));
  expect(await screen.findByTestId("world")).toHaveTextContent("female");
  expect(readPikoPlayer("alice")?.gender).toBe("female");
  auth.username = "bob"; rerender(<PikoWorldExperience />);
  expect(screen.queryByTestId("world")).toBeNull(); await screen.findByText("create");
  auth.username = "alice"; rerender(<PikoWorldExperience />);
  expect(screen.queryByTestId("world")).toBeNull();
  expect(await screen.findByText("create")).toBeInTheDocument();
});
it("loads an existing account character without replaying onboarding", async () => {
  worldApi.character = { id: "existing", nickname: "小叶", gender: "male", bio: "", scene_id: "welcome-courtyard", position_x: 900, position_y: 500, facing: "south" };
  savePikoPlayer("alice", "male", "小叶"); render(<PikoWorldExperience />);
  expect(await screen.findByTestId("world")).toHaveTextContent("male");
  expect(screen.queryByText("create")).toBeNull();
  expect(readPikoPlayer("alice")?.nickname).toBe("小叶");
});

it("keeps the same music channel from creation through map entry and releases it on exit", async () => {
  vi.useFakeTimers();
  const clips: { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; volume: number }[] = [];
  vi.stubGlobal("Audio", class {
    constructor() { const clip = Object.assign(new EventTarget(), { volume: 0, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() }); clips.push(clip); return clip; }
  });
  try {
    const { unmount } = render(<PikoWorldExperience />);
    expect(clips).toHaveLength(0);
    await act(async () => {});
    fireEvent.click(screen.getByText("listen"));
    await act(async () => {});
    act(() => vi.advanceTimersByTime(2000));
    expect(clips).toHaveLength(1); expect(clips[0].volume).toBe(1);
    await act(async () => { fireEvent.click(screen.getByText("create")); });
    expect(screen.getByTestId("world")).toBeInTheDocument();
    expect(clips).toHaveLength(1); expect(clips[0].removeAttribute).not.toHaveBeenCalled();
    unmount(); act(() => vi.advanceTimersByTime(800));
    expect(clips[0].removeAttribute).toHaveBeenCalledWith("src");
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
