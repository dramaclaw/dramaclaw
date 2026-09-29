// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  create: vi.fn(), error: vi.fn(), navigate: vi.fn(), preview: vi.fn(),
  rename: vi.fn(), sources: vi.fn(), importCanvas: vi.fn(),
}));
vi.mock("@/lib/project-naming", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/project-naming")>(),
  previewLiblibProject: calls.preview,
  renameProject: calls.rename,
  listProjectImportSources: calls.sources,
}));
vi.mock("@/features/freezone/createProjectLiblibImport", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/features/freezone/createProjectLiblibImport")>(),
  importLiblibCanvasIntoProject: calls.importCanvas,
}));
vi.mock("@/lib/freezone-url", () => ({ buildFreezoneCanvasUrl: () => null }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => calls.navigate,
  useRouter: () => ({ invalidate: vi.fn() }),
}));
vi.mock("@/lib/queries/projects", () => ({
  useAllProjectSummaries: () => ({ data: [], isLoading: false }),
  useProjectCounts: () => ({ active: 0, archived: 0, deleted: 0 }),
  useCreateProject: () => ({ mutateAsync: calls.create, isPending: false }),
  useArchiveProject: () => ({}), useUnarchiveProject: () => ({}),
  usePurgeProject: () => ({}), useRestoreProject: () => ({}), useSoftDeleteProject: () => ({}),
}));
vi.mock("@/lib/queries/product-surfaces", () => ({
  useProductSurfaces: () => ({ data: {}, isPending: false }),
  surfaceAccess: () => ({ available: true }),
}));
vi.mock("@/components/projects/share-project-dialog", () => ({ ShareProjectDialog: () => null }));
vi.mock("sonner", () => ({ toast: { error: calls.error, success: vi.fn(), warning: vi.fn() } }));

import { Route } from "@/routes/_app/index";
import { ProjectNameDialog, type ProjectNameDialogMode } from "@/components/projects/project-name-dialog";

const shareUrl = "https://www.liblib.tv/canvas/share?spaceId=123&projectId=" + "a".repeat(32);
const originalName = "《弥寿计划》Ⅱ- 副本";

function openCreate() {
  render(createElement(Route.options.component as ComponentType));
  fireEvent.click(screen.getByRole("button", { name: /新建项目|创建项目/ }));
}

describe("create project with a Chinese display name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.create.mockImplementation(async (name: string) => ({ data: { id: "chinese-project", name } }));
    calls.preview.mockResolvedValue({ name: originalName, source_url: shareUrl });
    calls.importCanvas.mockResolvedValue({ canvasId: "imported", skippedMediaCount: 0 });
  });
  afterEach(cleanup);

  it.each(["万事屋", "中文项目_2026"])("submits %s unchanged", async (name) => {
    render(createElement(Route.options.component as ComponentType));
    fireEvent.click(screen.getByRole("button", { name: /新建项目|创建项目/ }));
    fireEvent.change(document.getElementById("project-name")!, { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(calls.create).toHaveBeenCalledExactlyOnceWith(name));
    expect(calls.error).not.toHaveBeenCalled();
  });

  it("prefills the original title before creating and importing", async () => {
    openCreate();
    fireEvent.change(document.getElementById("project-liblib-share-url")!, { target: { value: shareUrl } });
    await waitFor(() => expect(screen.getByDisplayValue(originalName)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(calls.create).toHaveBeenCalledExactlyOnceWith(originalName));
    await waitFor(() => expect(calls.importCanvas).toHaveBeenCalledOnce());
  });

  it("does not overwrite a manually entered title when a slow preview arrives", async () => {
    let finish!: (value: { name: string; source_url: string }) => void;
    calls.preview.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    openCreate();
    fireEvent.change(document.getElementById("project-liblib-share-url")!, { target: { value: shareUrl } });
    await waitFor(() => expect(calls.preview).toHaveBeenCalledOnce());
    fireEvent.change(document.getElementById("project-name")!, { target: { value: "我的中文名" } });
    finish({ name: originalName, source_url: shareUrl });
    await waitFor(() => expect(screen.getByRole("button", { name: "确认" })).toBeEnabled());
    expect(screen.getByDisplayValue("我的中文名")).toBeInTheDocument();
  });

  it("allows a manual title when reading the original fails", async () => {
    calls.preview.mockRejectedValue(new Error("offline"));
    openCreate();
    fireEvent.change(document.getElementById("project-liblib-share-url")!, { target: { value: shareUrl } });
    await screen.findByText(/无法读取原名称/);
    fireEvent.change(document.getElementById("project-name")!, { target: { value: "手动名称" } });
    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(calls.create).toHaveBeenCalledExactlyOnceWith("手动名称"));
  });
});

describe("project rename and import sources", () => {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  function open(mode: ProjectNameDialogMode) {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ProjectNameDialog project={{ id: "stable-id", name: "legacy_name", status: "active" }}
        mode={mode} onSaved={onSaved} onClose={onClose} />
    </QueryClientProvider>);
  }
  beforeEach(() => {
    vi.clearAllMocks();
    calls.sources.mockResolvedValue([{ canvasId: "one", name: originalName, url: shareUrl }]);
    calls.rename.mockResolvedValue({ data: { id: "stable-id", name: originalName } });
  });
  afterEach(cleanup);

  it("renames by stable id and exposes the saved original link", async () => {
    open("liblib");
    await screen.findByDisplayValue(originalName);
    expect(screen.getByRole("link", { name: "打开 Liblib 原项目" })).toHaveAttribute("href", shareUrl);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.rename).toHaveBeenCalledExactlyOnceWith("stable-id", originalName));
    await waitFor(() => expect(onSaved).toHaveBeenCalledExactlyOnceWith(originalName));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("requires choosing an original when the project has several imported canvases", async () => {
    calls.sources.mockResolvedValue([
      { canvasId: "one", name: "第一部", url: shareUrl },
      { canvasId: "two", name: "第二部", url: shareUrl },
    ]);
    open("liblib");
    await screen.findByText("第二部");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: "使用 Liblib 原名" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.rename).toHaveBeenCalledExactlyOnceWith("stable-id", "第二部"));
  });

  it("keeps the dialog open with a useful duplicate-name error", async () => {
    calls.rename.mockRejectedValue({ response: { status: 409 } });
    open("rename");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "已存在" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("这个项目名称已存在，请换一个名称。");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("only displays links in read-only source mode", async () => {
    open("sources");
    await screen.findByRole("link", { name: "打开 Liblib 原项目" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });
});
