// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BlenderPairingPage } from "@/features/blender/BlenderPairingPage";

const approve = vi.fn();
const listClients = vi.fn();
const canGoBack = vi.fn(() => true);
const historyBack = vi.fn();
const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useCanGoBack: () => canGoBack(),
  useRouter: () => ({ history: { back: historyBack } }),
  useNavigate: () => navigate,
}));

vi.mock("@/features/blender/api", () => ({
  approveBlenderPairing: (code: string) => approve(code),
  listBlenderClients: () => listClients(),
  revokeBlenderClient: vi.fn(),
}));

describe("BlenderPairingPage", () => {
  beforeEach(() => {
    approve.mockReset().mockResolvedValue(undefined);
    listClients.mockReset().mockResolvedValue([]);
    canGoBack.mockReset().mockReturnValue(true);
    historyBack.mockReset();
    navigate.mockReset();
    window.history.replaceState({}, "", "/blender-pairing");
  });

  it("预填查询串里的配对码", async () => {
    window.history.replaceState({}, "", "/blender-pairing?code=ABCD-2345");
    render(<BlenderPairingPage />);
    await waitFor(() => {
      expect(screen.getByLabelText(/配对码/)).toHaveValue("ABCD-2345");
    });
  });

  it("没有查询串时也能手敲——未登录跳转会把码丢掉，这是唯一的补救路径", async () => {
    render(<BlenderPairingPage />);
    const input = screen.getByLabelText(/配对码/);
    expect(input).toHaveValue("");
    await userEvent.type(input, "WXYZ-6789");
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith("WXYZ-6789"));
  });

  it("成功后把码从地址栏抹掉，不留在浏览器历史里", async () => {
    window.history.replaceState({}, "", "/blender-pairing?code=ABCD-2345");
    render(<BlenderPairingPage />);
    await userEvent.click(await screen.findByRole("button", { name: "确认连接" }));
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("失败时显示后端的原话，并且不清空输入框", async () => {
    approve.mockRejectedValue(
      Object.assign(new Error("bad"), {
        response: { json: async () => ({ detail: "配对码无效或已过期" }) },
      }),
    );
    render(<BlenderPairingPage />);
    await userEvent.type(screen.getByLabelText(/配对码/), "WXYZ-6789");
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(await screen.findByText("配对码无效或已过期")).toBeInTheDocument();
    // 不清空：用户要能看见自己敲的是什么，才知道哪位敲错了。
    expect(screen.getByLabelText(/配对码/)).toHaveValue("WXYZ-6789");
  });

  it("提交中按钮禁用，防止重复提交撞上频率限制", async () => {
    let resolve: () => void = () => {};
    approve.mockReturnValue(
      new Promise<void>((r) => {
        resolve = r;
      }),
    );
    render(<BlenderPairingPage />);
    await userEvent.type(screen.getByLabelText(/配对码/), "WXYZ-6789");
    await userEvent.click(screen.getByRole("button", { name: "确认连接" }));
    expect(screen.getByRole("button", { name: "连接中…" })).toBeDisabled();
    resolve();
  });

  it("从站内点进来的，返回就退回上一页", async () => {
    render(<BlenderPairingPage />);
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(historyBack).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("从 Blender 直接打开的新标签页没有站内历史，返回就回首页", async () => {
    // 这时候 history.back() 要么没反应，要么退出站点——都不是用户想要的。
    canGoBack.mockReturnValue(false);
    render(<BlenderPairingPage />);
    await userEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
    expect(historyBack).not.toHaveBeenCalled();
  });
});
