// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ComponentType, ReactNode } from "react";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeState = vi.hoisted(() => ({ isCeRuntime: true }));
const toastErrorMock = vi.hoisted(() => vi.fn());
const mutation = vi.hoisted(() => () => ({ mutateAsync: vi.fn(), isPending: false }));

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
  useTaskStream: () => ({
    status: "idle",
    progress: 0,
    currentTask: "",
    result: null,
    error: null,
  }),
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
  useAssetReferenceIndex: () => ({
    countFor: () => 0,
    referencesFor: () => [],
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
  useBuildCharacters: mutation,
  useCreateCharacter: mutation,
  useUpdateCharacter: mutation,
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
  useUpdateIdentity: mutation,
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

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
});

function renderCharactersPage() {
  const Component = Route.options.component as ComponentType;
  return render(
    <I18nextProvider i18n={i18n}>
      <Component />
    </I18nextProvider>,
  );
}

describe("characters page CE generation credit gating", () => {
  beforeEach(() => {
    runtimeState.isCeRuntime = true;
    toastErrorMock.mockClear();
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
});
