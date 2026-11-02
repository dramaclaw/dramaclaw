import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromptMentionEditor, type PromptMentionEditorHandle } from "@/features/canvas/nodes/PromptMentionEditor";

describe("prompt inspection during generation", () => {
  it("keeps the same editor while preventing edits, then restores editing", () => {
    const onChange = vi.fn();
    const ref = createRef<PromptMentionEditorHandle>();
    const props = { value: "主角即将看消息", candidates: [], onChange, ref };
    const { rerender } = render(<PromptMentionEditor {...props} readOnly />);
    const editor = screen.getByRole("textbox");
    expect(editor.getAttribute("contenteditable")).toBe("false");
    expect(editor.getAttribute("aria-readonly")).toBe("true");
    expect(editor.textContent).toBe(props.value);
    act(() => ref.current?.insertTextAtCursor("不应插入"));
    fireEvent.input(editor);
    fireEvent.compositionEnd(editor);
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.textContent).toBe(props.value);
    rerender(<PromptMentionEditor {...props} readOnly={false} />);
    expect(screen.getByRole("textbox")).toBe(editor);
    expect(editor.getAttribute("contenteditable")).toBe("true");
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    act(() => ref.current?.insertTextAtCursor("，手机震动"));
    expect(onChange).toHaveBeenCalledWith("主角即将看消息，手机震动");
  });
});
