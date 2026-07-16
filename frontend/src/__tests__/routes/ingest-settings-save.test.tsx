// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ReactNode } from "react";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: {
        translation: {
          common: {
            loading: "Loading",
            upload: "Upload",
            error: "Error",
            stop: "Stop",
            reupload: "Reupload",
            delete: "Delete",
          },
          ingest: {
            title: "Import Novel",
            subtitle: "Upload your novel file.",
            dropzoneHint: "Click or drop your novel file here",
            supportedFormats: "Supports .txt / .md / .docx",
            restoredFilename: "Imported novel",
            previewHeading: "Novel Structure Preview",
            inputMode: { upload: "Upload Novel", paste: "Paste Text" },
            sourceHint: {
              uploadActive: "Uploaded file active",
              pasteActive: "Pasted text active",
            },
            pastePlaceholder: "Paste novel text here",
            startIngest: "Start Import",
            processing: "Processing...",
            status: {
              uploaded: "Uploaded",
              importing: "Importing",
              completed: "Completed",
              stopped: "Stopped",
              failed: "Failed",
            },
            saveSettings: "Save Settings",
            settingsSaved: "Project settings saved",
            settingsSaveFailed: "Failed to save project settings",
            selectPlaceholder: "Select",
            projectType: "Project type",
            projectTypeLocked: "Project type is locked after import",
            projectTypes: {
              narrated: "Narrated",
              drama: "Premium drama",
            },
            firstPerson: "First person",
            thirdPerson: "Third person",
            ethnicity: "Default unspecified people",
            visualStyles: {
              chinesePeriodDrama: "Chinese period drama",
              anime: "Anime",
              guomanFantasy: "3D Xianxia Guoman",
              postApocalyptic: "Post-apocalyptic",
              realistic: "Realistic",
            },
            ethnicities: {
              chinese: "Chinese",
              japanese: "Japanese",
              korean: "Korean",
              western: "Western",
              mixed: "Mixed",
            },
          },
        },
      },
    },
  });
});

const mocks = vi.hoisted(() => ({
  projectConfig: {
    spine_template: "drama",
    visual_style: "chinese_period_drama",
    narration_style: "first_person",
    ethnicity: "Chinese",
  },
  updateProject: vi.fn(),
  uploadNovel: vi.fn(),
  startIngest: vi.fn(),
  chaptersData: undefined as
    | {
        ok: true;
        data: {
          total_chars: number;
          count: number;
          chapters: {
            number: number;
            title?: string | null;
            content?: string;
            word_count?: number;
            char_count?: number;
          }[];
        };
      }
    | undefined,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  ingestTasks: [] as { task_type: string; episode: number; status: string }[],
}));

vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  type SelectContextValue = {
    value?: string;
    onValueChange?: (value: string) => void;
  };
  const SelectContext = React.createContext<SelectContextValue>({});

  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value?: string;
      onValueChange?: (value: string) => void;
      children: ReactNode;
    }) => (
      <SelectContext.Provider value={{ value, onValueChange }}>
        <div>{children}</div>
      </SelectContext.Provider>
    ),
    SelectTrigger: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    SelectValue: ({
      children,
      placeholder,
    }: {
      children?: ((value: string) => ReactNode) | ReactNode;
      placeholder?: ReactNode;
    }) => {
      const ctx = React.useContext(SelectContext);
      if (typeof children === "function") {
        return <span>{ctx.value ? children(ctx.value) : placeholder}</span>;
      }
      return <span>{children ?? placeholder}</span>;
    },
    SelectContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children: ReactNode;
    }) => {
      const ctx = React.useContext(SelectContext);
      return (
        <button
          type="button"
          role="option"
          onClick={() => ctx.onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
  };
});

vi.mock("@/lib/queries/projects", () => ({
  useProject: () => ({
    data: { ok: true, data: mocks.projectConfig },
  }),
  useUpdateProject: () => ({
    mutateAsync: mocks.updateProject,
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/ingest", () => ({
  useChapters: () => ({ data: mocks.chaptersData, isFetching: false }),
  useUploadNovel: () => ({ mutateAsync: mocks.uploadNovel, isPending: false }),
  useStartIngest: () => ({
    mutateAsync: mocks.startIngest,
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/characters", () => ({
  useCharacters: () => ({ data: { ok: true, data: [] } }),
}));

vi.mock("@/lib/queries/tasks", () => ({
  useCancelTask: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTasks: () => ({ data: { ok: true, data: mocks.ingestTasks } }),
}));

vi.mock("@/hooks/use-task-stream", () => ({
  useTaskStream: () => ({
    status: "idle",
    progress: 0,
    currentTask: "",
    result: null,
    error: null,
    logs: [],
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

import { IngestPageContent } from "@/routes/_app/projects.$project/ingest";

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.projectConfig = {
    spine_template: "drama",
    visual_style: "chinese_period_drama",
    narration_style: "first_person",
    ethnicity: "Chinese",
  };
  mocks.updateProject.mockReset();
  mocks.updateProject.mockResolvedValue({ ok: true, data: mocks.projectConfig });
  mocks.uploadNovel.mockReset();
  mocks.startIngest.mockReset();
  mocks.chaptersData = undefined;
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.ingestTasks = [];
});

describe("IngestPage settings save", () => {
  it("advertises text, markdown and docx uploads", () => {
    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    expect(
      screen.getByText("Supports .txt / .md / .docx"),
    ).toBeInTheDocument();
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(fileInput).toHaveAttribute("accept", ".txt,.md,.docx");
  });

  it("saves project settings without uploading or starting ingest", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    const saveButton = screen.getByRole("button", { name: /save settings/i });
    expect(saveButton).toBeDisabled();

    await user.click(screen.getByRole("option", { name: "Narrated" }));
    await user.click(screen.getByRole("option", { name: "Anime" }));
    expect(saveButton).toBeEnabled();

    await user.click(saveButton);

    await waitFor(() =>
      expect(mocks.updateProject).toHaveBeenCalledWith({
        spine_template: "narrated",
        visual_style: "anime",
        narration_style: "first_person",
        ethnicity: "Chinese",
      }),
    );
    expect(mocks.uploadNovel).not.toHaveBeenCalled();
    expect(mocks.startIngest).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Project settings saved");
  });

  it("hides first/third person options for premium drama and reveals them for narrated", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    // Default config is premium drama → no narration perspective options.
    expect(
      screen.queryByRole("option", { name: "First person" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Third person" }),
    ).not.toBeInTheDocument();

    // Switching to narrated reveals the perspective entry.
    await user.click(screen.getByRole("option", { name: "Narrated" }));

    expect(
      screen.getByRole("option", { name: "First person" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Third person" }),
    ).toBeInTheDocument();
  });

  it("does not persist narration_style when saving a premium drama", async () => {
    const user = userEvent.setup();

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    // Stay on premium drama (default), only change the visual style so save fires.
    await user.click(screen.getByRole("option", { name: "Anime" }));
    await user.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalled());
    const payload = mocks.updateProject.mock.calls[0][0];
    expect(payload).not.toHaveProperty("narration_style");
    expect(payload).toMatchObject({
      spine_template: "drama",
      visual_style: "anime",
      ethnicity: "Chinese",
    });
  });

  it("hides the reupload button once chapters are imported", async () => {
    // Imported state: chapters exist, no in-session upload -> previewStatus "completed".
    mocks.chaptersData = {
      ok: true,
      data: {
        total_chars: 10,
        count: 1,
        chapters: [{ number: 1, title: "第一章", char_count: 10 }],
      },
    };

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    // The imported summary is shown (file card + preview)...
    expect(screen.getByText("第一章")).toBeInTheDocument();
    // ...but file replacement/destructive actions are gone once import succeeded.
    expect(screen.queryByRole("button", { name: "Reupload" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("falls back to chapter content title and legacy char count in preview", () => {
    mocks.chaptersData = {
      ok: true,
      data: {
        total_chars: 24,
        count: 2,
        chapters: [
          {
            number: 1,
            title: null,
            content: "第一章 启程\n秦王入宫。",
            word_count: 12,
          },
          {
            number: 2,
            title: "第二章 风起",
            char_count: 12,
          },
        ],
      },
    };

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    expect(screen.getByText("第一章 启程")).toBeInTheDocument();
    expect(screen.getByText("第二章 风起")).toBeInTheDocument();
    expect(screen.getAllByText("12").length).toBeGreaterThanOrEqual(2);
  });

  it("starts ingest with NiceGUI-compatible rebuild enabled", async () => {
    const user = userEvent.setup();
    mocks.uploadNovel.mockResolvedValue({
      ok: true,
      data: { filename: "novel.txt", size: 12 },
    });
    mocks.startIngest.mockResolvedValue({
      ok: true,
      data: { task_id: "task-1" },
    });

    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(fileInput).not.toBeNull();
    await user.upload(
      fileInput!,
      new File(["Chapter 1"], "novel.txt", { type: "text/plain" }),
    );

    await user.click(screen.getByRole("button", { name: /start import/i }));

    await waitFor(() =>
      expect(mocks.startIngest).toHaveBeenCalledWith({
        filename: "novel.txt",
        rebuild: true,
        spine_template: "drama",
      }),
    );
  });

  it("shows the backend upload error instead of a generic failure", async () => {
    const user = userEvent.setup();
    mocks.uploadNovel.mockRejectedValue(new Error("解析章节失败: 文件编码不支持"));

    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(fileInput).not.toBeNull();
    await user.upload(
      fileInput!,
      new File(["bad"], "broken.txt", { type: "text/plain" }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("解析章节失败: 文件编码不支持"),
    );
  });

  it("keeps the ingest failure detail visible on the uploaded file card", async () => {
    const user = userEvent.setup();
    mocks.uploadNovel.mockResolvedValue({
      ok: true,
      data: { filename: "novel.txt", size: 12 },
    });
    mocks.startIngest.mockRejectedValue(new Error("知识图谱构建失败: provider error"));

    const { container } = render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(fileInput).not.toBeNull();
    await user.upload(
      fileInput!,
      new File(["Chapter 1"], "novel.txt", { type: "text/plain" }),
    );

    await user.click(screen.getByRole("button", { name: /start import/i }));

    expect(
      await screen.findByText("知识图谱构建失败: provider error"),
    ).toBeInTheDocument();
    expect(mocks.toastError).toHaveBeenCalledWith("知识图谱构建失败: provider error");
  });

  it("restores the import progress view on mount when an ingest_fast task is still running", async () => {
    // Bug: navigating away mid-import and back reset the local flags, so the
    // page fell back to the empty upload zone even though the server task was
    // still running (chapters not yet durably imported). Mount reconcile must
    // re-open the progress view.
    mocks.ingestTasks = [
      { task_type: "ingest_fast", episode: 0, status: "running" },
    ];

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    // Progress view: restored file card with the "Importing" status badge.
    // (Chapters aren't durably imported yet mid-import, so the structure
    // preview section stays empty — the point is we don't fall back to the
    // upload zone.)
    expect(await screen.findByText("Importing")).toBeInTheDocument();
    expect(screen.getByText("Imported novel")).toBeInTheDocument();
    // The empty upload zone must be gone.
    expect(
      screen.queryByText("Supports .txt / .md / .docx"),
    ).not.toBeInTheDocument();
  });

  it("does not restore the import view when no ingest task is active", () => {
    mocks.ingestTasks = [
      { task_type: "ingest_fast", episode: 0, status: "completed" },
    ];

    render(
      <Wrapper>
        <IngestPageContent project="demo" />
      </Wrapper>,
    );

    // Completed (not active) → stays on the normal upload zone.
    expect(
      screen.getByText("Supports .txt / .md / .docx"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Importing")).not.toBeInTheDocument();
  });
});
