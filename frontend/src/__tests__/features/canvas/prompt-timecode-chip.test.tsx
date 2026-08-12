// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 片段重拍写进 prompt 的时间码要渲染成 chip，但序列化必须原样还原成纯文本 ——
// 一旦 chip 序列化不回去，syncReshootPrompt 的按 token 差分就会失配，删片段时
// 摘不掉对应那行。
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import {
  PromptMentionEditor,
  type MentionCandidate,
} from "@/features/canvas/nodes/PromptMentionEditor";

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

const candidates: MentionCandidate[] = [
  { key: "A", name: "视频1", imageUrl: "https://example.com/a.png", index: 1 },
];

function timecodeChips(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".mention-chip-timecode")).map(
    (chip) => (chip as HTMLElement).dataset.timecode ?? "",
  );
}

describe("PromptMentionEditor — 时间码 chip", () => {
  it("renders every timecode as a chip alongside @ mentions", () => {
    const { container } = render(
      <PromptMentionEditor
        value={"把 @视频1 中 00:24-00:29\n00:08-00:13 重拍"}
        onChange={() => {}}
        candidates={candidates}
      />,
    );

    expect(timecodeChips(container)).toEqual(["00:24-00:29", "00:08-00:13"]);
    // @ 引用还是走原来的 mention chip，两者不互相吞。
    expect(container.querySelectorAll(".mention-chip[data-mention]")).toHaveLength(1);
  });

  it("renders timecodes even with no mention candidates at all", () => {
    // 片段重拍的节点常常一个引用都还没接，这条路不能退化成纯文本。
    const { container } = render(
      <PromptMentionEditor value="00:01-00:06" onChange={() => {}} candidates={[]} />,
    );
    expect(timecodeChips(container)).toEqual(["00:01-00:06"]);
  });

  it("serializes chips back to the exact original text", () => {
    const onChange = vi.fn();
    const value = "把 @视频1 中 00:24-00:29 重拍";
    const { container } = render(
      <PromptMentionEditor
        value={value}
        onChange={onChange}
        candidates={candidates}
      />,
    );

    const editor = container.querySelector<HTMLElement>(".prompt-mention-editor");
    expect(editor).not.toBeNull();
    // 编辑器把 DOM 读回文本：chip 还原成 @视频1 / 00:24-00:29，一字不差。
    expect(editor!.textContent).toContain("00:24-00:29");
    editor!.dispatchEvent(new Event("input", { bubbles: true }));
    // 内容没变 → 不该冒出一次 onChange（否则每次外部同步都会打一次回环）。
    expect(onChange).not.toHaveBeenCalled();
  });

  it("deletes the chip with a single Backspace, like a run of text", () => {
    const onChange = vi.fn();
    const { container } = render(
      <PromptMentionEditor
        value={"镜头改成推近\n00:24-00:29\n00:08-00:13"}
        onChange={onChange}
        candidates={candidates}
      />,
    );

    const editor = container.querySelector<HTMLElement>(".prompt-mention-editor")!;
    const chip = container.querySelectorAll<HTMLElement>(".mention-chip-timecode")[0];
    // 光标停在这个 chip 正后面，就是用户按退格时的位置。
    const range = document.createRange();
    range.setStartAfter(chip);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.keyDown(editor, { key: "Backspace" });

    // 一下删干净，正文和另一段时间码都留着（chip 独占的换行留给下一次退格，
    // 与删普通文字一致）。
    expect(onChange).toHaveBeenCalledWith("镜头改成推近\n\n00:08-00:13");
    expect(timecodeChips(container)).toEqual(["00:08-00:13"]);
  });

  it("leaves an ordinary Backspace alone when the caret is not touching a chip", () => {
    const onChange = vi.fn();
    const { container } = render(
      <PromptMentionEditor
        value={"镜头改成推近\n00:24-00:29"}
        onChange={onChange}
        candidates={candidates}
      />,
    );

    const editor = container.querySelector<HTMLElement>(".prompt-mention-editor")!;
    const text = Array.from(editor.childNodes).find(
      (node): node is Text => node.nodeType === Node.TEXT_NODE,
    )!;
    const range = document.createRange();
    // 落在正文中间：这一下该由浏览器删掉一个字符，我们不许插手。
    range.setStart(text, 3);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.keyDown(editor, { key: "Backspace" });

    expect(onChange).not.toHaveBeenCalled();
    expect(timecodeChips(container)).toEqual(["00:24-00:29"]);
  });

  it("leaves numbers that are not a full timecode as plain text", () => {
    const { container } = render(
      <PromptMentionEditor
        value="第 00:24 秒开始，时长 5s"
        onChange={() => {}}
        candidates={candidates}
      />,
    );
    expect(timecodeChips(container)).toEqual([]);
  });
});
