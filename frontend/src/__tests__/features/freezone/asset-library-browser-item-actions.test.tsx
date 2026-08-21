// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 侧栏「资产库」里单条素材的「…」菜单：发送到画布 / 下载 / 重命名 / 删除。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchFreezoneVideoCharacterLibrary = vi.fn();
const fetchFreezoneAssetLibraryFolders = vi.fn();
const renameFreezoneVideoCharacterLibraryItem = vi.fn();
const deleteFreezoneVideoCharacterLibraryItem = vi.fn();
const downloadUrlAsFile = vi.fn();

vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  fetchFreezoneVideoCharacterLibrary: (...args: unknown[]) =>
    fetchFreezoneVideoCharacterLibrary(...args),
  fetchFreezoneAssetLibraryFolders: (...args: unknown[]) =>
    fetchFreezoneAssetLibraryFolders(...args),
  renameFreezoneVideoCharacterLibraryItem: (...args: unknown[]) =>
    renameFreezoneVideoCharacterLibraryItem(...args),
  deleteFreezoneVideoCharacterLibraryItem: (...args: unknown[]) =>
    deleteFreezoneVideoCharacterLibraryItem(...args),
}));

vi.mock("@/lib/browserDownload", () => ({
  downloadUrlAsFile: (...args: unknown[]) => downloadUrlAsFile(...args),
}));

import { AssetLibraryBrowser } from "@/features/freezone/AssetLibraryBrowser";
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";

const UPLOADED = {
  id: "item-1",
  name: "原子朋克",
  media: "image",
  source: "upload",
  category: "other",
  folder: "other",
  image_urls: ["/static/admin/58/freezone/_uploads/atom.png"],
};

const FROM_MAINLINE = {
  id: "mainline:character:林小满",
  name: "林小满",
  media: "image",
  source: "character",
  category: "character",
  folder: "mainline",
  image_urls: ["/static/admin/58/characters/lin.png"],
};

const VOICE_ONLY = {
  id: "item-2",
  name: "苏贝音色",
  media: "audio",
  source: "upload",
  category: "audio",
  folder: "audio",
  audio_url: "/static/admin/58/freezone/_uploads/voice.mp3",
};

const VIDEO_ONLY = {
  id: "item-3",
  name: "分镜预览",
  media: "video",
  source: "upload",
  category: "other",
  folder: "other",
  video_url: "/static/admin/58/freezone/_uploads/preview.mp4",
};

function renderBrowser(onSendToCanvas?: (entry: unknown) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(
    <>
      <ConfirmDialogHost />
      <AssetLibraryBrowser project="demo" onSendToCanvas={onSendToCanvas} />
    </>,
    { wrapper },
  );
}

/** 侧栏是「先文件夹、再条目」两级，测条目得先点进去。 */
async function openFolder(label: string) {
  const folder = await screen.findByLabelText(`文件夹 ${label}`);
  fireEvent.click(folder);
}

async function openItemMenu(name: string) {
  fireEvent.click(await screen.findByLabelText(`${name} 更多操作`));
}

describe("AssetLibraryBrowser item actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([]);
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue([
      UPLOADED,
      FROM_MAINLINE,
    ]);
  });

  // 封面口径要和弹窗一致：有图就拿第一张图当封面，纯音频文件夹回退到文件夹图标。
  it("shows a cover thumbnail on folders that hold an image", async () => {
    renderBrowser(() => {});
    const folder = await screen.findByLabelText("文件夹 待分类资产");

    const cover = folder.querySelector("img");
    expect(cover).toBeTruthy();
    expect(cover?.getAttribute("src")).toContain("atom.png");
  });

  it("falls back to the folder icon when nothing inside is an image", async () => {
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue([VOICE_ONLY]);
    renderBrowser(() => {});
    const folder = await screen.findByLabelText("文件夹 音效");

    expect(folder.querySelector("img")).toBeNull();
  });

  it("does not preload metadata for every video in an opened folder", async () => {
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue([VIDEO_ONLY]);
    renderBrowser(() => {});
    await openFolder("待分类资产");

    const video = document.querySelector("video");
    expect(video).toBeTruthy();
    expect(video?.getAttribute("preload")).toBe("none");
  });

  it("offers the four actions on a locally uploaded asset", async () => {
    renderBrowser(() => {});
    await openFolder("待分类资产");
    await openItemMenu("原子朋克");

    expect(screen.getByRole("menuitem", { name: "发送到画布" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "下载" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeTruthy();
  });

  it("hides 发送到画布 when there is no canvas to send to", async () => {
    renderBrowser();
    await openFolder("待分类资产");
    await openItemMenu("原子朋克");

    expect(screen.queryByRole("menuitem", { name: "发送到画布" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "下载" })).toBeTruthy();
  });

  // 主线同步来的素材改了名/删掉都会在下次同步时被覆盖回来，所以不给这两个入口。
  it("only offers read-only actions on mainline-synced assets", async () => {
    renderBrowser(() => {});
    await openFolder("主线");
    await openItemMenu("林小满");

    expect(screen.getByRole("menuitem", { name: "发送到画布" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "下载" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "重命名" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "删除" })).toBeNull();
  });

  it("sends the clicked asset to the canvas", async () => {
    const onSend = vi.fn();
    renderBrowser(onSend);
    await openFolder("待分类资产");
    await openItemMenu("原子朋克");
    fireEvent.click(screen.getByRole("menuitem", { name: "发送到画布" }));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toMatchObject({
      id: "item-1",
      name: "原子朋克",
    });
  });

  it("downloads under the asset name plus the url's extension", async () => {
    downloadUrlAsFile.mockResolvedValue(undefined);
    renderBrowser(() => {});
    await openFolder("待分类资产");
    await openItemMenu("原子朋克");
    fireEvent.click(screen.getByRole("menuitem", { name: "下载" }));

    await waitFor(() => expect(downloadUrlAsFile).toHaveBeenCalledTimes(1));
    expect(downloadUrlAsFile.mock.calls[0][1]).toBe("原子朋克.png");
  });

  it("renames through the shared name dialog", async () => {
    renameFreezoneVideoCharacterLibraryItem.mockResolvedValue({});
    renderBrowser(() => {});
    await openFolder("待分类资产");
    await openItemMenu("原子朋克");
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));

    const input = screen.getByLabelText(/资产名称/);
    fireEvent.change(input, { target: { value: "赛博霓虹" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(renameFreezoneVideoCharacterLibraryItem).toHaveBeenCalledWith(
        "demo",
        "item-1",
        "赛博霓虹",
      ),
    );
  });

  it("confirms deletion through the styled dialog instead of window.confirm", async () => {
    deleteFreezoneVideoCharacterLibraryItem.mockResolvedValue({});
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderBrowser(() => {});
    await openFolder("待分类资产");
    await openItemMenu("原子朋克");
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));

    const dialog = await screen.findByRole("alertdialog");
    // 走原生 confirm 的话这个对话框根本不会出现，删除也早就发出去了。
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(deleteFreezoneVideoCharacterLibraryItem).not.toHaveBeenCalled();

    // 取消：按文案之外的那个按钮找，免得跟着 i18n 的「取消」文案一起碎。
    const cancel = within(dialog)
      .getAllByRole("button")
      .find((button) => button.textContent !== "删除");
    fireEvent.click(cancel as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleteFreezoneVideoCharacterLibraryItem).not.toHaveBeenCalled();

    await openItemMenu("原子朋克");
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    const retry = await screen.findByRole("alertdialog");
    fireEvent.click(within(retry).getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(deleteFreezoneVideoCharacterLibraryItem).toHaveBeenCalledWith(
        "demo",
        "item-1",
      ),
    );

    nativeConfirm.mockRestore();
  });
});
