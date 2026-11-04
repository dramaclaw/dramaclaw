// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AudioPreviewPlayer } from "@/components/ui/audio-preview-player";
import { AssetLibraryItemMedia } from "@/features/canvas/ui/AssetLibraryItemMedia";
import type { LibraryItem } from "@/features/canvas/ui/assetLibraryItems";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("shows known duration before metadata and has one keyboard-operable playback control", () => {
  render(<AudioPreviewPlayer src="blob:preview" durationSeconds={4.5} label="preview" playLabel="play preview" />);
  expect(screen.getByText("0:00 / 0:04")).toBeInTheDocument();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  const slider = screen.getByRole("slider");
  expect(slider).toHaveAttribute("type", "range");
  expect(slider).toHaveAttribute("max", "4.5");
  fireEvent.change(slider, { target: { value: "2.5" } });
  const audio = screen.getByLabelText<HTMLAudioElement>("preview");
  expect(audio.currentTime).toBe(2.5);
  fireEvent.click(screen.getByRole("button", { name: "play preview" }));
  expect(audio.play).toHaveBeenCalledOnce();
});

it("shares playback with existing asset cards and pauses the earlier track", () => {
  const entry = { id: "a1", name: "saved voice", media: "audio", source: "upload", category: "audio", folder: "audio", url: "/voice.mp3", raw: {} } satisfies LibraryItem;
  const { container } = render(<><AssetLibraryItemMedia entry={entry} /><AudioPreviewPlayer src="blob:preview" label="preview" /></>);
  const audios = container.querySelectorAll("audio");
  expect(audios).toHaveLength(2);
  const first = audios.item(0);
  const second = audios.item(1);
  const pause = vi.spyOn(first, "pause");
  fireEvent.play(first);
  fireEvent.play(second);
  expect(pause).toHaveBeenCalledOnce();
});

it("disables expired previews, pauses on close, and stops on unmount", () => {
  const view = render(<AudioPreviewPlayer src="blob:preview" label="preview" playLabel="play preview" />);
  const audio = screen.getByLabelText<HTMLAudioElement>("preview");
  const pause = vi.spyOn(audio, "pause");
  view.rerender(<AudioPreviewPlayer src="blob:preview" label="preview" playLabel="play preview" disabled />);
  expect(screen.getByRole("button", { name: "play preview" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "play preview" }));
  expect(audio.play).not.toHaveBeenCalled();
  expect(pause).toHaveBeenCalled();
  view.unmount();
  expect(pause.mock.calls.length).toBeGreaterThan(1);
});

it("surfaces real playback rejection for the authenticated preview retry UI", async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new Error("decode failed"));
  const error = vi.fn();
  render(<AudioPreviewPlayer src="blob:bad" onError={error} playLabel="play preview" />);
  fireEvent.click(screen.getByRole("button", { name: "play preview" }));
  await Promise.resolve();
  expect(error).toHaveBeenCalledOnce();
});

it("keeps asset-card seek controls accessible from the keyboard", () => {
  render(<AudioPreviewPlayer src="/saved.mp3" durationSeconds={10} layout="card" label="saved voice" />);
  const audio = screen.getByLabelText<HTMLAudioElement>("saved voice");
  const slider = screen.getByRole("slider");
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  expect(audio.currentTime).toBe(1);
  fireEvent.keyDown(slider, { key: "End" });
  expect(audio.currentTime).toBe(10);
  fireEvent.keyDown(slider, { key: "Home" });
  expect(audio.currentTime).toBe(0);
});

it.each(["card", "inline"] as const)("lets %s background clicks activate the card but isolates playback and seeking", (layout) => {
  const activate = vi.fn();
  const { container } = render(<div onClick={activate}><AudioPreviewPlayer src="/saved.mp3" durationSeconds={10} layout={layout} label="saved voice" /></div>);
  const audio = screen.getByLabelText<HTMLAudioElement>("saved voice");
  fireEvent.click(screen.getByRole("button"));
  expect(audio.play).toHaveBeenCalledOnce();
  expect(activate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("slider"));
  expect(activate).not.toHaveBeenCalled();
  const player = container.querySelector("audio")?.parentElement;
  expect(player).not.toBeNull();
  if (player) fireEvent.click(player);
  expect(activate).toHaveBeenCalledOnce();
});
