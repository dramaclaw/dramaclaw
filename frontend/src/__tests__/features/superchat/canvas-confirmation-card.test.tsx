import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasConfirmationCard } from "@/features/superchat/canvas-confirmation-card";
import type { CanvasConfirmation } from "@/features/superchat/canvas-confirmations";

const confirmation: CanvasConfirmation = {
  id: "cc_00000000000000000000000000000001",
  agent_id: "main",
  turn_id: "turn-1",
  kinds: ["delete_nodes", "paid_generation"],
  targets: [
    { node_id: "n1", title: "开场图", node_type: "imageGenNode", action: "delete_nodes" },
    { node_id: "n2", title: "", node_type: "videoNode", action: "generate_video" },
  ],
  command_hash: "abc",
  created_at: 1000,
  expires_at: 2800,
};

function card(props: Partial<Parameters<typeof CanvasConfirmationCard>[0]> = {}) {
  return <CanvasConfirmationCard confirmation={confirmation} nowMs={1_000_000}
    busy={false} onDecide={vi.fn()} {...props} />;
}

describe("CanvasConfirmationCard", () => {
  it("shows the server targets, kinds, credits warning and expiry in seconds", () => {
    const { container } = render(card());
    expect(screen.getByText("删除节点、运行生成")).toBeInTheDocument();
    expect(screen.getByText("开场图 · imageGenNode")).toBeInTheDocument();
    expect(screen.getByText("n2 · videoNode")).toBeInTheDocument();
    expect(screen.getByText("确认后会消耗积分。")).toBeInTheDocument();
    expect(screen.getByText("30 分钟内有效")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\d\s*积分|积分\s*\d/);
  });

  it.each([
    { label: "single quote", credits: 30, items: [
      { node_id: "n2", action: "generate_video", status: "known", credits: 30 },
    ] },
    { label: "multi-item quote", credits: 150, items: [
      { node_id: "n1", action: "generate_image", status: "known", credits: 30 },
      { node_id: "n2", action: "generate_video", status: "known", credits: 120 },
    ] },
  ] as const)("shows the quoted total for a $label", ({ credits, items }) => {
    const quoted = {
      ...confirmation,
      price: {
        status: "known" as const,
        credits,
        items: items.map((item) => ({ ...item, display: String(item.credits) })),
      },
    };
    render(card({ confirmation: quoted }));
    expect(screen.getByText(`确认后会消耗 ${credits} 积分。`)).toBeInTheDocument();
    expect(screen.queryByText("确认后会消耗积分。")).not.toBeInTheDocument();
  });

  it.each([
    { label: "unknown quote", price: { status: "unknown", known_credits: 30 } },
    { label: "unmetered quote", price: { status: "not_metered" } },
    { label: "missing quote" },
    { label: "zero credits", price: { status: "known", credits: 0 } },
    { label: "negative credits", price: { status: "known", credits: -1 } },
    { label: "infinite credits", price: { status: "known", credits: Infinity } },
    { label: "NaN credits", price: { status: "known", credits: NaN } },
  ] as const)("keeps the generic warning for $label", ({ label: _label, ...quote }) => {
    const { container } = render(card({ confirmation: { ...confirmation, ...quote } }));
    expect(screen.getByText("确认后会消耗积分。")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\d\s*积分|积分\s*\d/);
  });

  it("omits the credits line for deletion with a stray price", () => {
    const deletion = {
      ...confirmation,
      kinds: ["delete_nodes"] satisfies CanvasConfirmation["kinds"],
      targets: [confirmation.targets[0]],
      price: { status: "known" as const, credits: 30 },
    };
    render(card({ confirmation: deletion }));
    expect(screen.queryByText(/积分/)).not.toBeInTheDocument();
  });

  it("submits the selected decision", () => {
    const onDecide = vi.fn();
    render(card({ onDecide }));
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(onDecide).toHaveBeenLastCalledWith("confirmed");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onDecide).toHaveBeenLastCalledWith("refused");
  });

  it("omits the credits warning for deletion alone", () => {
    render(card({ confirmation: { ...confirmation, kinds: ["delete_nodes"] } }));
    expect(screen.queryByText("确认后会消耗积分。")).not.toBeInTheDocument();
  });

  it("disables both decisions while busy", () => {
    render(card({ busy: true }));
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  });

  it("shows the error verbatim", () => {
    render(card({ error: "需要打开画布才能运行" }));
    expect(screen.getByText("需要打开画布才能运行")).toBeInTheDocument();
  });

  it("rounds remaining minutes up and shows at least one minute using the supplied clock", () => {
    const { rerender } = render(card({ nowMs: 2_739_999 }));
    expect(screen.getByText("2 分钟内有效")).toBeInTheDocument();
    rerender(card({ nowMs: 2_800_000 }));
    expect(screen.getByText("1 分钟内有效")).toBeInTheDocument();
  });
});
