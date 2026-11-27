// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasContextHostData } from '@/features/canvas/server/answerContextRequests';
import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import type { CanvasContextRequest, CanvasContextRequestEnvelope } from '@/features/freezone/chatNodeReferences';

export const contextCanvas: { nodes: CanvasNode[]; edges: CanvasEdge[]; metadata: Record<string, unknown>; canvas_id: string } = {
  canvas_id: 'context-canvas', metadata: { references: [] },
  nodes: [
    { id: 'text', type: 'textAnnotationNode', position: { x: 0, y: 0 }, data: { content: 'A ship at dawn' } },
    { id: 'image', type: 'imageGenNode', position: { x: 400, y: 0 }, data: { model: 'image-fixture', prompt: 'Ship', imageUrl: '/output/ship.png' } },
    { id: 'video', type: 'videoNode', position: { x: 800, y: 0 }, data: { model: 'video-fixture', prompt: 'Sail', videoUrl: '/output/ship.mp4' } },
    { id: 'audio', type: 'audioNode', position: { x: 0, y: 400 }, data: { text: 'Set sail', audioUrl: '/output/voice.wav' } },
    { id: 'html', type: 'htmlArtifactNode', position: { x: 400, y: 400 }, data: { artifactId: 'page', artifactVersion: 2, displayName: 'Ship log' } },
    { id: 'beat', type: 'beatContextNode', position: { x: 800, y: 400 }, data: { visual_description: 'Ship at dawn', time_of_day: 'day' } },
  ],
  edges: [
    { id: 'prompt', source: 'text', target: 'image', data: { linkType: 'prompt_for' } },
    { id: 'reference', source: 'image', target: 'video', data: { linkType: 'reference_image' } },
  ],
};
export const contextCatalogs = {
  image: [{ id: 'image-fixture', providerId: 'openai', apiModel: 'image-fixture', label: 'Fixture Image', ratioOptions: ['1:1'] }],
  video: [{ id: 'video-fixture', providerId: 'newapi', apiModel: 'video-fixture', label: 'Fixture Video', referenceImageMax: 1 }],
};
export const contextHostData = {
  audio_references: { items: [{ scope: 'project_narrator', label: 'Narrator', language: 'en', preview_url: '/voice.wav' }] },
  project_assets: [{ id: 'scene', tab: 'scenes', kind: 'scene', role: 'scene_master', label: 'Harbor', exists: true, meta: { scene_id: 'harbor' } }],
  characters: [{ name: 'Captain', display_name: 'The captain', portrait_url: '/captain.png', role: 'lead' }],
  html_artifacts: {
    'page@latest': { id: 'page', title: 'Ship log', version: 2, html: '<html>Complete ship log</html>' },
    'page@1': { id: 'page', title: 'Old log', version: 1, html: '<html>Old log</html>' },
  },
  html_versions: { page: { versions: [{ version: 1, title: 'Old log', created_at: '2026-01-01' }, { version: 2, title: 'Ship log', created_at: '2026-01-02' }] } },
} satisfies CanvasContextHostData;
export const contextRequests: CanvasContextRequest[] = [
  { type: 'canvas_ontology' }, { type: 'canvas_summary' }, { type: 'canvas_action_catalog' },
  { type: 'canvas_command_catalog' }, { type: 'link_type_catalog' }, { type: 'selection_detail' },
  { type: 'validate_canvas_commands', payload: { commands: [{ type: 'update_node_data', node_id: 'missing', data: { content: 'bad' } }] } },
  { type: 'node_detail', node_id: 'beat' }, { type: 'node_action_catalog', node_id: 'video' },
  { type: 'action_catalog', node_id: 'image' }, { type: 'node_action_read', node_id: 'html', action: 'read_source' },
  { type: 'node_action_read', node_id: 'html', action: 'history' },
  { type: 'neighbor_graph', node_id: 'video' }, { type: 'action_catalog_by_id', action_id: 'canvas.create_node' },
  { type: 'node_create_schema', node_type: 'imageGenNode', model_id: 'image-fixture' },
  { type: 'audio_voice_options', node_id: 'audio' }, { type: 'slot_candidates' }, { type: 'mainline_projection_assets' },
];
export function contextEnvelopes(requests = contextRequests): CanvasContextRequestEnvelope[] {
  return [{ schema_version: 'canvas_context_request.v1', requests }];
}
export const contextEnv = { locale: 'zh', project: 'fixture', canvasId: 'context-canvas', username: 'captain', catalogs: contextCatalogs, selectedNodeIds: [] };
export const contextNeeds = [
  { kind: 'html_artifact', artifact_id: 'page', version: null }, { kind: 'html_versions', artifact_id: 'page' },
  { kind: 'audio_references' }, { kind: 'project_assets' }, { kind: 'characters' },
];
