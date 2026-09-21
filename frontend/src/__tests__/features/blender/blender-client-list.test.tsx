// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BlenderClientList } from "@/features/blender/BlenderClientList";

const listClients = vi.fn();
const revokeClient = vi.fn();
const confirmDialog = vi.fn();

vi.mock("@/features/blender/api", () => ({
  listBlenderClients: () => listClients(),
  revokeBlenderClient: (id: string) => revokeClient(id),
}));
vi.mock("@/components/confirm-dialog-host", () => ({
  confirmDialog: (options: unknown) => confirmDialog(options),
}));

describe("BlenderClientList", () => {
  beforeEach(() => {
    listClients.mockReset().mockResolvedValue([]);
    revokeClient.mockReset().mockResolvedValue(undefined);
    confirmDialog.mockReset().mockResolvedValue(true);
  });

  it("空列表时给出下载插件的去处", async () => {
    render(<BlenderClientList />);
    expect(await screen.findByText(/还没有连接过 Blender/)).toBeInTheDocument();
  });

  it("列出每台已连接的 Blender", async () => {
    listClients.mockResolvedValue([
      {
        token_id: "t1",
        label: "MacBook",
        created_at: 1700000000,
        expires_at: 1800000000,
        last_seen: null,
      },
    ]);
    render(<BlenderClientList />);
    expect(await screen.findByText("MacBook")).toBeInTheDocument();
    expect(screen.getByText(/从未使用/)).toBeInTheDocument();
  });

  it("断开要先确认——这一步不可撤销", async () => {
    listClients.mockResolvedValue([
      {
        token_id: "t1",
        label: "MacBook",
        created_at: 1700000000,
        expires_at: 1800000000,
        last_seen: null,
      },
    ]);
    render(<BlenderClientList />);
    await userEvent.click(await screen.findByRole("button", { name: "断开" }));
    expect(confirmDialog).toHaveBeenCalled();
    await waitFor(() => expect(revokeClient).toHaveBeenCalledWith("t1"));
  });

  it("确认框里点取消就什么都不做", async () => {
    confirmDialog.mockResolvedValue(false);
    listClients.mockResolvedValue([
      {
        token_id: "t1",
        label: "MacBook",
        created_at: 1700000000,
        expires_at: 1800000000,
        last_seen: null,
      },
    ]);
    render(<BlenderClientList />);
    await userEvent.click(await screen.findByRole("button", { name: "断开" }));
    await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    expect(revokeClient).not.toHaveBeenCalled();
  });
});
