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
