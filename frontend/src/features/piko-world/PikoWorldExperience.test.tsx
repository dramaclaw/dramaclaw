// SPDX-License-Identifier: Elastic-2.0
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PikoWorldExperience } from "./PikoWorldExperience";
import { readPikoPlayer, savePikoPlayer } from "./piko-player";
const auth = vi.hoisted(() => ({ username: "alice" }));
vi.mock("@/stores/auth-store", () => ({ useAuthStore: (select: (state: typeof auth) => unknown) => select(auth) }));
vi.mock("./PikoWorldShell", () => ({ PikoWorldShell: ({ playerGender }: { playerGender: string }) => <div data-testid="world">{playerGender}</div> }));
vi.mock("./PikoOnboarding", () => ({ PikoOnboarding: ({ onSave, onEnter, onMusicStart }: { onMusicStart: () => void; onSave: (gender: "female", name: string) => boolean; onEnter: () => void }) => <><button onClick={onMusicStart}>listen</button><button onClick={() => { if (onSave("female", "小花")) onEnter(); }}>create</button></> }));
beforeEach(() => { localStorage.clear(); auth.username = "alice"; });
it("mounts the world only after successful creation, persists identity and resets on account change", () => {
  const { rerender } = render(<PikoWorldExperience />);
  expect(screen.queryByTestId("world")).toBeNull(); fireEvent.click(screen.getByText("create"));
  expect(screen.getByTestId("world")).toHaveTextContent("female");
  expect(readPikoPlayer("alice")?.gender).toBe("female");
  auth.username = "bob"; rerender(<PikoWorldExperience />);
  expect(screen.queryByTestId("world")).toBeNull();
  auth.username = "alice"; rerender(<PikoWorldExperience />);
  expect(screen.queryByTestId("world")).toBeNull();
  expect(screen.getByText("create")).toBeInTheDocument();
});
it("development entry clears previous creation and always replays onboarding", () => {
  savePikoPlayer("alice", "male", "小叶"); render(<PikoWorldExperience />);
  expect(screen.getByText("create")).toBeInTheDocument(); expect(screen.queryByTestId("world")).toBeNull();
  expect(readPikoPlayer("alice")).toBeNull();
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
    fireEvent.click(screen.getByText("listen"));
    await act(async () => {});
    act(() => vi.advanceTimersByTime(2000));
    expect(clips).toHaveLength(1); expect(clips[0].volume).toBe(0.7);
    fireEvent.click(screen.getByText("create"));
    expect(screen.getByTestId("world")).toBeInTheDocument();
    expect(clips).toHaveLength(1); expect(clips[0].removeAttribute).not.toHaveBeenCalled();
    unmount(); act(() => vi.advanceTimersByTime(800));
    expect(clips[0].removeAttribute).toHaveBeenCalledWith("src");
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
