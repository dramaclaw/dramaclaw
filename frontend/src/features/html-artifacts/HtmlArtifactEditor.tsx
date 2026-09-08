import { readHtmlDraft, keepHtmlDraft } from './drafts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Code2, Download, Eye, MousePointer2, Save } from 'lucide-react';
import { setActiveHtmlArtifact, announceHtmlArtifact, exportHtmlArtifact, HTML_ARTIFACT_REFERENCE_EVENT, HTML_ARTIFACT_UPDATED_EVENT, listHtmlVersions, readHtmlArtifact, readHtmlPreview, restoreHtmlVersion, saveHtmlArtifact, type HtmlArtifact, type HtmlVersion } from './api';
import { buildHtmlPreview, isHtmlSelectionMessage } from './preview';

type Props = { projectId:string; artifactId:string; version?:number; onClose:()=>void };
export function HtmlArtifactEditor({projectId,artifactId,version,onClose}:Props) {
  const {t}=useTranslation();
  const [artifact,setArtifact]=useState<HtmlArtifact|null>(null);
  const [title,setTitle]=useState(''); const [html,setHtml]=useState('');
  const [preview,setPreview]=useState(''); const [versions,setVersions]=useState<HtmlVersion[]>([]);
  const [interactiveVersion,setInteractiveVersion]=useState<string|null>(null);
  const interactive=Boolean(artifact&&interactiveVersion===`${artifactId}:${artifact.version}`);
  const setInteractive=(enabled:boolean)=>setInteractiveVersion(enabled&&artifact?`${artifactId}:${artifact.version}`:null);
  const canRunScripts=typeof HTMLIFrameElement!=='undefined'&&'credentialless' in HTMLIFrameElement.prototype;
  const [code,setCode]=useState(false); const [mobile,setMobile]=useState(false); const [selecting,setSelecting]=useState(false);
  const [error,setError]=useState(''); const [busy,setBusy]=useState(false); const [remoteUpdate,setRemoteUpdate]=useState(false);
  const frame=useRef<HTMLIFrameElement>(null); const sequence=useRef(0);
  const dirty=!!artifact&&(html!==artifact.html||title!==artifact.title);
  useEffect(()=>{
    setActiveHtmlArtifact(artifact?{projectId,artifactId,version:artifact.version,title:artifact.title,dirty}:null);
    return()=>setActiveHtmlArtifact(null);
  },[artifact,projectId,artifactId,dirty]);
  useEffect(()=>{
    if(artifact) keepHtmlDraft(projectId,artifactId,dirty?{html,title,version:artifact.version}:null);
  },[artifact,dirty,html,title,projectId,artifactId]);
  const dirtyRef=useRef(dirty); dirtyRef.current=dirty;
  const token=useMemo(()=>crypto.randomUUID(),[artifact?.version,selecting,preview]);
  const srcDoc=useMemo(()=>buildHtmlPreview(preview,token,selecting,interactive),[preview,token,selecting,interactive]);
  const reference=(selection?:{selector:string;text:string})=>{
    if (!artifact) return;
    window.dispatchEvent(new CustomEvent(HTML_ARTIFACT_REFERENCE_EVENT,{detail:{projectId,artifactId,version:artifact.version,title:artifact.title,...selection}}));
  };
  const load=async(requestedVersion?:number)=>{
    const current=++sequence.current; setBusy(true);setError('');
    try {
      const draft=readHtmlDraft(projectId,artifactId);
      const next=await readHtmlArtifact(projectId,artifactId,draft?.version ?? requestedVersion);
      const [rendered,history]=await Promise.all([readHtmlPreview(projectId,artifactId,next.version),listHtmlVersions(projectId,artifactId)]);
      if(current!==sequence.current)return;
      setArtifact(next);setTitle(draft?.title??next.title);setHtml(draft?.html??next.html);setPreview(rendered.html);setVersions(history.versions);setRemoteUpdate(Boolean(draft&&history.versions.some(v=>v.version>draft.version)));
      if(rendered.warnings?.length)setError(rendered.warnings.join('\n'));
    }catch(err){if(current===sequence.current)setError(err instanceof Error?err.message:String(err));}
    finally{if(current===sequence.current)setBusy(false);}
  };
  useEffect(()=>{void load(version);return()=>{sequence.current++;};},[projectId,artifactId,version]);
  useEffect(()=>{
    const changed=(event:Event)=>{
      const detail=(event as CustomEvent<{projectId:string;artifact:HtmlArtifact}>).detail;
      if(detail?.projectId!==projectId||detail.artifact?.id!==artifactId)return;
      if(dirtyRef.current){setRemoteUpdate(true);return;}
      void load();
    };
    window.addEventListener(HTML_ARTIFACT_UPDATED_EVENT,changed);
    return()=>window.removeEventListener(HTML_ARTIFACT_UPDATED_EVENT,changed);
  },[projectId,artifactId]);
  useEffect(()=>{
    const guard=(event:BeforeUnloadEvent)=>{if(dirtyRef.current){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);
  },[]);
  useEffect(()=>{
    const selected=(event:MessageEvent)=>{
      if(dirtyRef.current||!selecting||event.source!==frame.current?.contentWindow||!isHtmlSelectionMessage(event.data,token))return;
      reference(event.data);
    };
    window.addEventListener('message',selected);return()=>window.removeEventListener('message',selected);
  },[selecting,token,artifact,projectId,artifactId]);
  const mayDiscard=()=>{const allowed=!dirty||window.confirm(t('htmlArtifact.discard'));if(allowed)keepHtmlDraft(projectId,artifactId,null);return allowed;};
  const mutate=async(restore?:number)=>{
    if(!artifact)return;setBusy(true);setError('');
    try {
      const next=restore===undefined?await saveHtmlArtifact(projectId,artifactId,title,html,artifact.version):await restoreHtmlVersion(projectId,artifactId,restore,artifact.version);
      setArtifact(next);setTitle(next.title);setHtml(next.html);dirtyRef.current=false;
      keepHtmlDraft(projectId,artifactId,null);
      announceHtmlArtifact(projectId,next);
    }catch(err){setError(err instanceof Error?err.message:String(err));}finally{setBusy(false);}
  };
  const button='inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs hover:bg-accent disabled:opacity-40';
  return <section className="absolute inset-0 z-30 flex flex-col bg-background text-foreground" aria-label={t('htmlArtifact.editor')}>
    <header className="flex flex-wrap items-center gap-1 border-b border-border bg-card p-2">
      <button className={button} onClick={()=>{if(mayDiscard())onClose();}}><ArrowLeft size={14}/>{t('htmlArtifact.back')}</button>
      <input className="min-w-24 flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm" aria-label={t('htmlArtifact.title')} value={title} onChange={e=>setTitle(e.target.value)} disabled={!artifact||busy}/>
      <span className="text-xs text-muted-foreground">{artifact?`v${artifact.version}${dirty?' •':''}`:''}</span>
      <button className={button} aria-pressed={!code} onClick={()=>setCode(false)}><Eye size={14}/>{t('htmlArtifact.preview')}</button>
      <button className={button} aria-pressed={code} onClick={()=>setCode(true)}><Code2 size={14}/>{t('htmlArtifact.code')}</button>
      <button className={button} disabled={!artifact||busy||!dirty} onClick={()=>void mutate()}><Save size={14}/>{t('htmlArtifact.save')}</button>
      <button className={button} disabled={!artifact||busy||dirty} onClick={()=>void exportHtmlArtifact(projectId,artifactId,artifact!.version).catch(err=>setError(String(err)))}><Download size={14}/>{t('htmlArtifact.export')}</button>
    </header>
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
      <button className={button} aria-pressed={!mobile} onClick={()=>setMobile(false)}>{t('htmlArtifact.desktop')}</button>
      <button className={button} aria-pressed={mobile} onClick={()=>setMobile(true)}>{t('htmlArtifact.mobile')}</button>
      <button className={button} aria-pressed={selecting} disabled={code||dirty||!artifact} onClick={()=>setSelecting(!selecting)}><MousePointer2 size={14}/>{t('htmlArtifact.select')}</button>
      <button className={button} disabled={!artifact||dirty} onClick={()=>reference()}>{t('htmlArtifact.ask')}</button>
      <button className={button} aria-pressed={interactive} disabled={!canRunScripts||code||dirty||!artifact} onClick={()=>setInteractive(!interactive)}>{t(interactive?'htmlArtifact.stopScripts':'htmlArtifact.runScripts')}</button>
      <select className="ml-auto rounded border border-border bg-background p-1.5" aria-label={t('htmlArtifact.versions')} value={artifact?.version??''} disabled={busy||!artifact} onChange={e=>{if(mayDiscard())void load(Number(e.target.value));}}>
        {versions.map(v=><option key={v.version} value={v.version}>v{v.version} · {v.title}</option>)}
      </select>
      {artifact&&versions.length>0&&artifact.version!==Math.max(...versions.map(v=>v.version))&&<button className={button} disabled={busy||dirty} onClick={async()=>{
        setBusy(true);try{const latest=await readHtmlArtifact(projectId,artifactId);const next=await restoreHtmlVersion(projectId,artifactId,artifact.version,latest.version);announceHtmlArtifact(projectId,next);}catch(err){setError(String(err));}finally{setBusy(false);}
      }}>{t('htmlArtifact.restore')}</button>}
    </div>
    <p className="px-3 py-1 text-xs text-muted-foreground">{t(canRunScripts?'htmlArtifact.scriptNotice':'htmlArtifact.scriptUnsupported')}</p>
    {error&&<p role="alert" className="whitespace-pre-wrap border-b border-border px-3 py-2 text-sm text-destructive">{error}</p>}
    {remoteUpdate&&<p role="status" className="px-3 py-2 text-sm">{t('htmlArtifact.conflict')} <button className={button} onClick={()=>{if(mayDiscard())void load();}}>{t('htmlArtifact.reload')}</button></p>}
    {dirty&&!code&&<p className="px-3 py-2 text-xs text-muted-foreground">{t('htmlArtifact.savedPreview')}</p>}
    {busy&&<p role="status" className="px-3 py-1 text-xs text-muted-foreground">{t('htmlArtifact.loading')}</p>}
    <div className="relative min-h-0 flex-1 overflow-auto bg-muted/30 p-4">
      {code?<textarea aria-label={t('htmlArtifact.source')} className="h-full w-full resize-none rounded-lg border border-border bg-background p-4 font-mono text-xs outline-none focus:border-primary" spellCheck={false} value={html} disabled={!artifact||busy} onChange={e=>setHtml(e.target.value)}/>:artifact&&<iframe key={`${artifactId}:${artifact.version}:${interactive}`} {...(interactive?{credentialless:""}:{})} ref={frame} title={t('htmlArtifact.preview')} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} className="mx-auto h-full min-h-96 max-w-full rounded-lg border border-border bg-white" style={{width:mobile?390:'100%'}}/>}
    </div>
  </section>;
}
