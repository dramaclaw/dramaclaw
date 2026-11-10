// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { buildCanvasOntologyContext } from '../ontology/canvasOntology';
import { defaultNodeDataDefaults } from '../domain/nodeRegistry';
import { SHARED_MODELS, VIDEO_MODELS } from '../domain/modelOptions';
import { imageModelOptionsFromPayload, videoModelOptionsFromPayload } from '../domain/modelCatalogPayload';
import { withCanvasModelCatalogsAsync } from '../domain/canvasModelCatalogs';
import { coerceAudioReferences } from '../domain/audioReferences';
import { combineMainlineProjectionAssets } from '../domain/mainlineProjectionAssets';
import { buildCanvasContextRequestResponses, extractCanvasContextRequestEnvelopes, type CanvasContextPorts } from '@/features/freezone/chatNodeReferences';
import { buildCanvasContextToolResultBody, canvasContextFailureErrors } from '@/features/freezone/context/canvasContextResult';
import { executeHtmlNodeReadAction } from '@/features/html-artifacts/readNode';
import { isRecord } from '@/features/freezone/canvasCommandEnvelope';
import type { FreezoneProjectAsset } from '@/api/projects';
import type { SavedCanvas } from './applyCommands';
import { runServerRequest } from './requestScope';

export type CanvasContextHostNeed =
  | { kind: 'audio_references' }
  | { kind: 'project_assets' }
  | { kind: 'characters' }
  | { kind: 'html_artifact'; artifact_id: string; version: number | null }
  | { kind: 'html_versions'; artifact_id: string };
type HostValue<T> = T | { error: { message: string } };
type Character = Parameters<typeof combineMainlineProjectionAssets>[1][number];
export interface CanvasContextHostData {
  audio_references?: unknown;
  project_assets?: HostValue<FreezoneProjectAsset[]>;
  characters?: HostValue<Character[]>;
  html_artifacts?: Record<string, unknown>;
  html_versions?: Record<string, unknown>;
}
export interface AnswerContextEnvironment {
  locale?: string;
  project?: string;
  canvasId?: string;
  username?: string | null;
  catalogs?: { image?: unknown; video?: unknown };
  selectedNodeIds?: string[];
  hostData?: CanvasContextHostData;
}
export type AnswerContextResult =
  | { status: 'needs_host_data'; needs: CanvasContextHostNeed[] }
  | { status: 'answered'; result: ReturnType<typeof buildCanvasContextToolResultBody> };

class MissingHostData extends Error {}

export function answerContextRequests(canvas: SavedCanvas & { canvas_id?: string }, envelopes: unknown[], env: AnswerContextEnvironment = {}): Promise<AnswerContextResult> {
  return runServerRequest(env.locale, () => answerSerial(canvas, envelopes, env));
}

async function answerSerial(canvas: SavedCanvas & { canvas_id?: string }, envelopes: unknown[], env: AnswerContextEnvironment): Promise<AnswerContextResult> {
  const project = env.project ?? '';
  const canvasId = env.canvasId ?? canvas.canvas_id ?? '';
  const normalized = extractCanvasContextRequestEnvelopes(envelopes);
  const needs: CanvasContextHostNeed[] = [];
  const read = <T>(value: HostValue<T> | undefined, need: CanvasContextHostNeed): T => {
    if (value === undefined) {
      if (!needs.some(item => JSON.stringify(item) === JSON.stringify(need))) needs.push(need);
      throw new MissingHostData();
    }
    if (isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string') throw new Error(value.error.message);
    // The error variant was checked at this host boundary.
    return value as T;
  };
  const host = env.hostData ?? {};
  const ports: CanvasContextPorts = {
    nodeDataDefaults: defaultNodeDataDefaults,
    username: env.username ?? null,
    loadAudioReferences: async () => coerceAudioReferences(read(host.audio_references, { kind: 'audio_references' })),
    loadMainlineProjectionAssets: async () => {
      // Discover both independent routes even when one is missing.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => read(host.project_assets, { kind: 'project_assets' })),
        Promise.resolve().then(() => read(host.characters, { kind: 'characters' })),
      ]);
      const [assets, characters] = results;
      if (assets.status === 'rejected') throw assets.reason;
      if (characters.status === 'rejected') throw characters.reason;
      return combineMainlineProjectionAssets(assets.value, characters.value);
    },
    readHtmlNode: options => executeHtmlNodeReadAction({ ...options, ports: {
      readHtmlArtifact: async (_project, id, version) => {
        const raw = read(host.html_artifacts?.[`${id}@${version ?? 'latest'}`], { kind: 'html_artifact', artifact_id: id, version: version ?? null });
        if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.version !== 'number' || typeof raw.html !== 'string') throw new Error('Invalid HTML artifact response');
        return { id: raw.id, title: raw.title, version: raw.version, html: raw.html };
      },
      listHtmlVersions: async (_project, id) => {
        const raw = read(host.html_versions?.[id], { kind: 'html_versions', artifact_id: id });
        if (!isRecord(raw) || !Array.isArray(raw.versions)) throw new Error('Invalid HTML versions response');
        return { versions: raw.versions };
      },
    } }),
  };
  const catalogs = {
    image: env.catalogs?.image === undefined ? SHARED_MODELS : imageModelOptionsFromPayload(env.catalogs.image),
    video: env.catalogs?.video === undefined ? VIDEO_MODELS : videoModelOptionsFromPayload(env.catalogs.video),
  };
  return withCanvasModelCatalogsAsync(catalogs, async () => {
    const selectedNodeIds = env.selectedNodeIds ?? [];
    const ontologyContext = buildCanvasOntologyContext(canvas.nodes, canvas.edges, { canvasId, selectedNodeIds });
    const responses: Record<string, unknown>[] = [];
    let errors: string[] = [];
    // Probe each read so the first pass discovers the whole batch's route needs.
    for (const envelope of normalized) {
      for (const request of envelope.requests) {
        try {
          const answer = await buildCanvasContextRequestResponses({
            project, canvasId, nodes: canvas.nodes, edges: canvas.edges, ontologyContext, selectedNodeIds,
            canvasMetadata: isRecord(canvas.metadata) ? canvas.metadata : null,
            envelopes: [{ ...envelope, requests: [request] }], ports,
          });
          responses.push(...answer ?? []);
        } catch (error) {
          if (!(error instanceof MissingHostData) && errors.length === 0) errors = canvasContextFailureErrors(error);
        }
      }
    }
    if (needs.length > 0) return { status: 'needs_host_data', needs };
    // Resolve catalog-backed getters before leaving the request scope.
    return { status: 'answered', result: structuredClone(buildCanvasContextToolResultBody({ projectId: project, canvasId, responses: errors.length ? [] : responses, errors })) };
  });
}
