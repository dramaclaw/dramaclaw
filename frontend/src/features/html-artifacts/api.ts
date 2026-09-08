import { apiCall, apiClient } from '@/api/client';
export type HtmlArtifact = { id: string; title: string; version: number; html: string; created_at: string; updated_at: string };
export type HtmlVersion = { version: number; title: string; created_at: string };
export const htmlArtifactPath = (project: string, id?: string) => `projects/${encodeURIComponent(project)}/freezone/html-artifacts${id ? `/${encodeURIComponent(id)}` : ''}`;
export const readHtmlArtifact = (project: string, id: string, version?: number) => apiCall<HtmlArtifact>(htmlArtifactPath(project, id), { searchParams: version ? {version} : {} });
export const readHtmlPreview = (project: string, id: string, version?: number) => apiCall<{html:string; warnings?:string[]}>(`${htmlArtifactPath(project, id)}/preview`, {searchParams: version ? {version} : {}});
export const createHtmlArtifact = (project: string, title: string, html: string) => apiCall<HtmlArtifact>(htmlArtifactPath(project), { method: 'post', json: {title, html}, retry:0 });
export const saveHtmlArtifact = (project: string, id: string, title: string, html: string, base_version: number) => apiCall<HtmlArtifact>(htmlArtifactPath(project,id), {method:'put', json:{title,html,base_version}, retry:0});
export const listHtmlVersions = (project: string, id: string) => apiCall<{versions:HtmlVersion[]}>(`${htmlArtifactPath(project,id)}/versions`);
export const restoreHtmlVersion = (project: string,id:string,version:number,base_version:number) => apiCall<HtmlArtifact>(`${htmlArtifactPath(project,id)}/restore`,{method:'post',json:{version,base_version},retry:0});
export async function exportHtmlArtifact(project:string,id:string,version:number) {
  const blob = await apiClient(`${htmlArtifactPath(project,id)}/export`,{searchParams:{version}}).blob();
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href=url; link.download=`webpage-${id}-v${version}.zip`; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export const HTML_ARTIFACT_OPEN_EVENT = 'freezone/html-artifact-open';
export const HTML_ARTIFACT_UPDATED_EVENT = 'freezone/html-artifact-updated';
export const HTML_ARTIFACT_REFERENCE_EVENT = 'freezone/html-artifact-reference';
export type HtmlArtifactTarget = {projectId:string;artifactId:string;version?:number};
export function openHtmlArtifact(target:HtmlArtifactTarget) { window.dispatchEvent(new CustomEvent(HTML_ARTIFACT_OPEN_EVENT,{detail:target})); }
export function announceHtmlArtifact(projectId:string,artifact:HtmlArtifact) { window.dispatchEvent(new CustomEvent(HTML_ARTIFACT_UPDATED_EVENT,{detail:{projectId,artifact}})); }

let activeArtifact: (HtmlArtifactTarget & {title:string;dirty:boolean}) | null = null;
export function setActiveHtmlArtifact(value: typeof activeArtifact) { activeArtifact=value; }
export function activeHtmlArtifactContext(projectId:string|undefined) {
  return activeArtifact?.projectId===projectId ? activeArtifact : null;
}
