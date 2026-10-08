// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import {
  PromptMentionEditor,
  mentionChipLabel,
  truncateChipLabel,
  type MentionCandidate,
} from "@/features/canvas/nodes/PromptMentionEditor";

const audioCandidate: MentionCandidate = {
  key: "A",
  name: "音频1",
  imageUrl: "",
  index: 1,
  audioUrl: "/static/projects/p/audio/long-voice-clip-name.mp3",
  displayName: "long-voice-clip-name.mp3",
};

const mixedCandidate: MentionCandidate = {
  key: "mixed-audio",
  name: "Mixed 2",
  serializedToken: "{{Mixed 2}}",
  imageUrl: "",
  index: 2,
  audioUrl: "/static/projects/p/audio/voice.mp3",
  displayName: "voice.mp3",
};

describe("PromptMentionEditor — 音频引用 chip", () => {
  it("shows a 10-char-capped label but keeps the backend token (@音频1) unchanged", () => {
    const { container } = render(
      <PromptMentionEditor value="@音频1 " onChange={() => {}} candidates={[audioCandidate]} />,
    );
    const chip = container.querySelector(".mention-chip");
    expect(chip).not.toBeNull();
    // Visible label is capped at 10 chars + ellipsis.
    expect(chip?.querySelector(".mention-chip-label")?.textContent).toBe("音频_long-vo…");
    // ...but the serialized token stays the numbered name (what reaches the backend).
    expect(chip?.getAttribute("data-name")).toBe("音频1");
    // Full name remains available in the tooltip.
    expect(chip?.getAttribute("title")).toContain("音频_long-voice-clip-name.mp3");
  });

  it("renders a clickable play control carrying the audio url", () => {
    const { container } = render(
      <PromptMentionEditor value="@音频1 " onChange={() => {}} candidates={[audioCandidate]} />,
    );
    const chip = container.querySelector(".mention-chip");
    expect(chip?.querySelector("[data-audio-play]")).not.toBeNull();
    expect(chip?.getAttribute("data-audio-url")).toBe(
      "/static/projects/p/audio/long-voice-clip-name.mp3",
    );
  });

  it("mentionChipLabel appends filename only for audio; image keeps its base label", () => {
    expect(mentionChipLabel(audioCandidate)).toBe("音频_long-voice-clip-name.mp3");
    expect(
      mentionChipLabel({ key: "I", name: "图片2", imageUrl: "x", index: 2 }),
    ).toBe("图片");
  });

  it("truncateChipLabel caps at 10 chars and leaves short labels intact", () => {
    expect(truncateChipLabel("音频_long-voice-clip-name.mp3")).toBe("音频_long-vo…");
    expect(truncateChipLabel("音频_短")).toBe("音频_短");
    expect(truncateChipLabel("1234567890")).toBe("1234567890"); // exactly 10, no ellipsis
  });

  it("renders and serializes an H3 Mixed token without adding an @ prefix", () => {
    const onChange = vi.fn();
    const { container } = render(
      <PromptMentionEditor
        value="使用 {{Mixed 2}}"
        onChange={onChange}
        candidates={[mixedCandidate]}
      />,
    );
    const chip = container.querySelector<HTMLElement>(".mention-chip");
    expect(chip?.dataset.name).toBe("Mixed 2");
    expect(chip?.dataset.token).toBe("{{Mixed 2}}");
    expect(chip?.querySelector(".mention-chip-label")?.textContent).toBe(
      "Mixed 2_vo…",
    );

    const editor = container.querySelector<HTMLElement>("[contenteditable=true]");
    editor?.appendChild(document.createTextNode(" 收尾"));
    if (editor) fireEvent.input(editor);
    expect(onChange).toHaveBeenLastCalledWith("使用 {{Mixed 2}} 收尾");
  });

  it("upgrades a loaded Mixed placeholder to a chip when references arrive", () => {
    const { container, rerender } = render(
      <PromptMentionEditor
        value="使用 {{Mixed 2}}"
        onChange={() => {}}
        candidates={[]}
      />,
    );
    expect(container.querySelector(".mention-chip")).toBeNull();

    rerender(
      <PromptMentionEditor
        value="使用 {{Mixed 2}}"
        onChange={() => {}}
        candidates={[mixedCandidate]}
      />,
    );
    expect(container.querySelector<HTMLElement>(".mention-chip")?.dataset.token).toBe(
      "{{Mixed 2}}",
    );
  });
});
