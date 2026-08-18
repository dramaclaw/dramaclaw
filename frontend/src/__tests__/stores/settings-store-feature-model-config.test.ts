// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FEATURE_MODEL_SETTINGS,
  normalizeMediaModelEntries,
  useSettingsStore,
} from "@/stores/settingsStore";

describe("settingsStore feature model configuration", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      featureModelConfig: DEFAULT_FEATURE_MODEL_SETTINGS,
      featureModelConfigUserRevision: 0,
      featureModelConfigProfileSyncedRevision: 0,
      featureModelConfigProfileSyncPending: false,
      featureModelConfigProviderChannelsHydrationKey: "",
      comfyUIBaseUrlAutoFillDismissed: false,
    });
  });

  it("increments the user revision only for user-authored changes", () => {
    const store = useSettingsStore.getState();

    store.setEmbeddingModel(
      {
        provider: "openrouter",
        upstreamModel: "text-embedding-3-small",
        dimension: 1536,
      },
      { source: "hydrate" },
    );
    store.setMediaModels({}, { source: "profile" });
    expect(useSettingsStore.getState().featureModelConfigUserRevision).toBe(0);

    store.updateFeatureProviderChannel("openrouter", {
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(useSettingsStore.getState().featureModelConfigUserRevision).toBe(1);
    expect(
      useSettingsStore.getState().featureModelConfigProfileSyncedRevision,
    ).toBe(0);
    expect(
      useSettingsStore.getState().featureModelConfigProfileSyncPending,
    ).toBe(true);

    useSettingsStore.getState().markFeatureModelConfigProfileSynced(1);
    expect(
      useSettingsStore.getState().featureModelConfigProfileSyncedRevision,
    ).toBe(1);
    expect(
      useSettingsStore.getState().featureModelConfigProfileSyncPending,
    ).toBe(false);
  });

  it("keeps newer user edits pending when an older revision finishes syncing", () => {
    const store = useSettingsStore.getState();
    store.updateFeatureProviderChannel("openrouter", {
      baseUrl: "https://one",
    });
    store.updateFeatureProviderChannel("openrouter", {
      baseUrl: "https://two",
    });

    expect(useSettingsStore.getState().featureModelConfigUserRevision).toBe(2);
    store.markFeatureModelConfigProfileSynced(1);

    expect(
      useSettingsStore.getState().featureModelConfigProfileSyncedRevision,
    ).toBe(1);
    expect(
      useSettingsStore.getState().featureModelConfigProfileSyncPending,
    ).toBe(true);
  });

  it("records the user's ComfyUI base URL auto-fill preference", () => {
    useSettingsStore.getState().setComfyUIBaseUrlAutoFillDismissed(true);
    expect(useSettingsStore.getState().comfyUIBaseUrlAutoFillDismissed).toBe(
      true,
    );
  });

  it("records the provider-channel snapshot used for hydration", () => {
    useSettingsStore
      .getState()
      .markFeatureModelConfigProviderChannelsHydrated(
        '[{"provider":"comfyui"}]',
      );

    expect(
      useSettingsStore.getState()
        .featureModelConfigProviderChannelsHydrationKey,
    ).toBe('[{"provider":"comfyui"}]');
  });

  it("persists pending sync intent without persisting transient revisions or channels", () => {
    const store = useSettingsStore.getState();
    store.updateFeatureProviderChannel("comfyui", {
      baseUrl: "http://127.0.0.1:8188",
    });
    store.setComfyUIBaseUrlAutoFillDismissed(true);

    const partialize = useSettingsStore.persist.getOptions().partialize;
    expect(partialize).toBeTypeOf("function");
    const persisted = partialize?.(useSettingsStore.getState()) as Record<
      string,
      unknown
    >;

    expect(persisted).not.toHaveProperty("featureModelConfigUserRevision");
    expect(persisted).not.toHaveProperty(
      "featureModelConfigProfileSyncedRevision",
    );
    expect(persisted).not.toHaveProperty(
      "featureModelConfigProviderChannelsHydrationKey",
    );
    expect(persisted.featureModelConfigProfileSyncPending).toBe(true);
    expect(persisted.comfyUIBaseUrlAutoFillDismissed).toBe(true);
    expect(persisted.featureModelConfig).toMatchObject({
      providerChannels: {},
      providerKeys: {},
    });
  });

  it("normalizes backend media model snapshots before comparison", () => {
    expect(
      normalizeMediaModelEntries({
        " seedream-5.0-lite ": {
          provider: " VolcEngine ",
          upstreamModel: " doubao-seedream-5-0-lite ",
          mediaType: "image",
          label: " Seedream 5.0 Lite ",
          enabled: true,
          sortOrder: 20,
          config: {},
        },
        "empty-label": {
          provider: "openrouter",
          upstreamModel: "image-model",
          label: "   ",
        },
      }),
    ).toEqual({
      "seedream-5.0-lite": {
        provider: "volcengine",
        upstreamModel: "doubao-seedream-5-0-lite",
        mediaType: "image",
        label: "Seedream 5.0 Lite",
        enabled: true,
        sortOrder: 20,
        config: {},
      },
      "empty-label": {
        provider: "openrouter",
        upstreamModel: "image-model",
        enabled: true,
        sortOrder: 100,
        config: {},
      },
    });
  });
});
