// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 这里取的是 i18next 默认实例（`@/i18n` 初始化的就是它）。不 import `@/i18n`
// 本身，是因为那个模块会顺带拉进 react-i18next / HttpBackend，把它塞进这条被
// 到处 import 的底层链路上，会让所有 mock 掉 react-i18next 的测试在 import 期炸掉。
import i18n from "i18next";
import { saveBeatDirectorControlFrame } from "@/api/viewerManifests";
import type { PushResult, PushTarget } from "@/api/push";

type DirectorRenderTarget = Extract<PushTarget, { kind: "director_render" }>;

export interface DirectorRenderCanvasCommitSource {
  sourceUrl: string;
  previewUrl?: string | null;
  bundle?: Record<string, unknown> | null;
  sourceNodeId?: string | null;
  label?: string | null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

async function fetchJsonRecord(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(i18n.t("freezone.directorCommit.metaFetchFailed", { status: response.status }));
  }
  const json = await response.json();
  const record = recordValue(json);
  if (!record) {
    throw new Error(i18n.t("freezone.directorCommit.metaInvalid"));
  }
  return record;
}

async function urlToPngDataUrl(url: string): Promise<string> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(i18n.t("freezone.directorCommit.layerFetchFailed", { status: response.status }));
  }
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (result.startsWith("data:image/")) {
        resolve(result);
      } else if (result.startsWith("data:")) {
        const commaIndex = result.indexOf(",");
        resolve(commaIndex >= 0
          ? `data:image/png;base64,${result.slice(commaIndex + 1)}`
          : result);
      } else {
        reject(new Error(i18n.t("freezone.directorCommit.layerNotImage")));
      }
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error(i18n.t("freezone.directorCommit.layerReadFailed")));
    reader.readAsDataURL(blob);
  });
}

function completeBundleParts(bundle: Record<string, unknown> | null | undefined) {
  const relPaths = recordValue(bundle?.rel_paths);
  const urls = recordValue(bundle?.urls);
  const combinedUrl = stringValue(urls?.combined);
  const envOnlyUrl = stringValue(urls?.env_only);
  const frameMetaUrl = stringValue(urls?.frame_meta);
  if (!combinedUrl || !envOnlyUrl || !frameMetaUrl) {
    return null;
  }
  return {
    combinedRelPath: stringValue(relPaths?.combined),
    combinedUrl,
    envOnlyUrl,
    frameMetaUrl,
  };
}

function manualFrameMeta(source: DirectorRenderCanvasCommitSource): Record<string, unknown> {
  const sourceId = source.sourceNodeId
    ? `manual_canvas_commit:${source.sourceNodeId}`
    : "manual_canvas_commit";
  return {
    schema_version: "director_frame_meta_v1",
    source: {
      source_id: sourceId,
      source_type: "sog",
      source_kind: "custom",
      // 写进 frame_meta 的规范来源名，跨语言要保持一致，所以不跟界面语言走。
      label: source.label || "画布手动提交", // i18n-exempt
      url: source.sourceUrl,
    },
    camera: {
      mode: "sog",
      frame_aspect: "16:9",
      state: {},
    },
    layer: {
      source_id: sourceId,
      actors: [],
      props: [],
      stagings: [],
    },
    commit_source: "manual_canvas_commit",
  };
}

export async function commitDirectorRenderFromCanvasSource(
  project: string,
  target: DirectorRenderTarget,
  source: DirectorRenderCanvasCommitSource,
): Promise<PushResult> {
  const bundle = recordValue(source.bundle);
  const parts = completeBundleParts(bundle);
  const frameMetaRecord: Record<string, unknown> = parts
    ? recordValue(bundle?.frame_meta) ?? await fetchJsonRecord(parts.frameMetaUrl)
    : manualFrameMeta(source);
  const combinedDataUrl = parts
    ? await urlToPngDataUrl(parts.combinedUrl)
    : await urlToPngDataUrl(source.sourceUrl);
  const envOnlyDataUrl = parts
    ? await urlToPngDataUrl(parts.envOnlyUrl)
    : combinedDataUrl;

  const result = await saveBeatDirectorControlFrame(project, target.episode, target.beat, {
    frame_aspect: stringValue(frameMetaRecord.frame_aspect) ||
      stringValue(recordValue(frameMetaRecord.camera)?.frame_aspect) ||
      "16:9",
    source: recordValue(frameMetaRecord.source) ?? recordValue(bundle?.source) ?? undefined,
    frame_meta: frameMetaRecord,
    images: {
      combined: combinedDataUrl,
      env_only: envOnlyDataUrl,
    },
  });

  const targetPath = stringValue(result.rel_paths.combined) || parts?.combinedRelPath || "";
  const targetUrl = stringValue(result.urls?.combined);
  if (!targetPath || !targetUrl) {
    throw new Error(i18n.t("freezone.directorCommit.missingTargetPath"));
  }
  return {
    target_path: targetPath,
    target_url: targetUrl,
    backup: null,
  };
}
