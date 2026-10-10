import { fireEvent, render, screen, act, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MidjourneyUpscalePicker } from "@/features/canvas/ui/MidjourneyUpscalePicker";

const candidates = [
  { index: 1 as const, label: "U1" as const, customId: "one" },
  { index: 2 as const, label: "U2" as const, customId: "two" },
];

describe("MidjourneyUpscalePicker", () => {
  it("hides each quadrant's controls by default and reveals them only for hover, keyboard or touch", () => {
    const onAction = vi.fn();
    render(
      <MidjourneyUpscalePicker
        candidates={candidates}
        results={{}}
        onAction={onAction}
        costLabel="3"
      />,
    );
    const first = screen.getByRole("group", { name: "U1" });
    const second = screen.getByRole("group", { name: "U2" });
    const controls = within(first).getByRole("button", {
      name: "放大 U1",
    }).parentElement;
    expect(first).toHaveClass("group/candidate");
    expect(controls).toHaveClass(
      "opacity-0",
      "pointer-events-none",
      "group-hover/candidate:opacity-100",
      "group-hover/candidate:pointer-events-auto",
      "group-has-[:focus-visible]/candidate:opacity-100",
      "group-data-[touch-active=true]/candidate:opacity-100",
    );
    expect(within(first).getByLabelText("预计积分：3")).toHaveTextContent("3");
    expect(
      within(first)
        .getByLabelText("预计积分：3")
        .querySelector("svg linearGradient"),
    ).toBeInTheDocument();
    expect(
      within(first).getByRole("button", { name: "放大 U1" }),
    ).toHaveTextContent(/^放大$/);
    const touch = new Event("pointerdown", { bubbles: true });
    Object.defineProperty(touch, "pointerType", { value: "touch" });
    fireEvent(within(first).getByRole("button", { name: "选择 U1" }), touch);
    expect(first).toHaveAttribute("data-touch-active", "true");
    expect(second).toHaveAttribute("data-touch-active", "false");
    fireEvent.blur(first, { relatedTarget: document.body });
    expect(first).toHaveAttribute("data-touch-active", "false");
    expect(onAction).not.toHaveBeenCalled();
  });
  it("shows the upscale quote and allows cached viewing when billing is unavailable", () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <MidjourneyUpscalePicker
        candidates={candidates}
        results={{}}
        onAction={onAction}
        costLabel="3"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "选择 U1" }));
    expect(
      within(screen.getByRole("group", { name: "U1" })).getByLabelText(
        "预计积分：3",
      ),
    ).toBeInTheDocument();
    rerender(
      <MidjourneyUpscalePicker
        candidates={candidates}
        results={{}}
        onAction={onAction}
        billingUnavailable
      />,
    );
    expect(screen.getByRole("button", { name: "放大 U1" })).toBeDisabled();
    rerender(
      <MidjourneyUpscalePicker
        candidates={candidates}
        results={{ one: "/cached.png" }}
        onAction={onAction}
        billingUnavailable
      />,
    );
    expect(
      screen.getByRole("button", { name: "查看 U1 高清图" }),
    ).not.toBeDisabled();
  });
  it("places actions in their own quadrants and never submits on image gestures", () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <MidjourneyUpscalePicker
        candidates={candidates}
        results={{}}
        onAction={onAction}
      />,
    );
    expect(
      within(screen.getByRole("group", { name: "U1" })).getByRole("button", {
        name: "放大 U1",
      }),
    ).toBeEnabled();
    expect(
      within(screen.getByRole("group", { name: "U2" })).getByRole("button", {
        name: "放大 U2",
      }),
    ).toBeEnabled();
    const first = screen.getByRole("button", { name: "选择 U1" });
    fireEvent.pointerDown(first, { clientX: 1, clientY: 1 });
    fireEvent.pointerMove(first, { clientX: 80, clientY: 80 });
    fireEvent.pointerUp(first);
    fireEvent.click(first);
    fireEvent.doubleClick(first);
    expect(onAction).not.toHaveBeenCalled();
    expect(first).toHaveAttribute("aria-pressed", "true");
    // No preliminary selection is required to press the explicit U2 button.
    fireEvent.click(screen.getByRole("button", { name: "放大 U2" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("two");
  });

  it("offers viewing the cached result instead of requesting another upscale", () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    render(
      <MidjourneyUpscalePicker
        candidates={candidates}
        results={{ one: "/cached.png" }}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "选择 U1" }));
    expect(
      screen.getByRole("button", { name: "查看 U1 高清图" }),
    ).toHaveAttribute("title", "已有高清图，不重复扣费");
    expect(screen.queryByLabelText("预计积分：3")).not.toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "查看 U1 高清图" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("one");
  });

  it("blocks double-click confirmation and repeated submissions while pending", async () => {
    let resolve!: () => void;
    const onAction = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    render(
      <MidjourneyUpscalePicker
        candidates={candidates}
        results={{}}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "选择 U1" }));
    const confirm = screen.getByRole("button", { name: "放大 U1" });
    fireEvent.click(confirm, { detail: 2 });
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(confirm, { detail: 1 });
    fireEvent.click(confirm);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(confirm).toBeDisabled();
    await act(async () => resolve());
    expect(confirm).not.toBeDisabled();
  });
});
