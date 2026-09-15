import i18n from 'i18next';
// SPDX-License-Identifier: Elastic-2.0
import { apiCall } from '@/api/client';

export interface SkillImportFile { name: string; content_base64: string }
export interface SkillImportCheck {
  status: 'passed' | 'failed' | 'not_run';
  issues: string[];
}
export interface SkillImportQualityReport {
  version: 2 | 3;
  bundle_sha256: string;
  capability_sha256?: string;
  structure: SkillImportCheck;
  coverage: SkillImportCheck;
  planning?: SkillImportCheck;
  blockers: string[];
  findings?: Array<{ category: string; severity: string; source_quote: string; evidence_paths: string[]; message: string }>;
  adaptations?: Array<{ requirement_id: string; owner: string; target: string; status: 'direct' | 'composed' | 'decision_required' | 'unsupported'; reason: string }>;
  validated: boolean;
}
export interface SkillImportItem {
  id: string;
  batch_id: string;
  name: string;
  status: 'queued' | 'running' | 'ready' | 'needs_review' | 'failed' | 'installed';
  stage: string;
  task_id?: string | null;
  error?: string | null;
  warnings: string[];
  bundle: Record<string, unknown> | null;
  quality_report?: SkillImportQualityReport | null;
  created_at: string | number;
}
const root = (project: string) => `projects/${encodeURIComponent(project)}/freezone/skill-imports`;
export const listSkillImports = (project: string) => apiCall<{items: SkillImportItem[]}>(root(project));
export const submitSkillImports = (project: string, files: SkillImportFile[]) =>
  apiCall<{batch_id: string; items: SkillImportItem[]}>(root(project), { method: 'POST', json: { files } });
export const retrySkillImport = (project: string, id: string) =>
  apiCall<SkillImportItem>(`${root(project)}/${encodeURIComponent(id)}/retry`, { method: 'POST' });
export const validateSkillImport = (project: string, id: string, bundle: Record<string, unknown>) =>
  apiCall<SkillImportItem>(`${root(project)}/${encodeURIComponent(id)}/validate`, { method: 'POST', json: { bundle } });
export const installSkillImport = (project: string, id: string, bundle: Record<string, unknown>, acknowledgeWarnings = false) =>
  apiCall<SkillImportItem>(`${root(project)}/${encodeURIComponent(id)}/install`, { method: 'POST', json: { bundle, acknowledge_warnings: acknowledgeWarnings } });

export async function encodeSkillFiles(files: File[]): Promise<SkillImportFile[]> {
  if (!files.length || files.length > 20) throw new Error('Select 1–20 Markdown or ZIP files.');
  if (files.some(file => !/\.(md|zip)$/i.test(file.name))) throw new Error('Only Markdown and ZIP files are supported.');
  if (files.some(file => file.size > 2 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 10 * 1024 * 1024) {
    throw new Error('Maximum 2 MB per file and 10 MB per batch.');
  }
  return Promise.all(files.map(file => new Promise<SkillImportFile>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Cannot read ${file.name}`));
    reader.onload = () => resolve({ name: file.name, content_base64: String(reader.result).split(',')[1] });
    reader.readAsDataURL(file);
  })));
}

export function parseCandidateBundle(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a native Skill Bundle.');
  const bundle = value as Record<string, unknown>;
  if (bundle.schema_version !== 'dramaclaw.skill-bundle.v1' || !bundle.skill || typeof bundle.skill !== 'object' || Array.isArray(bundle.skill) || !Array.isArray(bundle.recipes)) {
    throw new Error('Expected a native Skill Bundle with skill and recipes.');
  }
  return bundle;
}

export function skillImportStudioPrompt(bundle: Record<string, unknown>): string {
  return `${i18n.t('skillImport.studioHandoff')}\n\n${JSON.stringify(bundle, null, 2)}`;
}

// JSON object order and editor whitespace do not change the validated candidate.
export function sameCandidateBundle(draft: string, bundle: Record<string, unknown> | null): boolean {
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
    return JSON.stringify(value);
  }
  try { return canonical(parseCandidateBundle(draft)) === canonical(bundle); }
  catch { return false; }
}
