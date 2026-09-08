/** Keep source drafts across in-app navigation; never send drafts to the server implicitly. */
export type HtmlDraft={html:string;title:string;version:number};
const drafts=new Map<string,HtmlDraft>();
const key=(projectId:string,artifactId:string)=>JSON.stringify([projectId,artifactId]);
export const readHtmlDraft=(projectId:string,artifactId:string)=>drafts.get(key(projectId,artifactId));
export function keepHtmlDraft(projectId:string,artifactId:string,draft:HtmlDraft|null){
  const id=key(projectId,artifactId);
  if(draft) drafts.set(id,draft); else drafts.delete(id);
}
