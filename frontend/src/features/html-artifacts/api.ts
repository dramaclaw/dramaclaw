import i18n from "i18next";
import { downloadUrlAsFile } from '@/lib/browserDownload';
import { apiCall, apiClient } from '@/api/client';
export type HtmlNodeScope = {canvas_id:string;node_id:string};
export type HtmlArtifact = { warnings?: string[]; id: string; title: string; version: number; html: string; created_at: string; updated_at: string };
export type HtmlVersion = { version: number; title: string; created_at: string };
export const htmlArtifactPath = (project: string, id?: string) => `projects/${encodeURIComponent(project)}/freezone/html-artifacts${id ? `/${encodeURIComponent(id)}` : ''}`;
export const readHtmlArtifact = (project: string, id: string, version?: number) => apiCall<HtmlArtifact>(htmlArtifactPath(project, id), { searchParams: version ? {version} : {} });
export async function readHtmlPreview(project: string, id: string, version?: number) {
  const rendered = await apiCall<{html:string; warnings?:string[]; resources?:Array<{placeholder:string;path:string}>}>(`${htmlArtifactPath(project, id)}/preview`, {searchParams: version ? {version} : {}});
  const media: Array<{placeholder:string;blob:Blob}> = [];
  const release = () => {};
  let html = rendered.html;
  const warnings = [...(rendered.warnings ?? [])];
  const prefix = `/api/v1/projects/${encodeURIComponent(project)}/media/`;
  try {
    for (const resource of rendered.resources ?? []) {
      if (!/^html-media-[a-f0-9]{64}$/.test(resource.placeholder) || !resource.path.startsWith(prefix)) throw new Error('Invalid preview media scope');
      const relative = decodeURIComponent(resource.path.slice(prefix.length));
      if (!relative || relative.split('/').some(part => part === '..' || part === '.') || relative.includes('\\') || /[\x00-\x1f]/.test(relative)) throw new Error('Invalid preview media path');
      try {
        const blob = await apiClient(resource.path.slice('/api/v1/'.length)).blob();
        media.push({placeholder:resource.placeholder,blob});
      } catch {
        html = html.split(resource.placeholder).join('about:blank');
        warnings.push(i18n.t('htmlArtifact.mediaLoadFailed', {path:relative}));
      }
    }
    return {html, warnings, release, media};
  } catch (error) { release(); throw error; }
}

export const createHtmlArtifact = (project: string, title: string, html: string, idempotencyKey?: string) => apiCall<HtmlArtifact>(htmlArtifactPath(project), { method: 'post', json: {title, html, ...(idempotencyKey ? {idempotency_key:idempotencyKey} : {})}, retry:0 });
export const saveHtmlArtifact = (project: string, id: string, title: string, html: string, base_version: number, scope?:HtmlNodeScope, idempotencyKey?:string) => apiCall<HtmlArtifact>(htmlArtifactPath(project,id), {method:'put', json:{title,html,base_version,...scope,...(idempotencyKey ? {idempotency_key:idempotencyKey} : {})}, retry:0});
export const listHtmlVersions = (project: string, id: string) => apiCall<{versions:HtmlVersion[]}>(`${htmlArtifactPath(project,id)}/versions`);
export const restoreHtmlVersion = (project: string,id:string,version:number,base_version:number,scope?:HtmlNodeScope) => apiCall<HtmlArtifact>(`${htmlArtifactPath(project,id)}/restore`,{method:'post',json:{version,base_version,...scope},retry:0});
export async function exportHtmlArtifact(project:string,id:string,version:number) {
  const result = await apiCall<{download_url:string}>(`${htmlArtifactPath(project,id)}/export`,{searchParams:{version}});
  const prefix = `/api/v1/projects/${encodeURIComponent(project)}/files/`;
  if (!result.download_url.startsWith(prefix)) throw new Error('Invalid export download scope');
  await downloadUrlAsFile(result.download_url, `webpage-${id}-v${version}.zip`);
}
export const HTML_ARTIFACT_OPEN_EVENT = 'freezone/html-artifact-open';
export const HTML_ARTIFACT_UPDATED_EVENT = 'freezone/html-artifact-updated';
export const HTML_ARTIFACT_REFERENCE_EVENT = 'freezone/html-artifact-reference';
export type HtmlArtifactTarget = {projectId:string;artifactId:string;version?:number;nodeId?:string};
export function openHtmlArtifact(target:HtmlArtifactTarget) { window.dispatchEvent(new CustomEvent(HTML_ARTIFACT_OPEN_EVENT,{detail:target})); }
export function announceHtmlArtifact(projectId:string,artifact:HtmlArtifact,nodeId?:string) { window.dispatchEvent(new CustomEvent(HTML_ARTIFACT_UPDATED_EVENT,{detail:{projectId,artifact,nodeId}})); }

let activeArtifact: (HtmlArtifactTarget & {title:string;dirty:boolean}) | null = null;
export function setActiveHtmlArtifact(value: typeof activeArtifact) { activeArtifact=value; }
export function activeHtmlArtifactContext(projectId:string|undefined) {
  return activeArtifact?.projectId===projectId ? activeArtifact : null;
}

export const recordHtmlNodeHistory = (project:string,id:string,version:number,scope:HtmlNodeScope) => apiCall<HtmlArtifact>(`${htmlArtifactPath(project,id)}/node-history`,{method:'post',json:{version,...scope},retry:0});

export const findHtmlArtifactCreation = (project:string, idempotencyKey:string) => apiCall<{artifact:HtmlArtifact|null}>(`${htmlArtifactPath(project)}/creation-lookup`,{searchParams:{idempotency_key:idempotencyKey}});
