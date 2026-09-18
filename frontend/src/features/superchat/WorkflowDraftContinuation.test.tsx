// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertWorkflowDraftCancellationMessages, latestWorkflowDraftId, workflowDraftIds, WorkflowDraftContinuation } from "./WorkflowDraftContinuation";
import type { ChatMessage } from "./types";
import translations from "../../../public/locales/zh/translation.json";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/api/client", () => ({ apiCall: api }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => {
  const name = key.split(".").pop() as keyof typeof translations.workflowDraftContinuation;
  let text: string = translations.workflowDraftContinuation[name];
  for (const [field, value] of Object.entries(values ?? {})) text = text.replace(`{{${field}}}`, String(value));
  return text;
} }) }));
const messages = (name = "dramaclaw.freezone_prepare_workflow_plan_draft", ok = true): ChatMessage[] => [{
  id: "assistant", role: "assistant", text: "草稿准备完成", timestamp: 1,
  parts: [{ id: "tool", type: "tool_status", event: { id: "tool", role: "tool", text: "", timestamp: 1,
    raw: { name, output: { content: [{ type: "text", text: JSON.stringify({ ok, status: "workflow_draft_ready", draft_id: "draft-a", revision: 1 }) }] } },
  } }],
}];
const draft = { draft_id: "draft-a", revision: 1, status: "ready", run_after_create: false, updated_at: 2,
  preview: { title: "文本→图片→音频→视频→合成", node_count: 5, edge_count: 5 } };
const props = () => ({ messages: messages(), projectId: "project-a", canvasId: "canvas-a", busy: false,
  onConfirm: vi.fn().mockResolvedValue(true), onCancelled: vi.fn() });
beforeEach(() => { api.mockReset(); api.mockResolvedValue(draft); });
afterEach(cleanup);

describe("workflow draft continuation", () => {
  it("shows the existing source image before confirmation", async () => {
    api.mockResolvedValue({...draft, preview: {...draft.preview, external_inputs: [
      {id: "cup", node_id: "red-cup-source", display_name: "红杯原图"},
    ]}});
    render(<WorkflowDraftContinuation {...props()} />);
    expect(await screen.findByText("参考图片: 红杯原图")).toBeInTheDocument();
  });
  it("recovers a qualified MCP draft result but ignores failures and unrelated tools", () => {
    expect(latestWorkflowDraftId(messages())).toBe("draft-a");
    expect(latestWorkflowDraftId(messages("freezone_prepare_workflow_draft"))).toBe("draft-a");
    expect(latestWorkflowDraftId(messages("freezone_prepare_workflow_plan_draft", false))).toBeNull();
    expect(latestWorkflowDraftId(messages("unrelated_tool"))).toBeNull();
    const previous = messages();
    const current = messages();
    current[0].id = "assistant-b";
    current[0].parts![0].event = { ...current[0].parts![0].event,
      raw: { name: "dramaclaw.freezone_prepare_workflow_plan_draft", output: {
        content: [{ type: "text", text: JSON.stringify({ ok: true, draft_id: "draft-b" }) }],
      } } };
    expect(workflowDraftIds([...previous, ...current])).toEqual(["draft-a", "draft-b"]);
    expect(latestWorkflowDraftId([...previous, ...current])).toBe("draft-b");
    expect(latestWorkflowDraftId([...previous, ...current, ...previous])).toBe("draft-a");
  });
  it("shows a real preview and confirms the exact persisted scope and revision", async () => {
    const value = props();
    render(<WorkflowDraftContinuation {...value} />);
    fireEvent.click(await screen.findByRole("button", { name: "确认创建" }));
    await waitFor(() => expect(value.onConfirm).toHaveBeenCalledOnce());
    expect(value.onConfirm.mock.calls[0][1]).toContain('"draft_id":"draft-a","revision":1');
    expect(value.onConfirm.mock.calls[0][1]).toContain('"canvas_id":"canvas-a"');
    expect(screen.queryByRole("button")).toBeNull();
    expect(api).toHaveBeenCalledTimes(2);
  });
  it("cancels the persisted draft and keeps the card hidden after remount", async () => {
    let cancelled = false;
    api.mockImplementation(async (_path: string, options?: { method?: string }) => {
      if (options?.method === "post") {
        cancelled = true;
        return { ...draft, status: "cancelled" };
      }
      return { ...draft, status: cancelled ? "cancelled" : "ready" };
    });
    const value = props();
    const view = render(<WorkflowDraftContinuation {...value} />);
    fireEvent.click(await screen.findByRole("button", { name: "取消方案" }));
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(value.onCancelled).toHaveBeenCalledWith({ draftId: "draft-a", updatedAt: 2 });
    expect(api).toHaveBeenCalledWith(
      "projects/project-a/freezone/canvases/canvas-a/workflow-drafts/draft-a/cancel",
      { method: "post", json: { expected_revision: 1 } },
    );
    expect(value.onConfirm).not.toHaveBeenCalled();
    view.unmount();
    render(<WorkflowDraftContinuation {...value} />);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("button")).toBeNull();
    expect(value.onCancelled).toHaveBeenCalledTimes(2);
  });
  it("inserts cancellation feedback by its saved time instead of appending it", () => {
    const original: ChatMessage[] = [
      { id: "before", role: "user", text: "先做一个方案", timestamp: 1000 },
      { id: "after", role: "user", text: "后续消息", timestamp: 3000 },
    ];
    const sorted = insertWorkflowDraftCancellationMessages(
      original, [
        { draftId: "draft-b", updatedAt: 2.5 },
        { draftId: "draft-a", updatedAt: 2 },
      ], "已取消工作流方案",
    );
    expect(sorted.map((message) => message.id)).toEqual([
      "before", "workflow-draft-cancelled:draft-a", "workflow-draft-cancelled:draft-b", "after",
    ]);
    expect(sorted[1]).toMatchObject({ role: "assistant", text: "已取消工作流方案" });
  });
  it("recovers every cancelled draft in chat history", async () => {
    const history = messages();
    const latest = messages();
    latest[0].id = "assistant-b";
    latest[0].parts![0].event = { ...latest[0].parts![0].event,
      raw: { name: "dramaclaw.freezone_prepare_workflow_plan_draft", output: {
        content: [{ type: "text", text: JSON.stringify({ ok: true, draft_id: "draft-b" }) }],
      } } };
    api.mockImplementation(async (path: string) => ({
      ...draft, draft_id: path.endsWith("draft-b") ? "draft-b" : "draft-a",
      status: "cancelled", updated_at: path.endsWith("draft-b") ? 3 : 2,
    }));
    const value = { ...props(), messages: [...history, ...latest] };
    render(<WorkflowDraftContinuation {...value} />);
    await waitFor(() => expect(value.onCancelled).toHaveBeenCalledTimes(2));
    expect(value.onCancelled).toHaveBeenCalledWith({ draftId: "draft-a", updatedAt: 2 });
    expect(value.onCancelled).toHaveBeenCalledWith({ draftId: "draft-b", updatedAt: 3 });
  });
  it("keeps the draft visible when cancellation fails", async () => {
    api.mockImplementation(async (_path: string, options?: { method?: string }) => {
      if (options?.method === "post") throw new Error("network failure");
      return draft;
    });
    render(<WorkflowDraftContinuation {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: "取消方案" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("未能取消方案");
    expect(screen.getByRole("button", { name: "确认创建" })).toBeInTheDocument();
  });
  it.each(["confirming", "submitted", "confirmed", "failed"])("does not offer repeat creation for %s", async (status) => {
    api.mockResolvedValue({ ...draft, status });
    render(<WorkflowDraftContinuation {...props()} />);
    await waitFor(() => expect(api).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("does not confirm a changed revision", async () => {
    api.mockResolvedValueOnce(draft).mockResolvedValue({ ...draft, revision: 2 });
    const value = props();
    render(<WorkflowDraftContinuation {...value} />);
    fireEvent.click(await screen.findByRole("button", { name: "确认创建" }));
    await screen.findByRole("alert");
    expect(value.onConfirm).not.toHaveBeenCalled();
  });
  it("keeps create-only policy and reports failed confirmation without claiming success", async () => {
    const value = props(); value.onConfirm.mockResolvedValue(false);
    render(<WorkflowDraftContinuation {...value} />);
    fireEvent.click(await screen.findByRole("button", { name: "确认创建" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(value.onConfirm.mock.calls[0][1]).not.toContain('"run_after_create":true');
  });
  it("hides the fallback while a turn is active", async () => {
    render(<WorkflowDraftContinuation {...props()} busy />);
    await waitFor(() => expect(api).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("hides the fallback when a canvas approval already exists", async () => {
    render(<WorkflowDraftContinuation {...props()} hasApproval />);
    await waitFor(() => expect(api).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("does not submit twice while confirmation is pending", async () => {
    const value = props();
    let resolve!: (sent: boolean) => void;
    value.onConfirm.mockReturnValue(new Promise<boolean>((done) => { resolve = done; }));
    render(<WorkflowDraftContinuation {...value} />);
    const button = await screen.findByRole("button", { name: "确认创建" });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(value.onConfirm).toHaveBeenCalledOnce());
    resolve(true);
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
  });
  it("does not offer confirmation for an expired draft", async () => {
    api.mockResolvedValue({ ...draft, expires_at: 1 });
    render(<WorkflowDraftContinuation {...props()} />);
    await waitFor(() => expect(api).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button")).toBeNull();
  });
});
