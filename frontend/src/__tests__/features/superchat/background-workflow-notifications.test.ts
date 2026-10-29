import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { zhT } from "@/__tests__/helpers/i18n-fixtures";
import { useBackgroundWorkflowNotifications } from "@/features/superchat/use-background-workflow-notifications";
import type { CanvasChatCommandApplyResult } from "@/features/freezone/canvasChatCommands";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: zhT }) }));

const completed: CanvasChatCommandApplyResult = {
  applied: 1, openedUiActions: 0, createdNodeIds: [], errors: [],
  commandResults: [{ commandIndex: 0, type: "run_workflow", status: "success", label: "生成分镜" }],
};

describe("background workflow completion questions", () => {
  it("waits for the active turn and deduplicates live/recovered completion", async () => {
    const appendNotification = vi.fn().mockResolvedValue(true);
    const { result, rerender } = renderHook(({ busy }) => useBackgroundWorkflowNotifications({
      scopeKey: "project:canvas:agent", busy, appendNotification,
    }), { initialProps: { busy: true } });
    act(() => {
      result.current("run-1", completed);
      result.current("run-1", completed);
    });
    expect(appendNotification).not.toHaveBeenCalled();
    rerender({ busy: false });
    await waitFor(() => expect(appendNotification).toHaveBeenCalledTimes(1));
    expect(appendNotification).toHaveBeenCalledWith(
      "本轮后台工作流已完成。是否确认本轮结果并继续下一步？",
      "canvas-workflow-completion:project:canvas:agent:run-1",
    );
    act(() => result.current("run-1", completed));
    expect(appendNotification).toHaveBeenCalledTimes(1);
  });

  it("does not report syncing results as complete or leak a notice into another canvas", async () => {
    const appendNotification = vi.fn().mockResolvedValue(true);
    const { result, rerender } = renderHook(({ scopeKey, busy }) => useBackgroundWorkflowNotifications({
      scopeKey, busy, appendNotification,
    }), { initialProps: { scopeKey: "canvas-a", busy: true } });
    act(() => result.current("run-sync", { ...completed, commandResults: [{
      ...completed.commandResults[0], status: "pending",
      output: { reason: "workflow_result_sync_pending" },
    }] }));
    act(() => result.current("run-1", completed));
    rerender({ scopeKey: "canvas-b", busy: false });
    expect(appendNotification).not.toHaveBeenCalled();
    rerender({ scopeKey: "canvas-a", busy: false });
    await waitFor(() => expect(appendNotification).toHaveBeenCalledTimes(1));
  });

  it("asks to investigate a failure rather than confirming success", async () => {
    const appendNotification = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useBackgroundWorkflowNotifications({
      scopeKey: "canvas", busy: false, appendNotification,
    }));
    act(() => result.current("run-failed", { ...completed, errors: ["图片生成失败"] }));
    await waitFor(() => expect(appendNotification).toHaveBeenCalledWith(
      expect.stringContaining("需要我检查失败原因吗"), expect.any(String),
    ));
  });
});
