// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { syncQuickProfileFromAdvancedSettings } from "@/components/settings/settings-dialog";
import {
  DEFAULT_FEATURE_MODEL_SETTINGS,
  normalizeMediaModelEntries,
  useSettingsStore,
} from "@/stores/settingsStore";

type QuickProfile = Parameters<typeof syncQuickProfileFromAdvancedSettings>[0];

function quickProfileFixture(): QuickProfile {
  return {
    version: 2,
    name: "Test profile",
    channels: [
      {
        id: "openrouter",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        priority: 0,
        settings: {},
      },
      {
        id: "comfyui",
        provider: "comfyui",
        type: 63,
        baseUrl: "http://127.0.0.1:8188",
        priority: 0,
        settings: {
          comfyui: {
            model_name: "MiniMax-H3-local",
            workflow_by_model: { minimax_h3_t2v: { "1": {} } },
          },
        },
      },
    ],
    featureModels: {
      text: { channel: "openrouter", model: "text-model" },
      vision: { channel: "openrouter", model: "vision-model" },
      overrides: {},
    },
    embedding: {
      channel: "openrouter",
      model: "embedding-model",
      dimension: 1024,
      batchSize: 10,
    },
    mediaModels: {
      "MiniMax-H3-local": {
        channel: "comfyui",
        model: "MiniMax-H3-local",
        mediaType: "video",
      },
    },
  };
}

describe("settingsStore feature model configuration", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      featureModelConfig: DEFAULT_FEATURE_MODEL_SETTINGS,
      featureModelConfigUserRevision: 0,
      featureModelConfigProfileSyncedRevision: 0,
      featureModelConfigProfileSyncPending: false,
      featureModelConfigBackendSnapshotKey: "",
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

  it("hydrates one authoritative backend snapshot without advancing the user revision", () => {
    useSettingsStore.getState().hydrateFeatureModelConfigFromBackend(
      {
        providerChannels: {
          openrouter: {
            provider: "openrouter",
            upstreamKey: "",
            baseUrl: "https://openrouter.ai/api/v1",
            priority: 1,
            settings: {},
          },
        },
        providerKeys: {},
        mediaModels: {
          "image-model": {
            provider: "openrouter",
            upstreamModel: "upstream-image-model",
          },
        },
        embeddingModel: {
          provider: "openrouter",
          upstreamModel: "embedding-model",
          dimension: 1024,
        },
      },
      "backend-snapshot-1",
    );

    const state = useSettingsStore.getState();
    expect(state.featureModelConfigBackendSnapshotKey).toBe(
      "backend-snapshot-1",
    );
    expect(state.featureModelConfig.providerChannels).toHaveProperty(
      "openrouter",
    );
    expect(state.featureModelConfig.mediaModels).toHaveProperty("image-model");
    expect(state.featureModelConfig.embeddingModel?.upstreamModel).toBe(
      "embedding-model",
    );
    expect(state.featureModelConfigUserRevision).toBe(0);
    expect(state.featureModelConfigProfileSyncPending).toBe(true);
  });

  it("keeps the consumed backend snapshot after a local provider deletion", () => {
    const store = useSettingsStore.getState();
    store.hydrateFeatureModelConfigFromBackend(
      {
        providerChannels: {
          openrouter: {
            provider: "openrouter",
            upstreamKey: "",
            baseUrl: "https://openrouter.ai/api/v1",
            priority: 0,
            settings: {},
          },
        },
        providerKeys: {},
        mediaModels: {},
        embeddingModel: {
          provider: "openrouter",
          upstreamModel: "embedding-model",
          dimension: 1024,
        },
      },
      "backend-snapshot-1",
    );
    useSettingsStore.getState().markFeatureModelConfigProfileSynced(0);

    useSettingsStore.getState().removeFeatureProviderChannel("openrouter");

    const state = useSettingsStore.getState();
    expect(state.featureModelConfigBackendSnapshotKey).toBe(
      "backend-snapshot-1",
    );
    expect(state.featureModelConfig.providerChannels).toEqual({});
    expect(state.featureModelConfigUserRevision).toBe(1);
    expect(state.featureModelConfigProfileSyncPending).toBe(true);
  });

  it("persists only feature mappings from the model configuration draft", () => {
    const store = useSettingsStore.getState();
    store.updateFeatureModel("feature-1", {
      provider: "openrouter",
      model: "text-model",
    });
    store.updateFeatureProviderChannel("openrouter", {
      upstreamKey: "sk-secret",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    store.setMediaModels({
      "image-model": {
        provider: "openrouter",
        upstreamModel: "upstream-image-model",
      },
    });
    store.setEmbeddingModel({
      provider: "openrouter",
      upstreamModel: "embedding-model",
      dimension: 1024,
    });

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
      "featureModelConfigBackendSnapshotKey",
    );
    expect(persisted).not.toHaveProperty(
      "featureModelConfigProfileSyncPending",
    );
    const featureModelConfig = persisted.featureModelConfig as {
      featureModels: Record<string, unknown>;
      providerChannels: Record<string, unknown>;
      providerKeys: Record<string, unknown>;
      mediaModels: Record<string, unknown>;
      embeddingModel?: unknown;
    };
    expect(featureModelConfig.featureModels).toEqual({
      "feature-1": { provider: "openrouter", model: "text-model" },
    });
    expect(featureModelConfig.providerChannels).toEqual({});
    expect(featureModelConfig.providerKeys).toEqual({});
    expect(featureModelConfig.mediaModels).toEqual({});
    expect(featureModelConfig.embeddingModel).toBeUndefined();
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

describe("custom profile reconciliation", () => {
  it("ignores orphaned media models instead of synthesizing empty channels", () => {
    const profile = syncQuickProfileFromAdvancedSettings(
      quickProfileFixture(),
      {
        ...DEFAULT_FEATURE_MODEL_SETTINGS,
        providerChannels: {
          openrouter: {
            provider: "openrouter",
            upstreamKey: "",
            baseUrl: "https://openrouter.ai/api/v1",
            priority: 0,
            settings: {},
          },
        },
        embeddingModel: {
          provider: "openrouter",
          upstreamModel: "embedding-model",
          dimension: 1024,
          batchSize: 10,
        },
        mediaModels: {
          orphaned: {
            provider: "missing-provider",
            upstreamModel: "orphaned-upstream",
          },
        },
      },
    );

    expect(profile?.channels.map((channel) => channel.provider)).toEqual([
      "openrouter",
    ]);
    expect(profile?.mediaModels).toEqual({});
  });

  it("removes a deleted provider from the reconciled profile", () => {
    const profile = syncQuickProfileFromAdvancedSettings(
      quickProfileFixture(),
      {
        ...DEFAULT_FEATURE_MODEL_SETTINGS,
        providerChannels: {
          openrouter: {
            provider: "openrouter",
            upstreamKey: "",
            baseUrl: "https://openrouter.ai/api/v1",
            priority: 0,
            settings: {},
          },
        },
        embeddingModel: {
          provider: "openrouter",
          upstreamModel: "embedding-model",
          dimension: 1024,
          batchSize: 10,
        },
      },
    );

    expect(profile?.channels).toHaveLength(1);
    expect(profile?.channels[0]?.provider).toBe("openrouter");
    expect(profile?.mediaModels).toEqual({});
  });

  it("excludes an empty ComfyUI channel without corrupting the profile", () => {
    const profile = syncQuickProfileFromAdvancedSettings(
      quickProfileFixture(),
      {
        ...DEFAULT_FEATURE_MODEL_SETTINGS,
        providerChannels: {
          openrouter: {
            provider: "openrouter",
            upstreamKey: "",
            baseUrl: "https://openrouter.ai/api/v1",
            priority: 0,
            settings: {},
          },
          comfyui: {
            provider: "comfyui",
            upstreamKey: "",
            baseUrl: "",
            priority: 0,
            settings: quickProfileFixture().channels[1]?.settings ?? {},
          },
        },
        embeddingModel: {
          provider: "openrouter",
          upstreamModel: "embedding-model",
          dimension: 1024,
          batchSize: 10,
        },
        mediaModels: {
          "MiniMax-H3-local": {
            provider: "comfyui",
            upstreamModel: "MiniMax-H3-local",
          },
        },
      },
    );

    expect(profile?.channels.map((channel) => channel.provider)).toEqual([
      "openrouter",
    ]);
    expect(profile?.mediaModels).toEqual({});
  });

  it("returns no replacement when the current draft cannot form a valid profile", () => {
    expect(
      syncQuickProfileFromAdvancedSettings(
        quickProfileFixture(),
        DEFAULT_FEATURE_MODEL_SETTINGS,
      ),
    ).toBeNull();
  });

  it("does not claim success when the backend embedding is orphaned", () => {
    expect(
      syncQuickProfileFromAdvancedSettings(quickProfileFixture(), {
        ...DEFAULT_FEATURE_MODEL_SETTINGS,
        providerChannels: {
          openrouter: {
            provider: "openrouter",
            upstreamKey: "",
            baseUrl: "https://openrouter.ai/api/v1",
            priority: 0,
            settings: {},
          },
        },
        embeddingModel: {
          provider: "removed-provider",
          upstreamModel: "embedding-model",
          dimension: 1024,
        },
      }),
    ).toBeNull();
  });
});
