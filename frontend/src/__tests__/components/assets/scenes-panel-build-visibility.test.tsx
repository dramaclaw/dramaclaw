// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  AssetHeaderActionsSlotProvider,
  AssetHeaderActionsTarget,
} from "@/components/assets/asset-header-actions-slot";
import { ScenesPanel } from "@/components/assets/scenes-panel";

const projectState = vi.hoisted(() => ({
  sceneBuildSupported: undefined as boolean | undefined,
}));
const mutation = vi.hoisted(() => () => ({ mutateAsync: vi.fn(), isPending: false }));
const emptyQuery = vi.hoisted(() => () => ({ data: undefined, isLoading: false }));

vi.mock("@/lib/queries/projects", () => ({
  useProject: () => ({
    data: {
      ok: true,
      data:
        projectState.sceneBuildSupported === undefined
          ? {}
          : { scene_build_supported: projectState.sceneBuildSupported },
    },
    isLoading: false,
  }),
}));

vi.mock("@/lib/queries/scenes", () => ({
  useScenes: () => ({ isLoading: false, data: { ok: true, data: [] }, refetch: vi.fn() }),
  useBuildScenes: mutation,
  useCreateScene: mutation,
  useDeleteScene: mutation,
  useDeleteSceneCustomPackage: mutation,
  useDeleteSceneMaster: mutation,
  useDeleteScenePano: mutation,
  useGenerateScene3gsPlyAsync: mutation,
  useGenerateSceneMasterAsync: mutation,
  useGenerateScenePanoAsync: mutation,
  useGenerateSceneReverseAsync: mutation,
  useClearSceneDirectorWorld: mutation,
  useSaveSceneDirectorWorld: mutation,
  useSceneDirectorStageManifest: emptyQuery,
  useScenePanoManifest: emptyQuery,
  useUpdateScene: mutation,
  useUploadSceneCustomPackage: mutation,
  useUploadSceneMaster: mutation,
  useUploadScenePano: mutation,
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({ data: { ok: true, data: { display: "12", cost: 12 } } }),
}));

vi.mock("@/lib/queries/character-image-selection", () => ({
  useAssetImageSourceSelection: () => ({ data: undefined, isLoading: false, isFetching: false }),
  useUpdateAssetImageSourceSelection: mutation,
}));

vi.mock("@/lib/queries/asset-references", () => ({
  useAssetReferenceCounts: () => ({ countFor: () => 0, isLoading: false }),
  useAssetReferences: () => ({
    referencesFor: () => [],
    coOccurrenceForScene: () => ({ identities: [], props: [] }),
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: () => ({
    started: false,
    stream: { status: "idle", progress: 0, currentTask: "", result: null, error: null },
    logs: [],
    start: vi.fn(),
    stop: vi.fn(),
    stopping: false,
  }),
}));

vi.mock("@/hooks/use-asset-focus", () => ({ useAssetFocus: () => ({ current: null }) }));
vi.mock("@/hooks/use-assets-deep-link", () => ({
  useAssetsDeepLink: () => ({}),
  useNavigateToAsset: () => vi.fn(),
}));
vi.mock("@/features/freezone/openPresetProjection", () => ({
  openPresetProjectionInMyCanvas: vi.fn(),
}));

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: {
        translation: {
          common: { refresh: "Refresh", loading: "Loading" },
          assets: {
            common: { edit: "Edit", delete: "Delete" },
            scenes: {
              newScene: "New scene",
              build: "Build scenes",
              emptyTitle: "No scenes yet",
              emptyDescription: "Build the scene catalogue.",
              emptyDescriptionPerEpisode:
                "Scenes are created automatically while planning each episode.",
            },
          },
        },
      },
    },
  });
});

function renderPanel(sceneBuildSupported: boolean | undefined) {
  projectState.sceneBuildSupported = sceneBuildSupported;
  return render(
    <I18nextProvider i18n={i18n}>
      <AssetHeaderActionsSlotProvider>
        <AssetHeaderActionsTarget />
        <ScenesPanel project="alice/demo" />
      </AssetHeaderActionsSlotProvider>
    </I18nextProvider>,
  );
}

describe("scenes panel build action", () => {
  it("hides the build button when the project cannot use it", () => {
    // Narrated structured projects build no catalogue; the button would report
    // success, produce nothing, and — because the reservation is taken at
    // enqueue — still be charged for.
    renderPanel(false);
    expect(screen.queryByText("Build scenes")).toBeNull();
    expect(
      screen.getByText("Scenes are created automatically while planning each episode."),
    ).toBeTruthy();
  });

  it("keeps the build button for projects a build works for", () => {
    renderPanel(true);
    expect(screen.getByText("Build scenes")).toBeTruthy();
    expect(screen.getByText("Build the scene catalogue.")).toBeTruthy();
  });

  it("keeps the build button when the field is absent", () => {
    // Older responses do not carry the flag; treating undefined as false would
    // hide the button for every project the moment the API lagged the client.
    renderPanel(undefined);
    expect(screen.getByText("Build scenes")).toBeTruthy();
  });
});
