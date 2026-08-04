// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 前端停止等待时弹的是中性提示，不是报错：没有「复制报错信息」，图标是转圈不是
// 警告。用户看到的必须是「还在生成」，否则一个仍在跑的任务会被当成失败重做一遍。
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GlobalErrorDialog } from "@/components/GlobalErrorDialog";
import { notifyTaskStillRunning } from "@/features/canvas/application/errorDialog";
import {
  subscribeOpenGlobalErrorDialog,
  type GlobalErrorDialogDetail,
} from "@/features/app/errorDialogEvents";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "errorDialog.copyReport": "复制报错信息",
        "errorDialog.technicalDetails": "技术详情",
        "errorDialog.stillRunningTitle": "仍在生成中",
        "errorDialog.stillRunningMessage": "页面已停止等待，任务仍在后台继续。",
        "common.close": "关闭",
      })[key] ?? key,
  }),
}));

const t = ((key: string) =>
  ({
    "errorDialog.stillRunningTitle": "仍在生成中",
    "errorDialog.stillRunningMessage": "页面已停止等待，任务仍在后台继续。",
  })[key] ?? key) as unknown as Parameters<typeof notifyTaskStillRunning>[0];

describe("notifyTaskStillRunning", () => {
  it("发的是 pending 变体，不带可复制的报错内容", () => {
    const seen: GlobalErrorDialogDetail[] = [];
    const unsubscribe = subscribeOpenGlobalErrorDialog((detail) => seen.push(detail));

    notifyTaskStillRunning(t);
    unsubscribe();

    expect(seen).toHaveLength(1);
    expect(seen[0].variant).toBe("pending");
    expect(seen[0].title).toBe("仍在生成中");
    expect(seen[0].copyText).toBeUndefined();
  });
});

describe("GlobalErrorDialog pending 变体", () => {
  it("即使带技术详情也不显示「复制报错信息」，并用转圈图标", () => {
    const { container } = render(
      <GlobalErrorDialog
        isOpen
        variant="pending"
        title="仍在生成中"
        message="页面已停止等待，任务仍在后台继续。"
        details="task_key=freezone_video_generate:job-1"
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText("复制报错信息")).toBeNull();
    expect(container.ownerDocument.querySelector(".animate-spin")).not.toBeNull();
  });

  it("error 变体照旧提供复制按钮", () => {
    render(
      <GlobalErrorDialog
        isOpen
        variant="error"
        title="生成失败"
        message="上游返回 500"
        details="request_id=abc"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("复制报错信息")).toBeTruthy();
  });
});
