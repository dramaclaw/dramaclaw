// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ComponentType } from "react";
import type { Style } from "@/types/style";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mutation = vi.hoisted(() => () => ({ mutateAsync: vi.fn(), isPending: false }));
const createStyleMock = vi.hoisted(() => vi.fn());
const PRESET_ZH_LABEL = "动漫风格";

const styleQueryState = vi.hoisted(() => ({
  detail: {
    id: "anime",
    name: "Anime",
    label: "动漫风格",
    type: "preset",
    style_instructions: "clean cel shading",
    avoid_instructions: "photoreal skin",
    style_tag: "anime",
  } as Style,
}));

vi.mock("@/lib/runtime-config", () => ({ isCeRuntime: () => false }));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useParams: () => ({ project: "demo" }),
  }),
}));

vi.mock("@/lib/queries/styles", () => ({
  useStyles: () => ({
    isLoading: false,
    isRefetching: false,
    refetch: vi.fn(),
    data: { ok: true, data: [styleQueryState.detail] },
  }),
  useStyleDetail: () => ({ isFetching: false, data: { ok: true, data: styleQueryState.detail } }),
  useCreateStyle: () => ({ mutateAsync: createStyleMock, isPending: false }),
  useDeleteStyle: mutation,
  useAnalyzeStyle: mutation,
  useUploadStylePreview: mutation,
}));

vi.mock("@/lib/queries/projects", () => ({
  useProject: () => ({ data: { ok: true, data: { visual_style: "anime" } } }),
  useUpdateProject: mutation,
}));

import { Route } from "@/routes/_app/projects.$project/styles";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: {
      en: {
        translation: {
          ingest: { visualStyles: { anime: "Anime Style" } },
          common: { refresh: "Refresh", loading: "Loading", save: "Save", cancel: "Cancel" },
          styles: {
            labelField: "UI Label",
            labelPlaceholder: "e.g. Anime Style",
            styleDirective: "Style directive",
            avoidDirective: "Avoid directive",
            projectStyleSection: "Project style config",
            save: "Save",
            preset: "Preset",
          },
        },
      },
    },
  });
});

function renderStyles() {
  const Component = Route.options.component as ComponentType;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <Component />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

async function openStyleDirective(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByText("Project style config"));
  return screen.getByLabelText("Style directive");
}

describe("built-in preset labels in the style editor", () => {
  beforeEach(() => {
    createStyleMock.mockReset();
    createStyleMock.mockResolvedValue({ ok: true, data: { id: "anime" } });
    styleQueryState.detail = {
      id: "anime",
      name: "Anime",
      label: PRESET_ZH_LABEL,
      type: "preset",
      style_instructions: "clean cel shading",
      avoid_instructions: "photoreal skin",
      style_tag: "anime",
    } as Style;
  });

  // 回归用例：内置 preset 的 label 是后端中文单语，英文界面里这个输入框原样显示
  // 「动漫风格」。左侧列表早就按 id 查 i18n 了，详情页漏了。
  it("shows the localized preset name instead of the backend Chinese label", async () => {
    renderStyles();

    const input = await screen.findByLabelText("UI Label");
    expect(input).toHaveValue("Anime Style");
    expect(screen.queryByDisplayValue(PRESET_ZH_LABEL)).not.toBeInTheDocument();
  });

  // 回归用例：显示成英文之后，如果照着输入框的值存回去，英文界面按一次保存就把
  // 项目里这条 style 的中文标签覆盖成英文，中文界面跟着变。没动过就得写回原值。
  it("saves the stored Chinese label when the user did not touch it", async () => {
    const user = userEvent.setup();
    renderStyles();

    const directive = await openStyleDirective(user);
    await user.clear(directive);
    await user.type(directive, "soft rim light");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(createStyleMock).toHaveBeenCalledTimes(1);
    const payload = createStyleMock.mock.calls[0][0] as {
      config: Record<string, unknown>;
    };
    expect(payload.config.label).toBe(PRESET_ZH_LABEL);
    expect(payload.config.style_instructions).toBe("soft rim light");
  });

  it("saves what the user typed when the label is edited", async () => {
    const user = userEvent.setup();
    renderStyles();

    const input = await screen.findByLabelText("UI Label");
    await user.clear(input);
    await user.type(input, "Cel Shaded");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(createStyleMock).toHaveBeenCalledTimes(1);
    const payload = createStyleMock.mock.calls[0][0] as {
      config: Record<string, unknown>;
    };
    expect(payload.config.label).toBe("Cel Shaded");
  });

  it("leaves a custom style's own label alone", async () => {
    styleQueryState.detail = {
      id: "my_style",
      name: "My Style",
      label: "我的风格",
      type: "custom",
      style_instructions: "hand drawn",
    } as Style;

    renderStyles();

    expect(await screen.findByLabelText("UI Label")).toHaveValue("我的风格");
  });
});
