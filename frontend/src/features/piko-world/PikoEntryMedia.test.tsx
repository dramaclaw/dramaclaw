// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PikoEntryMedia } from "./PikoEntryMedia";

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("framer-motion", () => ({ useReducedMotion: () => motion.reduced }));

beforeEach(() => {
  motion.reduced = false;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Piko entry hover video", () => {
  it("loads only on interaction and returns to frame zero on leave", () => {
    const { container, rerender } = render(<PikoEntryMedia active={false} />);
    const video = container.querySelector("video")!;
    const poster = container.querySelector("img")!;
    expect(video.getAttribute("src")).toBeNull();
    rerender(<PikoEntryMedia active />);
    expect(video.getAttribute("src")).toMatch(/\.(webm|mov)$/);
    expect(video.play).toHaveBeenCalled();
    fireEvent.playing(video);
    expect(poster.className).toContain("invisible");
    video.currentTime = 3;
    rerender(<PikoEntryMedia active={false} />);
    expect(video.currentTime).toBe(0);
    expect(poster.className).not.toContain("invisible");
    // A late media event after leave must not hide the static frame.
    fireEvent.playing(video);
    expect(poster.className).not.toContain("invisible");
  });

  it("keeps the poster if playback fails and retries on the next hover", () => {
    const { container, rerender } = render(<PikoEntryMedia active />);
    const video = container.querySelector("video")!;
    fireEvent.playing(video);
    Object.defineProperty(video, "error", { configurable: true, value: { code: 2 } });
    fireEvent.error(video);
    expect(container.querySelector("img")!.className).not.toContain("invisible");
    rerender(<PikoEntryMedia active={false} />);
    rerender(<PikoEntryMedia active />);
    expect(video.load).toHaveBeenCalled();
  });

  it("does not load or play motion when reduced motion is enabled", () => {
    motion.reduced = true;
    const { container } = render(<PikoEntryMedia active />);
    expect(container.querySelector("video")!.getAttribute("src")).toBeNull();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
});
