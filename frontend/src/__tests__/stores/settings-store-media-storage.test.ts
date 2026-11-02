// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_MEDIA_STORAGE_SETTINGS, useSettingsStore } from "@/stores/settingsStore";

describe("media storage credential persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({ mediaStorage: structuredClone(DEFAULT_MEDIA_STORAGE_SETTINGS) });
  });

  it("keeps all provider credential drafts in memory, not localStorage", () => {
    const store = useSettingsStore.getState();
    store.updateAliyunOssStorageConfig({ accessKeyId: "oss-draft-key", accessKeySecret: "oss-draft-secret" });
    store.updateCloudinaryStorageConfig({ apiKey: "cloud-draft-key", apiSecret: "cloud-draft-secret" });
    store.updateS3StorageConfig({
      endpoint: "http://localhost:9000", bucket: "media", region: "us-east-1", pathStyle: true,
      accessKeyId: "s3-draft-key", accessKeySecret: "s3-draft-secret",
    });
    const saved = localStorage.getItem("settings-storage")!;
    expect(saved).not.toContain("draft-key");
    expect(saved).not.toContain("draft-secret");
    expect(JSON.parse(saved).state.mediaStorage.s3).toMatchObject({
      endpoint: "http://localhost:9000", pathStyle: true, accessKeyId: "", accessKeySecret: "",
    });
    expect(useSettingsStore.getState().mediaStorage.s3.accessKeySecret).toBe("s3-draft-secret");
  });

  it.each([{}, { apiKeys: { ppio: "other-existing-key" } }])(
    "removes legacy stored credentials during migration without losing connection settings (%j)",
    async (otherSettings) => {
      const legacy = structuredClone(DEFAULT_MEDIA_STORAGE_SETTINGS);
      legacy.aliyunOss = { ...legacy.aliyunOss, bucket: "old-bucket", accessKeyId: "legacy-key", accessKeySecret: "legacy-secret" };
      legacy.cloudinary = { ...legacy.cloudinary, cloudName: "demo", apiKey: "legacy-cloud-key", apiSecret: "legacy-cloud-secret" };
      const { s3: _s3, ...oldProviders } = legacy;
      localStorage.setItem("settings-storage", JSON.stringify({
        version: 18, state: { ...otherSettings, mediaStorage: oldProviders },
      }));
      await useSettingsStore.persist.rehydrate();
      const current = useSettingsStore.getState().mediaStorage;
      expect(current.aliyunOss.bucket).toBe("old-bucket");
      expect(current.aliyunOss.accessKeySecret).toBe("");
      expect(current.aliyunOss.accessKeyId).toBe("");
      expect(current.cloudinary.cloudName).toBe("demo");
      expect(current.cloudinary.apiKey).toBe("");
      expect(current.cloudinary.apiSecret).toBe("");
      expect(current.s3).toEqual(DEFAULT_MEDIA_STORAGE_SETTINGS.s3);
      expect(localStorage.getItem("settings-storage")).not.toContain("legacy-");
    },
  );
});
