// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { ConfirmDialogHost, alertDialog, confirmDialog } from "@/components/confirm-dialog-host";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

function RenameEditor({ save }: { save: (name: string) => void }) {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState("Original");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogTitle>Rename editor</DialogTitle>
        <input aria-label="Draft name" value={name} onChange={(event) => setName(event.target.value)} />
        <button onClick={async () => {
          if (await confirmDialog({ description: "Rename asset?" })) save(name);
        }}>Save draft</button>
      </DialogContent>
    </Dialog>
  );
}

describe("ConfirmDialogHost", () => {
  it("cancels a rapid retry before autofocus without closing the sibling editor", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<><RenameEditor save={save} /><ConfirmDialogHost /></>);
    const input = screen.getByRole("textbox", { name: "Draft name" });
    const submit = screen.getByRole("button", { name: "Save draft" });
    fireEvent.change(input, { target: { value: "Retained draft" } });
    await user.click(submit);
    await user.click(await screen.findByRole("button", { name: "common.cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    const focusCallbacks: FrameRequestCallback[] = [];
    const autofocus = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      focusCallbacks.push(callback);
      return focusCallbacks.length;
    });
    try {
      submit.focus();
      fireEvent.click(submit);
      expect(submit).toHaveFocus();
      fireEvent.keyDown(submit, { key: "Escape", code: "Escape" });

      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(input).toHaveValue("Retained draft");
      expect(save).not.toHaveBeenCalled();
    } finally {
      act(() => focusCallbacks.forEach((callback) => callback(performance.now())));
      autofocus.mockRestore();
      const cancel = screen.queryByRole("button", { name: "common.cancel" });
      if (cancel) await user.click(cancel);
    }
    await user.click(submit);
    await user.click(await screen.findByRole("button", { name: "common.confirm" }));
    expect(save).toHaveBeenCalledExactlyOnceWith("Retained draft");
  });

  it("ignores Escape during IME composition and leaves ordinary editor Escape unchanged", async () => {
    const user = userEvent.setup();
    render(<><RenameEditor save={vi.fn()} /><ConfirmDialogHost /></>);
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    const cancel = await screen.findByRole("button", { name: "common.cancel" });
    fireEvent.compositionStart(cancel);
    fireEvent.keyDown(cancel, { key: "Escape", isComposing: true });
    expect(screen.getByRole("alertdialog")).toBeVisible();
    fireEvent.compositionEnd(cancel);
    await user.click(cancel);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each(["confirmation", "editor"])("preserves Base UI's composition-end protection for an unflagged Escape from %s", async (target) => {
    const user = userEvent.setup();
    render(<><RenameEditor save={vi.fn()} /><ConfirmDialogHost /></>);
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    const cancel = await screen.findByRole("button", { name: "common.cancel" });
    fireEvent.compositionStart(cancel);
    vi.useFakeTimers();
    const source = target === "confirmation" ? cancel : screen.getByRole("button", { name: "Save draft", hidden: true });
    try {
      fireEvent.compositionEnd(cancel);
      const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: false });
      fireEvent(source, escape);
      expect(screen.getByRole("alertdialog")).toBeVisible();
      expect(screen.getByRole("dialog", { hidden: true })).toBeVisible();
      expect(escape.defaultPrevented).toBe(false);
      act(() => vi.runOnlyPendingTimers());
      vi.useRealTimers();
      fireEvent.keyDown(source, { key: "Escape", isComposing: false });
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.getByRole("dialog")).toBeVisible();
    } finally {
      vi.useRealTimers();
      const remaining = screen.queryByRole("button", { name: "common.cancel" });
      if (remaining) await user.click(remaining);
    }
  });

  it("stops intercepting Escape after the host unmounts", async () => {
    const view = render(<ConfirmDialogHost />);
    view.unmount();
    const settled = vi.fn();
    const pending = confirmDialog({ description: "Unmounted confirmation" });
    void pending.then(settled);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    await Promise.resolve();
    expect(escape.defaultPrevented).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    render(<ConfirmDialogHost />);
    await userEvent.click(await screen.findByRole("button", { name: "common.cancel" }));
    await expect(pending).resolves.toBe(false);
  });

  it("resolves true when the user confirms", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);

    const pending = confirmDialog({
      title: "终止任务",
      description: "终止不会退还积分",
      confirmText: "确认终止",
      cancelText: "继续执行",
    });

    await user.click(await screen.findByRole("button", { name: "确认终止" }));

    await expect(pending).resolves.toBe(true);
  });

  it("resolves false when the user cancels", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);

    const pending = confirmDialog({ description: "终止不会退还积分" });

    expect(await screen.findByText("终止不会退还积分")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "common.cancel" }));

    await expect(pending).resolves.toBe(false);
  });

  it("keeps keyboard focus in the confirmation after an ignored backdrop click", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);
    let pending!: Promise<boolean>;
    act(() => {
      pending = confirmDialog({ description: "修改名称？" });
    });
    const cancel = await screen.findByRole("button", { name: "common.cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());

    await user.click(document.querySelector('[data-slot="alert-dialog-overlay"]')!);

    expect(cancel).toHaveFocus();
    await user.keyboard("{Escape}");
    await expect(pending).resolves.toBe(false);
  });

  it("supersedes an unanswered request by resolving it as declined", async () => {
    render(<ConfirmDialogHost />);

    const first = confirmDialog({ description: "第一个请求" });
    const second = confirmDialog({ description: "第二个请求" });

    await expect(first).resolves.toBe(false);
    await waitFor(() =>
      expect(screen.getByText("第二个请求")).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "common.confirm" }));
    await expect(second).resolves.toBe(true);
  });

  it("drops the cancel button for notice-only dialogs", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);

    const pending = alertDialog({ title: "画布已达上限", description: "删掉一些再新建" });

    expect(await screen.findByText("删掉一些再新建")).toBeInTheDocument();
    // 没有第二条路可选，留个「取消」只会让人以为还能反悔。
    expect(screen.queryByRole("button", { name: "common.cancel" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "common.ok" }));

    await expect(pending).resolves.toBeUndefined();
  });

  // 回归位：确认框曾经停在 shadcn 原版的 z-50，而素材库弹窗是 z-[300]、画布书签菜单
  // 是 z-[10010]。结果是从素材库里点「删除」，确认框弹在弹窗背后——删不掉也退不出。
  // jsdom 量不了层叠顺序（Tailwind 的类没编译成 CSS），所以这里直接把类名里的 z 值
  // 抠出来跟已知最高层比大小；换算法可以，压不住整个浮层栈不行。
  it("renders above the canvas overlay stack so in-modal confirms stay reachable", async () => {
    const HIGHEST_OVERLAY_Z = 10010; // CanvasBookmarkContextMenu，全仓最高的一层

    render(<ConfirmDialogHost />);
    void confirmDialog({ description: "确定要删除「封面」？" });

    await screen.findByText("确定要删除「封面」？");

    for (const slot of ["alert-dialog-overlay", "alert-dialog-content"]) {
      const el = document.querySelector(`[data-slot="${slot}"]`);
      expect(el, `${slot} 没渲染出来`).not.toBeNull();
      const match = /z-\[(\d+)\]/.exec(el!.className);
      expect(match, `${slot} 身上没有 z-[N]，很可能被改回了 z-50`).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThan(HIGHEST_OVERLAY_Z);
    }
  });

  it("keeps confirmation dialogs vertically centered", async () => {
    render(<ConfirmDialogHost />);
    void confirmDialog({ description: "删除画布？" });

    await screen.findByText("删除画布？");
    const content = document.querySelector('[data-slot="alert-dialog-content"]');

    expect(content).toHaveClass("top-1/2", "-translate-y-1/2");
    expect(content).not.toHaveClass("top-24", "translate-y-0");
  });
});
