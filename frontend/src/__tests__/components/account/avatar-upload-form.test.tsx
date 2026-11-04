// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarUploadForm } from "@/components/account/avatar-upload-form";

const authState = vi.hoisted(() => ({
  avatarUrl: null as string | null,
  setAvatarUrl: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector?: (s: typeof authState) => unknown) =>
    selector ? selector(authState) : authState,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

function selectFile() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], "me.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

describe("AvatarUploadForm", () => {
  beforeEach(() => {
    authState.avatarUrl = null;
    authState.setAvatarUrl.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ok: true, data: { avatar_url: "/static/avatars/u1/avatar_x.png?v=1" } }),
      })),
    );
    // jsdom lacks createObjectURL
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
  });

  it("save is disabled until a file is chosen", () => {
    render(<AvatarUploadForm avatarInitial="A" displayName="admin" onOpenChange={vi.fn()} />);
    const save = screen.getByText("header.account.avatarDialog.save").closest("button")!;
    expect(save).toBeDisabled();
  });

  it("uploads the selected file and updates the store", async () => {
    const onOpenChange = vi.fn();
    render(
      <AvatarUploadForm avatarInitial="A" displayName="admin" onOpenChange={onOpenChange} />,
    );

    selectFile();
    const save = screen.getByText("header.account.avatarDialog.save").closest("button")!;
    expect(save).not.toBeDisabled();

    fireEvent.click(save);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/v1/account/avatar",
        expect.objectContaining({ method: "POST", credentials: "include" }),
      );
    });
    expect(authState.setAvatarUrl).toHaveBeenCalledWith("/static/avatars/u1/avatar_x.png?v=1");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
