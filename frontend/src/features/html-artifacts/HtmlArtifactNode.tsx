import { memo, useEffect, useMemo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { readUrl } from '@/lib/url-params';
import { HTML_ARTIFACT_UPDATED_EVENT, openHtmlArtifact, readHtmlPreview } from './api';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { canvasNodeFrameClass } from '@/features/canvas/ui/nodeFrameStyles';
import { buildHtmlPreview } from './preview';

export const HtmlArtifactNode=memo(function HtmlArtifactNode({id,data,selected}:NodeProps){
  const {t}=useTranslation();const projectId=readUrl().project;
  const artifactId=typeof data.artifactId==='string'?data.artifactId:'';
  const version=typeof data.artifactVersion==='number'&&data.artifactVersion>0?data.artifactVersion:undefined;
  const [media,setMedia]=useState<Array<{placeholder:string;blob:Blob}>>([]);
  const [html,setHtml]=useState('');const [error,setError]=useState('');
  useEffect(()=>{
    if(!projectId||!artifactId)return;let alive=true;let release:(()=>void)|undefined;
    const load=()=>void readHtmlPreview(projectId,artifactId,version).then(value=>{if(alive){release?.();release=value.release;setHtml(value.html);setMedia(value.media??[]);setError('');}else value.release?.();}).catch(err=>{if(alive)setError(String(err));});
    const changed=(event:Event)=>{const d=(event as CustomEvent).detail;if(d?.projectId===projectId&&d.artifact?.id===artifactId)load();};
    load();window.addEventListener(HTML_ARTIFACT_UPDATED_EVENT,changed);return()=>{alive=false;release?.();window.removeEventListener(HTML_ARTIFACT_UPDATED_EVENT,changed);};
  },[projectId,artifactId,version]);
  const thumbnailChannel='thumbnail';
  const srcDoc=useMemo(()=>buildHtmlPreview(html,thumbnailChannel,false),[html]);
  const open=()=>{if(projectId&&artifactId)openHtmlArtifact({projectId,artifactId,version,nodeId:id});};
  return <div className={`group relative w-96 overflow-visible rounded-[var(--node-radius)] border ${canvasNodeFrameClass({selected})}`} onDoubleClick={open}>
    <Handle type="target" position={Position.Left}/><Handle type="source" position={Position.Right}/>
    <NodeHeader className={NODE_HEADER_FLOATING_POSITION_CLASS} icon={<Globe className="h-4 w-4"/>} titleText={String(data.displayName||t('htmlArtifact.webpage'))} titleClassName="inline-block max-w-[220px] truncate whitespace-nowrap align-bottom" rightSlot={<span className="rounded-md border border-border bg-background/80 px-2 py-0.5 text-xs text-muted-foreground">HTML</span>}/>

    <div className="pointer-events-none h-56 overflow-hidden rounded-[var(--node-radius)] bg-background">{html?<iframe title={t('htmlArtifact.thumbnail')} sandbox="allow-scripts" onLoad={event=>event.currentTarget.contentWindow?.postMessage({type:'html-artifact-media',token:thumbnailChannel,media},'*')} referrerPolicy="no-referrer" srcDoc={srcDoc} tabIndex={-1} className="h-[672px] w-[1152px] origin-top-left scale-[0.333333] border-0 bg-white"/>:<p className="p-5 text-xs text-muted-foreground">{error||t('htmlArtifact.empty')}</p>}</div>

  </div>;
});
