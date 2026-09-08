import { memo, useEffect, useMemo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Globe, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { readUrl } from '@/lib/url-params';
import { HTML_ARTIFACT_UPDATED_EVENT, openHtmlArtifact, readHtmlPreview } from './api';
import { buildHtmlPreview } from './preview';

export const HtmlArtifactNode=memo(function HtmlArtifactNode({data,selected}:NodeProps){
  const {t}=useTranslation();const projectId=readUrl().project;
  const artifactId=typeof data.artifactId==='string'?data.artifactId:'';
  const [html,setHtml]=useState('');const [error,setError]=useState('');
  useEffect(()=>{
    if(!projectId||!artifactId)return;let alive=true;
    const load=()=>void readHtmlPreview(projectId,artifactId).then(value=>{if(alive){setHtml(value.html);setError('');}}).catch(err=>{if(alive)setError(String(err));});
    const changed=(event:Event)=>{const d=(event as CustomEvent).detail;if(d?.projectId===projectId&&d.artifact?.id===artifactId)load();};
    load();window.addEventListener(HTML_ARTIFACT_UPDATED_EVENT,changed);return()=>{alive=false;window.removeEventListener(HTML_ARTIFACT_UPDATED_EVENT,changed);};
  },[projectId,artifactId]);
  const srcDoc=useMemo(()=>buildHtmlPreview(html,'thumbnail',false),[html]);
  const open=()=>{if(projectId&&artifactId)openHtmlArtifact({projectId,artifactId});};
  return <div className={`w-96 overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg ${selected?'border-primary':'border-border'}`} onDoubleClick={open}>
    <Handle type="target" position={Position.Left}/><Handle type="source" position={Position.Right}/>
    <div className="flex items-center gap-2 border-b border-border p-3 text-sm"><Globe size={16}/><span className="truncate">{String(data.displayName||t('htmlArtifact.webpage'))}</span><span className="ml-auto text-xs text-muted-foreground">HTML</span></div>
    <div className="pointer-events-none h-56 overflow-hidden bg-muted/30">{html?<iframe title={t('htmlArtifact.thumbnail')} sandbox="" referrerPolicy="no-referrer" srcDoc={srcDoc} tabIndex={-1} className="h-[672px] w-[1152px] origin-top-left scale-[0.333333] border-0 bg-white"/>:<p className="p-5 text-xs text-muted-foreground">{error||t('htmlArtifact.empty')}</p>}</div>
    <button className="nodrag flex w-full items-center justify-center gap-2 border-t border-border p-3 text-xs hover:bg-accent disabled:opacity-40" disabled={!artifactId} onClick={open}><ExternalLink size={14}/>{t('htmlArtifact.open')}</button>
  </div>;
});
