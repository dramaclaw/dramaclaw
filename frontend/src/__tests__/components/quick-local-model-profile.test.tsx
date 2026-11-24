// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { QuickLocalNewApiSetup } from "@/components/settings/settings-dialog";
import type { ModelGatewayConfig } from "@/lib/queries/model-gateway";

const key = "dramaclaw-ce-quick-model-profiles";
const stored = () => JSON.parse(localStorage.getItem(key)!);
const channel = {
  provider: "openrouter",
  configured: true,
  upstreamKeyPreview: "secret-preview",
  baseUrl: "",
};
function gateway(complete: boolean): ModelGatewayConfig {
  const endpoint = { baseUrl: "", apiKeyPreview: "", configured: true };
  const effective = { ...endpoint, source: "custom" };
  return {
    mode: "custom",
    effective,
    llmEffective: {
      ...effective,
      mode: "advanced",
      model: "",
      brainclaw: false,
    },
    official: { ...endpoint, source: "env", environment: endpoint },
    custom: {
      ...endpoint,
      llmMode: "advanced",
      adminBaseUrl: "",
      tokenName: "",
      tokenId: "",
    },
    provisioner: {
      enabled: true,
      adminBaseUrl: "",
      dbConfigured: true,
      adminUsername: "",
      relayTokenName: "",
      relayBaseUrl: "",
      providers: {},
      providerChannels: [channel],
      mediaModels: {
        customImage: { provider: "openrouter", upstreamModel: "image-model" },
      },
      embeddingModel: complete
        ? {
            provider: "openrouter",
            upstreamModel: "saved-embedding",
            dimension: 512,
          }
        : undefined,
    },
  };
}
function open() {
  const client = new QueryClient();
  const panel = (config?: ModelGatewayConfig) => (
    <QueryClientProvider client={client}>
      <QuickLocalNewApiSetup
        config={config}
        loading={!config}
        newApiBaseUrl=""
        database={undefined}
      />
    </QueryClientProvider>
  );
  const view = render(panel());
  return {
    receive: (complete: boolean) => view.rerender(panel(gateway(complete))),
    json: () => view.container.querySelector("textarea")!.value,
    client,
  };
}
afterEach(() => {
  cleanup();
  localStorage.removeItem(key);
});

it("recommends GPT-6 Luna for both text and vision on OpenRouter", () => {
  const luna = { channel: "openrouter", model: "openai/gpt-6-luna" };
  expect(JSON.parse(open().json()).featureModels).toMatchObject({ text: luna, vision: luna });
});

it("recommends Seedance 2.x without provisioning the retired 1.0 and 1.5 models", () => {
  const models = JSON.parse(open().json()).mediaModels;
  expect(Object.keys(models).filter(id => /^seedance-1\.[05](?:-|$)/.test(id))).toEqual([]);
  for (const id of ["seedance-2.0", "seedance-2.0-fast", "seedance-2.0-mini"]) {
    expect(models[id]?.mediaType).toBe("video");
    expect(models[id]?.config.supportedModes).toEqual(expect.arrayContaining(["text_to_video", "all_reference"]));
  }
});

it("maps Seed Audio to the DoubaoAudio channel for speech and voice design", () => {
  const profile = JSON.parse(open().json());
  expect(profile.channels).toContainEqual(expect.objectContaining({ id: "doubao_audio", type: 62 }));
  expect(profile.mediaModels["seed-audio-1.0"]).toMatchObject({
    channel: "doubao_audio", model: "seed-audio-1.0", mediaType: "audio", enabled: true,
    config: { request: { endpoint: "audio/speech" }, voiceDesignMode: "prompted_speech" },
  });
});

it("recovers the old null sentinel only when a complete saved configuration arrives", () => {
  localStorage.setItem(
    key,
    JSON.stringify({
      version: 1,
      selected: "custom",
      customProfileJson: "null",
      appliedProfileJson: "null",
    }),
  );
  const panel = open();
  expect(panel.json()).toBe("");
  panel.receive(false);
  expect(panel.json()).toBe("");
  panel.receive(true);
  const json = panel.json();
  expect(stored()).toMatchObject({
    customProfileJson: json,
    appliedProfileJson: json,
  });
  expect(JSON.parse(json)).toMatchObject({
    embedding: { model: "saved-embedding" },
    mediaModels: { customImage: { model: "image-model" } },
  });
  expect(json).not.toContain(channel.upstreamKeyPreview);
  expect(panel.client.getMutationCache().getAll()).toHaveLength(0);
  panel.receive(false);
  expect(panel.json()).toBe(json);
  expect(stored().appliedProfileJson).toBe(json);
});

it("preserves an independently edited draft while recovering the applied profile", () => {
  const draft = '{"work in progress":';
  localStorage.setItem(
    key,
    JSON.stringify({
      version: 1,
      selected: "custom",
      customProfileJson: draft,
      appliedProfileJson: "null",
    }),
  );
  const panel = open();
  panel.receive(false);
  panel.receive(true);
  expect(panel.json()).toBe(draft);
  expect(stored().customProfileJson).toBe(draft);
  expect(JSON.parse(stored().appliedProfileJson).embedding.model).toBe(
    "saved-embedding",
  );
});
