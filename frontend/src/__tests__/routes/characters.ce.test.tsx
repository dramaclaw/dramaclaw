// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ComponentType, ReactNode } from "react";

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeState = vi.hoisted(() => ({ isCeRuntime: true }));
const toastErrorMock = vi.hoisted(() => vi.fn());
const mutation = vi.hoisted(() => () => ({ mutateAsync: vi.fn(), isPending: false }));
const buildCharactersMutationMock = vi.hoisted(() => vi.fn());
const taskStreamOptionsMock = vi.hoisted(() => vi.fn());
const updateCharacterMutationMock = vi.hoisted(() => vi.fn());
const updateIdentityMutationMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCeRuntime,
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastErrorMock,
    success: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createLazyFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useParams: () => ({ project: "demo" }),
  }),
}));

vi.mock("@/components/episode/task-controller-provider", () => ({
  TaskControllerProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: () => ({
    started: false,
    stream: {
      status: "idle",
      progress: 0,
      currentTask: "",
      result: null,
      error: null,
    },
    logs: [],
    start: vi.fn(),
    stop: vi.fn(),
    stopping: false,
  }),
}));

vi.mock("@/hooks/use-task-stream", () => ({
  useTaskStream: (options: unknown) => {
    taskStreamOptionsMock(options);
    return {
      status: "idle",
      progress: 0,
      currentTask: "",
      result: null,
      error: null,
    };
  },
}));

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

vi.mock("@/hooks/use-assets-deep-link", () => ({
  useAssetsDeepLink: () => ({ type: null, id: null, select: vi.fn() }),
}));

vi.mock("@/lib/queries/projects", () => ({
  useProject: () => ({
    data: {
      ok: true,
      data: {
        visual_style: "ink",
        spine_template: "drama",
        narration_style: "third_person",
      },
    },
  }),
  useUpdateProject: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/queries/character-image-selection", () => ({
  useAssetImageSourceSelection: () => ({
    data: {
      ok: true,
      data: {
        asset_kind: "character",
        image_source_selection: "newapi_gpt_image2",
        options: { newapi_gpt_image2: "LingShan-G2" },
      },
    },
    isLoading: false,
    isFetching: false,
  }),
  useCharacterImageSelection: () => ({
    data: { ok: true, data: { character_image_selection: "seedream" } },
  }),
  useUpdateAssetImageSourceSelection: mutation,
  useUpdateCharacterImageSelection: mutation,
  useCharacterImageUsage: () => ({ data: { ok: true, data: {} } }),
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({
    data: { ok: true, data: { display: "12 credits", cost: 12 } },
  }),
}));

vi.mock("@/lib/queries/asset-references", () => ({
  useAssetReferences: () => ({
    referencesFor: () => [],
    coOccurrenceForScene: () => ({ identities: [], props: [] }),
    isLoading: false,
  }),
}));

vi.mock("@/lib/queries/characters", () => ({
  useCharacters: () => ({
    isLoading: false,
    data: {
      ok: true,
      data: [
        {
          name: "Li Qing",
          aliases: [],
          role: "主角",
          gender: "男",
          age_group: "middle",
          is_main: true,
          description: "Lead character",
          face_prompt: "sharp eyes",
          body_type: "slim",
          portrait_url: "",
        },
      ],
    },
  }),
  useCharacterDetails: () => ({
    isLoading: false,
    data: {
      ok: true,
      data: [
        {
          name: "Li Qing",
          aliases: [],
          role: "主角",
          gender: "男",
          age_group: "middle",
          is_main: true,
          description: "Lead character",
          face_prompt: "sharp eyes",
          body_type: "slim",
          portrait_url: "",
        },
      ],
    },
  }),
  useBuildCharacters: () => ({
    mutateAsync: buildCharactersMutationMock,
    isPending: false,
  }),
  useCreateCharacter: mutation,
  useUpdateCharacter: () => ({ mutateAsync: updateCharacterMutationMock, isPending: false }),
  useDeleteCharacter: mutation,
  useCharacterAssetHistory: () => ({ data: undefined, isLoading: false }),
  useRestoreCharacterAsset: mutation,
  useCharacterIdentities: () => ({
    data: {
      ok: true,
      data: [
        {
          identity_id: "id-middle",
          identity_name: "Middle",
          appearance_details: "green robe and clean silhouette",
          face_prompt: "sharp eyes",
          age_group: "middle",
          body_type: "slim",
          image_url: "",
          portrait_image_url: "",
          costume_image_url: "",
        },
      ],
    },
  }),
  useCreateIdentity: mutation,
  useUpdateIdentity: () => ({ mutateAsync: updateIdentityMutationMock, isPending: false }),
  useDeleteIdentity: mutation,
  useDeleteIdentityImage: mutation,
  useDeleteIdentityCostume: mutation,
  useGenerateIdentityImageAsync: mutation,
  useGenerateIdentityPortraitAsync: mutation,
  useUploadIdentityImage: mutation,
  useUploadCostumeImage: mutation,
  useUploadIdentityPortrait: mutation,
  useGeneratePortraitAsync: mutation,
  useUploadPortrait: mutation,
  useIdentityAttempts: () => ({
    data: { ok: true, data: { image_attempts: 0, portrait_attempts: 0 } },
    refetch: vi.fn(),
  }),
  useIdentityOwnerIndex: () => ({ ownerOf: () => null }),
}));

vi.mock("@/components/assets/character-voice-panel", () => ({
  CharacterVoicePanel: () => <div data-testid="character-voice-panel" />,
}));

vi.mock("@/components/assets/project-style-chip", () => ({
  ProjectStyleChip: () => <div data-testid="project-style-chip" />,
}));

vi.mock("@/components/assets/scenes-panel", () => ({
  ScenesPanel: () => <div data-testid="scenes-panel" />,
}));

vi.mock("@/components/assets/props-panel", () => ({
  PropsPanel: () => <div data-testid="props-panel" />,
}));

vi.mock("@/components/assets/narrator-voice-panel", () => ({
  NarratorVoicePanel: () => <div data-testid="narrator-voice-panel" />,
}));

import { Route } from "@/routes/_app/projects.$project/characters.lazy";
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";
import { useSaveStatusStore } from "@/stores/save-status-store";
import { enTranslation, zhTranslation } from "../helpers/i18n-fixtures";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: {
      en: {
        translation: {
          common: { novelImportRequired: "Please import a novel first" },
        },
      },
      zh: {
        translation: {
          common: { novelImportRequired: "请先导入小说" },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
});

function renderCharactersPage() {
  const Component = Route.options.component as ComponentType;
  return render(
    <I18nextProvider i18n={i18n}>
      <ConfirmDialogHost />
      <Component />
    </I18nextProvider>,
  );
}

describe("characters page CE generation credit gating", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    runtimeState.isCeRuntime = true;
    toastErrorMock.mockClear();
    buildCharactersMutationMock.mockReset();
    taskStreamOptionsMock.mockClear();
    Element.prototype.scrollTo = vi.fn();
    window.localStorage.clear();
  });

  it("hides portrait and identity generation costs and keeps credit styling out of CE dialogs", async () => {
    const user = userEvent.setup();
    renderCharactersPage();

    expect(await screen.findAllByText("Li Qing")).not.toHaveLength(0);
    expect(
      await screen.findByRole("button", {
        name: "characters.summary.generateNew",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Middle")).toBeInTheDocument();

    expect(screen.queryByText("12 credits")).not.toBeInTheDocument();

    const identityGenerate = screen
      .getAllByRole("button", { name: "characters.identities.generate" })
      .find((button) => !button.hasAttribute("disabled"));
    expect(identityGenerate).toBeDefined();
    await user.click(identityGenerate!);

    const dialog = await screen.findByRole("alertdialog");
    const dialogAction = within(dialog).getByRole("button", {
      name: "characters.identities.generate",
    });
    await waitFor(() => expect(dialogAction.closest("[role='alertdialog']")).toBeTruthy());

    expect(dialogAction).not.toHaveClass("border-[#007A87]");
    expect(dialogAction).not.toHaveClass("hover:border-[#007A87]");
    expect(dialogAction).not.toHaveClass("dark:border-[#007A87]");
    expect(identityGenerate).not.toHaveClass("pr-9");
    expect(dialogAction).not.toHaveClass("pr-9");
    expect(screen.queryByText("12 credits")).not.toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/积分不足|credit|insufficient/i),
    );
  });

  it.each([
    ["en", "Please import a novel first"],
    ["zh", "请先导入小说"],
  ])(
    "localizes the backend prerequisite error in %s without starting a missing task stream",
    async (language, expectedMessage) => {
      await i18n.changeLanguage(language);
      buildCharactersMutationMock.mockResolvedValue({
        ok: false,
        code: "NOVEL_IMPORT_REQUIRED",
        error: "请先导入小说",
      });
      const user = userEvent.setup();
      renderCharactersPage();

      await user.click(
        await screen.findByRole("button", { name: /characters\.autoExtract/ }),
      );
      const dialog = await screen.findByRole("alertdialog");
      await user.click(
        within(dialog).getByRole("button", { name: "common.confirm" }),
      );

      await waitFor(() =>
        expect(toastErrorMock).toHaveBeenCalledWith(expectedMessage),
      );
      expect(
        taskStreamOptionsMock.mock.calls.some(
          ([options]) => (options as { enabled?: boolean }).enabled === true,
        ),
      ).toBe(false);
    },
  );
});

describe("character and identity rename confirmation", () => {
  const warning = "Changing the name changes the asset ID. Existing plans, storyboards, and generated results will not migrate automatically. You may need to plan and generate again after saving. Continue?";

  beforeEach(async () => {
    i18n.addResourceBundle("en", "translation", enTranslation, true, true);
    i18n.addResourceBundle("zh", "translation", zhTranslation, true, true);
    await i18n.changeLanguage("en");
    runtimeState.isCeRuntime = true;
    window.localStorage.clear();
    Element.prototype.scrollTo = vi.fn();
    updateCharacterMutationMock.mockReset().mockResolvedValue({ ok: true });
    updateIdentityMutationMock.mockReset().mockResolvedValue({ ok: true });
    toastErrorMock.mockClear();
    useSaveStatusStore.getState().reset();
  });

  it.each(["cancel", "escape"])("keeps a character rename on %s without saving or refocusing into a loop, then allows retry", async (dismiss) => {
    const user = userEvent.setup();
    renderCharactersPage();
    const input = await screen.findByDisplayValue("Li Qing");
    const role = screen.getByDisplayValue("主角");
    await user.click(input);
    await user.clear(input);
    await user.type(input, "  Li Qing New  ");
    // Real focus movement invokes onBlur and the real host then takes focus.
    await user.tab();
    const confirmation = await screen.findByRole("alertdialog");
    expect(within(confirmation).getByText(warning)).toBeInTheDocument();
    expect(updateCharacterMutationMock).not.toHaveBeenCalled();
    expect(useSaveStatusStore.getState().scopes).toEqual({});
    await waitFor(() => expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus());
    if (dismiss === "cancel") await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    else await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(input).toHaveValue("  Li Qing New  ");
    await waitFor(() => expect(role).toHaveFocus());
    await user.click(role);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(updateCharacterMutationMock).not.toHaveBeenCalled();
    expect(useSaveStatusStore.getState().scopes).toEqual({});

    await user.click(input);
    await user.tab();
    const retry = await screen.findByRole("alertdialog");
    await user.click(within(retry).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateCharacterMutationMock).toHaveBeenCalledTimes(1));
    expect(updateCharacterMutationMock).toHaveBeenCalledWith({ name: "Li Qing New" });
  });

  it.each(["Li Qing", "  Li Qing  "])("does not warn or mutate for unchanged character name %s", async (value) => {
    const user = userEvent.setup();
    renderCharactersPage();
    const input = await screen.findByDisplayValue("Li Qing");
    await user.click(input);
    fireEvent.change(input, { target: { value } });
    await user.tab();
    expect(input).toHaveValue("Li Qing");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(updateCharacterMutationMock).not.toHaveBeenCalled();
  });

  it("saves other character fields without the rename warning", async () => {
    const user = userEvent.setup();
    renderCharactersPage();
    const description = await screen.findByDisplayValue("Lead character");
    await user.click(description);
    await user.clear(description);
    await user.type(description, "Changed description");
    await user.tab();
    await waitFor(() => expect(updateCharacterMutationMock).toHaveBeenCalledWith({ description: "Changed description" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("holds the character guard through confirmation and mutation, and releases it after failure", async () => {
    let reject!: (reason: Error) => void;
    updateCharacterMutationMock.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    renderCharactersPage();
    const input = await screen.findByDisplayValue("Li Qing");
    fireEvent.change(input, { target: { value: "New" } });
    fireEvent.blur(input);
    fireEvent.blur(input);
    const confirmation = await screen.findByRole("alertdialog");
    expect(updateCharacterMutationMock).not.toHaveBeenCalled();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateCharacterMutationMock).toHaveBeenCalledTimes(1));
    fireEvent.blur(input);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    reject(new Error("save failed"));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(input).toHaveValue("Li Qing");
    fireEvent.change(input, { target: { value: "New again" } });
    fireEvent.blur(input);
    const retry = await screen.findByRole("alertdialog");
    await userEvent.click(within(retry).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateCharacterMutationMock).toHaveBeenCalledTimes(2));
  });

  async function openIdentityRename() {
    renderCharactersPage();
    await userEvent.click(await screen.findByRole("button", { name: "Edit identity name" }));
    const form = screen.getByRole("dialog");
    return { form, input: within(form).getByRole("textbox"), save: within(form).getByRole("button", { name: "Save" }) };
  }

  it.each(["cancel", "escape"])("preserves the identity editor on %s; Enter and clicks share one guarded save", async (dismiss) => {
    const user = userEvent.setup();
    const { form, input, save } = await openIdentityRename();
    await user.clear(input);
    await user.type(input, "  New identity  ");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(save);
    const confirmation = await screen.findByRole("alertdialog");
    expect(within(confirmation).getByText(warning)).toBeInTheDocument();
    expect(updateIdentityMutationMock).not.toHaveBeenCalled();
    await waitFor(() => expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus());
    if (dismiss === "cancel") await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    else await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBe(form);
    expect(input).toHaveValue("  New identity  ");
    expect(updateIdentityMutationMock).not.toHaveBeenCalled();
    await user.click(input);
    await user.keyboard("{Enter}");
    const retry = await screen.findByRole("alertdialog");
    await user.click(within(retry).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateIdentityMutationMock).toHaveBeenCalledTimes(1));
    expect(updateIdentityMutationMock).toHaveBeenCalledWith({ identityId: "id-middle", data: { identity_name: "New identity" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each(["Middle", "  Middle  "])("does not warn or update an unchanged identity name %s", async (value) => {
    const { input, save } = await openIdentityRename();
    fireEvent.change(input, { target: { value } });
    expect(save).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(updateIdentityMutationMock).not.toHaveBeenCalled();
  });

  it("holds the identity guard through a pending mutation and unlocks after failure", async () => {
    let reject!: (reason: Error) => void;
    updateIdentityMutationMock.mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const { form, input, save } = await openIdentityRename();
    fireEvent.change(input, { target: { value: "New identity" } });
    fireEvent.click(save);
    const confirmation = await screen.findByRole("alertdialog");
    await userEvent.click(within(confirmation).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateIdentityMutationMock).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(save);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    reject(new Error("save failed"));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(screen.getByRole("dialog")).toBe(form);
    expect(input).toHaveValue("New identity");
    await userEvent.click(save);
    const retry = await screen.findByRole("alertdialog");
    await userEvent.click(within(retry).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateIdentityMutationMock).toHaveBeenCalledTimes(2));
  });

  it("uses the exact issue warning in Chinese", async () => {
    await i18n.changeLanguage("zh");
    renderCharactersPage();
    const input = await screen.findByDisplayValue("Li Qing");
    fireEvent.change(input, { target: { value: "New" } });
    fireEvent.blur(input);
    const confirmation = await screen.findByRole("alertdialog");
    expect(within(confirmation).getByText("修改名称会改变资产 ID。已有规划、分镜及生成结果不会自动迁移，保存后可能需要重新规划并生成。是否继续？")).toBeInTheDocument();
    expect(updateCharacterMutationMock).not.toHaveBeenCalled();
    await userEvent.click(within(confirmation).getByRole("button", { name: "取消" }));
  });
});
