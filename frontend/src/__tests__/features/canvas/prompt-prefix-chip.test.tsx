// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 智能续写把「对 X 的 00:00-00:04 片段进行续写：」渲染成输入框最前面一枚只读
// chip，而**不写进 data.prompt**。所以两条底线：序列化不能把它带出去（带出去
// 就等于混进用户正文，一个退格啃掉半句指令），退格也不能吃掉它。
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import { PromptMentionEditor } from "@/features/canvas/nodes/PromptMentionEditor";

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

const prefix = {
  text: "对 视频 (2) 的 00:00-00:04 片段进行续写：",
  thumbnailUrl: "https://example.com/poster.jpg",
};

function editorOf(container: HTMLElement): HTMLElement {
  return container.querySelector(".prompt-mention-editor") as HTMLElement;
}

describe("PromptMentionEditor — 续写前缀", () => {
  it("图片 + 文案渲染成一枚不可编辑的 chip", () => {
    const { container } = render(
      <PromptMentionEditor value="" onChange={() => {}} candidates={[]} prefix={prefix} />,
    );

    const chip = container.querySelector("[data-prompt-prefix]") as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe(prefix.text);
    expect(chip.querySelector("img")?.getAttribute("src")).toBe(prefix.thumbnailUrl);
  });

  it("没有静态缩略图时退回视频首帧 —— 视频节点的 thumbUrl 常常是空的", () => {
    const { container } = render(
      <PromptMentionEditor
        value=""
        onChange={() => {}}
        candidates={[]}
        prefix={{
          text: prefix.text,
          thumbnailUrl: null,
          videoUrl: "https://example.com/a.mp4",
        }}
      />,
    );

    const chip = container.querySelector("[data-prompt-prefix]") as HTMLElement;
    expect(chip.querySelector("img")).toBeNull();
    const video = chip.querySelector("video");
    expect(video?.getAttribute("src")).toBe("https://example.com/a.mp4");
    expect(video?.getAttribute("preload")).toBe("metadata");
  });

  it("前缀不参与序列化 —— 它不是用户写的内容", () => {
    const onChange = vi.fn();
    const { container } = render(
      <PromptMentionEditor
        value="继续往下演"
        onChange={onChange}
        candidates={[]}
        prefix={prefix}
      />,
    );

    // 序列化结果与 value 一致 → 不冒 onChange。前缀一旦被读回去，这里就会收到
    // 「对 视频 (2) 的…继续往下演」，指令当场混进用户正文。
    fireEvent.input(editorOf(container));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("光标贴着前缀时退格不生效，删不掉指令", () => {
    const onChange = vi.fn();
    const { container } = render(
      <PromptMentionEditor value="" onChange={onChange} candidates={[]} prefix={prefix} />,
    );

    const editor = editorOf(container);
    const chip = container.querySelector("[data-prompt-prefix]") as HTMLElement;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStartAfter(chip);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector("[data-prompt-prefix]")).toBeTruthy();
  });

  it("有前缀时占位符改挂 ::after，靠 data 属性驱动", () => {
    const { container, rerender } = render(
      <PromptMentionEditor
        value=""
        onChange={() => {}}
        candidates={[]}
        prefix={prefix}
        placeholder="请输入需要续写的内容"
      />,
    );

    // :empty 已经被 chip 破坏，::before 那条规则失效，改由这个属性喂 ::after。
    expect(editorOf(container).dataset.prefixPlaceholder).toBe("请输入需要续写的内容");

    rerender(
      <PromptMentionEditor
        value="继续"
        onChange={() => {}}
        candidates={[]}
        prefix={prefix}
        placeholder="请输入需要续写的内容"
      />,
    );
    expect(editorOf(container).dataset.prefixPlaceholder).toBe("");
  });

  it("给了 onPrefixRemove 才挂删除按钮，点它把前缀交回上层处理", () => {
    const onPrefixRemove = vi.fn();
    const { container } = render(
      <PromptMentionEditor
        value=""
        onChange={() => {}}
        candidates={[]}
        prefix={prefix}
        onPrefixRemove={onPrefixRemove}
      />,
    );

    const remove = container.querySelector("[data-prompt-prefix-remove]") as HTMLElement;
    expect(remove).toBeTruthy();
    expect(remove.getAttribute("aria-label")).toBe("删除前缀");
    // 缩略图不被顶掉，只是 hover 时用 CSS 盖住——两者共用左边这一格。
    expect(remove.parentElement?.querySelector("img")).toBeTruthy();

    fireEvent.click(remove);
    expect(onPrefixRemove).toHaveBeenCalledTimes(1);
  });

  it("不给 onPrefixRemove 就是只读前缀，没有删除按钮", () => {
    const { container } = render(
      <PromptMentionEditor value="" onChange={() => {}} candidates={[]} prefix={prefix} />,
    );
    expect(container.querySelector("[data-prompt-prefix-remove]")).toBeNull();
  });

  it("不给前缀时输入框跟以前一模一样", () => {
    const { container } = render(
      <PromptMentionEditor value="随便写点" onChange={() => {}} candidates={[]} />,
    );
    expect(container.querySelector("[data-prompt-prefix]")).toBeNull();
    expect(editorOf(container).dataset.prefixPlaceholder).toBe("");
  });
});
