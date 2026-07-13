// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AssetHeaderActionsSlotProvider,
  AssetHeaderActionsTarget,
} from "@/components/assets/asset-header-actions-slot";
import { PropsPanel } from "@/components/assets/props-panel";

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

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({
    data: { ok: true, data: { display: "12 credits", cost: 12 } },
  }),
}));

vi.mock("@/lib/queries/character-image-selection", () => ({
  useAssetImageSourceSelection: () => ({
    data: {
      ok: true,
      data: {
        asset_kind: "prop",
        image_source_selection: "newapi_gpt_image2",
        options: { newapi_gpt_image2: "DC-Image-2" },
      },
    },
    isLoading: false,
    isFetching: false,
  }),
  useUpdateAssetImageSourceSelection: mutation,
}));

vi.mock("@/lib/queries/props", () => ({
  useProps: () => ({
    isLoading: false,
    data: {
      ok: true,
      data: [
        {
          name: "Moon Fan",
          aliases: [],
          prop_type: "object",
          visual_prompt: "silver fan",
          description: "folded silver fan",
          owner: "",
          notes: "",
          reference_url: "",
        },
      ],
    },
    refetch: vi.fn(),
  }),
  useCreateProp: mutation,
  useUpdateProp: mutation,
  useDeleteProp: mutation,
  useGeneratePropReferenceAsync: mutation,
  useUploadPropReference: mutation,
  useBatchGeneratePropReferences: mutation,
}));

vi.mock("@/lib/queries/asset-references", () => ({
  useAssetReferenceIndex: () => ({
    countFor: () => 0,
    referencesFor: () => [],
  }),
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

vi.mock("@/hooks/use-asset-focus", () => ({
  useAssetFocus: () => ({ current: null }),
}));

vi.mock("@/features/freezone/openPresetProjection", () => ({
  openPropFreezoneCanvas: vi.fn(),
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
          common: {
            refresh: "Refresh",
            refreshed: "Refreshed",
            save: "Save",
            cancel: "Cancel",
          },
          assets: {
            common: {
              edit: "Edit",
              delete: "Delete",
              generated: "generated",
              missing: "missing",
              copyLink: "Copy link",
            },
            props: {
              batchGenerate: "Batch generate refs",
              batchStatusTitle: "Batch reference generation",
              newProp: "New prop",
              newPropHint: "Create a prop.",
              editProp: "Edit prop",
              emptyTitle: "No props yet",
              emptyDescription: "Create a prop.",
              reference: "Reference",
              noReference: "Reference image missing",
              noDescription: "No description",
              generateReference: "Generate reference",
              regenerateReference: "Regenerate reference",
              generatingReference: "Generating...",
              uploadReference: "Upload reference",
              uploadingReference: "Uploading...",
              openFreezone: "Open Freezone",
              openFreezoneTip: "Open Freezone",
              owner: "Owner",
              types: { object: "Object" },
              fields: {
                name: "Prop name",
                type: "Prop type",
                owner: "Owner",
                visualPrompt: "Visual prompt",
              },
            },
          },
        },
      },
    },
  });
});

function classNameContains(container: HTMLElement, token: string) {
  return Array.from(container.querySelectorAll("*")).some((node) =>
    String(node.getAttribute("class") ?? "").includes(token),
  );
}

function renderPanel() {
  return render(
    <I18nextProvider i18n={i18n}>
      <AssetHeaderActionsSlotProvider>
        <AssetHeaderActionsTarget />
        <PropsPanel project="demo" />
      </AssetHeaderActionsSlotProvider>
    </I18nextProvider>,
  );
}

describe("PropsPanel CE generation credit gating", () => {
  beforeEach(() => {
    runtimeState.isCeRuntime = true;
    toastErrorMock.mockClear();
  });

  it("hides single and batch prop reference costs without credit styling or credit errors", async () => {
    const { container } = renderPanel();

    expect(await screen.findByText("Moon Fan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Batch generate refs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate reference" })).toBeInTheDocument();

    expect(screen.queryByText("12 credits")).not.toBeInTheDocument();
    expect(classNameContains(container, "#007A87")).toBe(false);
    expect(toastErrorMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/积分不足|credit|insufficient/i),
    );
  });
});
