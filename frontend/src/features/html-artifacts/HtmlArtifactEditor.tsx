import {editHtmlText, type TextEdit} from './textEditing';
import { readUrl } from '@/lib/url-params';
import { readHtmlDraft, keepHtmlDraft } from './drafts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Code2, Download, Eye, MousePointer2, Save } from 'lucide-react';
import { setActiveHtmlArtifact, announceHtmlArtifact, exportHtmlArtifact, HTML_ARTIFACT_REFERENCE_EVENT, HTML_ARTIFACT_UPDATED_EVENT, listHtmlVersions, readHtmlArtifact, readHtmlPreview, saveHtmlArtifact, type HtmlArtifact, type HtmlVersion } from './api';
import { buildHtmlPreview, isHtmlSelectionMessage } from './preview';
import { useCanvasStore } from '@/stores/canvasStore';

type Props = { projectId:string; artifactId:string; version?:number; nodeId?:string; onClose:()=>void };
export function HtmlArtifactEditor({projectId,artifactId,version,nodeId,onClose}:Props) {
  const {t}=useTranslation();
  const [artifact,setArtifact]=useState<HtmlArtifact|null>(null);
  const [title,setTitle]=useState(''); const [html,setHtml]=useState('');
  const [media,setMedia]=useState<Array<{placeholder:string;blob:Blob}>>([]);
  const [preview,setPreview]=useState(''); const [versions,setVersions]=useState<HtmlVersion[]>([]);
  const [interactiveVersion,setInteractiveVersion]=useState<string|null>(null);
  const interactive=Boolean(artifact&&interactiveVersion===`${artifactId}:${artifact.version}`);
  const setInteractive=(enabled:boolean)=>setInteractiveVersion(enabled&&artifact?`${artifactId}:${artifact.version}`:null);
  const canRunScripts=typeof HTMLIFrameElement!=='undefined'&&'credentialless' in HTMLIFrameElement.prototype;
  const [code,setCode]=useState(false); const [mobile,setMobile]=useState(false); const [selecting,setSelecting]=useState(false);
  const [selection,setSelection]=useState<{selector:string;text:string}|null>(null);
  const [manualDirty,setManualDirty]=useState(false);
  const applyText=(patch:TextEdit)=>{if(!selection)return;try{const next=editHtmlText(html,selection.selector,patch);const rendered=editHtmlText(preview,selection.selector,patch);setHtml(next);setPreview(rendered);setManualDirty(true);if(patch.text!==undefined)setSelection({...selection,text:patch.text});setError('');}catch{setError(t('htmlArtifact.selectLeaf'));}};
  const [warnings,setWarnings]=useState<string[]>([]);
  const [error,setError]=useState(''); const [busy,setBusy]=useState(false); const [remoteUpdate,setRemoteUpdate]=useState(false);
  const previewRelease=useRef<(()=>void)|undefined>(undefined);
  const baseVersion=useRef<number>(0);
  const frame=useRef<HTMLIFrameElement>(null); const sequence=useRef(0);
  const dirty=!!artifact&&(html!==artifact.html||title!==artifact.title);
  useEffect(()=>{
    setActiveHtmlArtifact(artifact?{projectId,artifactId,version:artifact.version,title:artifact.title,dirty}:null);
    return()=>setActiveHtmlArtifact(null);
  },[artifact,projectId,artifactId,dirty]);
  useEffect(()=>{
    if(artifact) keepHtmlDraft(projectId,artifactId,dirty?{html,title,version:artifact.version,baseVersion:baseVersion.current}:null);
  },[artifact,dirty,html,title,projectId,artifactId]);
  const dirtyRef=useRef(dirty); dirtyRef.current=dirty;
  const token=useMemo(()=>crypto.randomUUID(),[artifact?.version,selecting,preview]);
  const srcDoc=useMemo(()=>buildHtmlPreview(preview,token,selecting,interactive),[preview,token,selecting,interactive]);
  const reference=(selection?:{selector:string;text:string})=>{
    if (!artifact) return;
    window.dispatchEvent(new CustomEvent(HTML_ARTIFACT_REFERENCE_EVENT,{detail:{projectId,artifactId,version:artifact.version,title:artifact.title,...selection}}));
  };
  const load=async(requestedVersion?:number)=>{
    setSelection(null);setManualDirty(false);
    const current=++sequence.current; setBusy(true);setError('');setWarnings([]);
    try {
      const storedDraft=readHtmlDraft(projectId,artifactId);
      const draft=requestedVersion===undefined||storedDraft?.version===requestedVersion?storedDraft:undefined;
      const next=await readHtmlArtifact(projectId,artifactId,draft?.version ?? requestedVersion);
      const [rendered,history]=await Promise.all([readHtmlPreview(projectId,artifactId,next.version),listHtmlVersions(projectId,artifactId)]);
      if(current!==sequence.current){rendered.release?.();return;}
      previewRelease.current?.();previewRelease.current=rendered.release;
      baseVersion.current=draft?.baseVersion??(draft?draft.version:Math.max(next.version,...history.versions.map(v=>v.version)));
      setArtifact(next);setTitle(draft?.title??next.title);setHtml(draft?.html??next.html);setPreview(rendered.html);setMedia(rendered.media??[]);setVersions(history.versions);setRemoteUpdate(Boolean(draft&&history.versions.some(v=>v.version>draft.version)));
      setWarnings(rendered.warnings ?? []);
    }catch(err){if(current===sequence.current)setError(err instanceof Error?err.message:String(err));}
    finally{if(current===sequence.current)setBusy(false);}
  };
  useEffect(()=>{void load(version);return()=>{sequence.current++;previewRelease.current?.();previewRelease.current=undefined;};},[projectId,artifactId,version]);
  useEffect(()=>{
    const changed=(event:Event)=>{
      const detail=(event as CustomEvent<{projectId:string;artifact:HtmlArtifact;nodeId?:string}>).detail;
      if(detail?.projectId!==projectId||detail.artifact?.id!==artifactId)return;
      if(dirtyRef.current){setRemoteUpdate(true);return;}
      if(detail.nodeId&&detail.nodeId===nodeId)void load(detail.artifact.version);
      else if(version===undefined&&!nodeId)void load();
      else setRemoteUpdate(true);
    };
    window.addEventListener(HTML_ARTIFACT_UPDATED_EVENT,changed);
    return()=>window.removeEventListener(HTML_ARTIFACT_UPDATED_EVENT,changed);
  },[projectId,artifactId,nodeId,version]);
  useEffect(()=>{
    const guard=(event:BeforeUnloadEvent)=>{if(dirtyRef.current){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);
  },[]);
  useEffect(()=>{
    const selected=(event:MessageEvent)=>{
      if(!selecting||event.source!==frame.current?.contentWindow||!isHtmlSelectionMessage(event.data,token))return;
      setSelection({selector:event.data.selector,text:event.data.text});
    };
    window.addEventListener('message',selected);return()=>window.removeEventListener('message',selected);
  },[selecting,token,artifact,projectId,artifactId]);
  const mayDiscard=()=>{const allowed=!dirty||window.confirm(t('htmlArtifact.discard'));if(allowed)keepHtmlDraft(projectId,artifactId,null);return allowed;};
  const mutate=async()=>{
    if(!artifact)return;setBusy(true);setError('');setWarnings([]);
    try {
      const canvasId=readUrl().canvas;
      const next=await saveHtmlArtifact(projectId,artifactId,title,html,baseVersion.current,canvasId&&nodeId?{canvas_id:canvasId,node_id:nodeId}:undefined);
      setArtifact(next);setTitle(next.title);setHtml(next.html);dirtyRef.current=false;
      keepHtmlDraft(projectId,artifactId,null);
      announceHtmlArtifact(projectId,next,nodeId);
      await load(next.version);
      if(next.warnings?.length)setWarnings(current=>[...current,...next.warnings!]);
    }catch(err){setError(err instanceof Error?err.message:String(err));}finally{setBusy(false);}
  };
  const useCurrentVersion=()=>{
    if(!artifact||!nodeId)return;
    useCanvasStore.getState().updateNodeData(nodeId,{
      artifactId:artifact.id,
      artifactVersion:artifact.version,
      displayName:artifact.title,
      htmlSelectionToken:`${Date.now()}:${artifact.version}`,
      generationError:null,
    });
    announceHtmlArtifact(projectId,artifact,nodeId);
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
      <button className={button} aria-pressed={selecting} disabled={code||(dirty&&!manualDirty)||!artifact} onClick={()=>{setSelecting(!selecting);setInteractive(false);setSelection(null);}}><MousePointer2 size={14}/>{t('htmlArtifact.select')}</button>
      <button className={button} disabled={!artifact||dirty} onClick={()=>reference(selection??undefined)}>{t('htmlArtifact.ask')}</button>
      <button className={button} aria-pressed={interactive} disabled={!canRunScripts||code||dirty||!artifact} onClick={()=>setInteractive(!interactive)}>{t(interactive?'htmlArtifact.stopScripts':'htmlArtifact.runScripts')}</button>
      <select className="ml-auto rounded border border-border bg-background p-1.5" aria-label={t('htmlArtifact.versions')} value={artifact?.version??''} disabled={busy||!artifact} onChange={e=>{if(mayDiscard())void load(Number(e.target.value));}}>
        {versions.map(v=><option key={v.version} value={v.version}>v{v.version} · {v.title}</option>)}
      </select>
      {artifact&&nodeId&&<button className={button} disabled={busy||dirty} onClick={useCurrentVersion}>{t('htmlArtifact.useVersion')}</button>}
    </div>
    {selecting&&selection&&!code&&<div role="toolbar" aria-label={t('htmlArtifact.textTools')} className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 text-xs">
      <input aria-label={t('htmlArtifact.textContent')} className="min-w-40 flex-1 rounded border border-border bg-background p-2" value={selection.text} disabled={busy} onChange={e=>applyText({text:e.target.value})}/>
      <select aria-label={t('htmlArtifact.fontFamily')} defaultValue="" onChange={e=>applyText({fontFamily:e.target.value})} className="rounded border border-border bg-background p-2"><option value="" disabled>{t('htmlArtifact.fontFamily')}</option>{['sans-serif','serif','monospace'].map(v=><option key={v} value={v}>{v}</option>)}</select>
      <input aria-label={t('htmlArtifact.fontSize')} type="number" min="1" max="300" placeholder="px" className="w-16 rounded border border-border bg-background p-2" onChange={e=>{if(e.target.value)applyText({fontSize:Number(e.target.value)});}}/>
      <input aria-label={t('htmlArtifact.textColor')} type="color" onInput={e=>applyText({color:e.currentTarget.value})}/>
      <button className={button} onClick={()=>applyText({fontWeight:'700'})}>{t('htmlArtifact.bold')}</button>
      <button className={button} onClick={()=>applyText({fontWeight:'400'})}>{t('htmlArtifact.regular')}</button>
      {(['left','center','right'] as const).map(v=><button key={v} className={button} onClick={()=>applyText({textAlign:v})}>{t(`htmlArtifact.align${v}`)}</button>)}
    </div>}
    <p className="px-3 py-1 text-xs text-muted-foreground">{t(canRunScripts?'htmlArtifact.scriptNotice':'htmlArtifact.scriptUnsupported')}</p>
    {warnings.length>0&&<p role="status" className="whitespace-pre-wrap border-b border-border px-3 py-2 text-sm text-muted-foreground">{warnings.join('\n')}</p>}
    {error&&<p role="alert" className="whitespace-pre-wrap border-b border-border px-3 py-2 text-sm text-destructive">{error}</p>}
    {remoteUpdate&&<p role="status" className="px-3 py-2 text-sm">{t('htmlArtifact.conflict')} <button className={button} onClick={()=>{if(mayDiscard())void load();}}>{t('htmlArtifact.reload')}</button></p>}
    {dirty&&!manualDirty&&!code&&<p className="px-3 py-2 text-xs text-muted-foreground">{t('htmlArtifact.savedPreview')}</p>}
    {busy&&<p role="status" className="px-3 py-1 text-xs text-muted-foreground">{t('htmlArtifact.loading')}</p>}
    <div className="relative min-h-0 flex-1 overflow-auto bg-muted/30 p-4">
      {code?<textarea aria-label={t('htmlArtifact.source')} className="h-full w-full resize-none rounded-lg border border-border bg-background p-4 font-mono text-xs outline-none focus:border-primary" spellCheck={false} value={html} disabled={!artifact||busy} onChange={e=>{setHtml(e.target.value);setManualDirty(false);setSelecting(false);setSelection(null);}}/>:artifact&&<iframe key={`${artifactId}:${artifact.version}:${interactive}`} {...(interactive?{credentialless:""}:{})} ref={frame} onLoad={event=>event.currentTarget.contentWindow?.postMessage({type:'html-artifact-media',token,media},'*')} title={t('htmlArtifact.preview')} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} className="mx-auto h-full min-h-96 max-w-full rounded-lg border border-border bg-white" style={{width:mobile?390:'100%'}}/>}
    </div>
  </section>;
}
