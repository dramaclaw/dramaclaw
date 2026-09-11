import { useNodeBodyVariant } from '@/features/canvas/hooks/useNodeBodyVariantBudget';
import { captureFreezoneCanvasScope } from '@/features/freezone/canvasSyncRuntime';
import { ReferenceTextChip } from '@/features/canvas/nodes/shared/ReferenceTextChip';
import { buildHtmlReferences, HTML_REFERENCE_PREFIXES } from './references';
import { PromptMentionEditor, type PromptMentionEditorHandle } from '@/features/canvas/nodes/PromptMentionEditor';
import { useReferenceMentionSync } from '@/features/canvas/nodes/useReferenceMentionSync';
import { ReferenceDetachButton } from '@/features/canvas/nodes/shared/ReferenceDetachButton';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { isExecutionDependencyEdge } from '@/features/canvas/nodes/referenceOrdering';
import { memo, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ArrowUp, Globe, Loader2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { readUrl } from '@/lib/url-params';
import { HTML_ARTIFACT_UPDATED_EVENT, openHtmlArtifact, readHtmlPreview, createHtmlArtifact, exportHtmlArtifact } from './api';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { canvasNodeFrameClass, CANVAS_NODE_INPUT_SURFACE_CLASS, CANVAS_NODE_INPUT_BODY_FRAME_CLASS, CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS, CANVAS_NODE_OPS_PANEL_CLASS, CANVAS_NODE_INPUT_PLACEHOLDER_CLASS } from '@/features/canvas/ui/nodeFrameStyles';
import { buildHtmlPreview } from './preview';
import { NODE_REFERENCE_MEDIA_CHIP_CLASS, NODE_REFERENCE_MEDIA_DETACH_CLASS, NODE_GENERATE_BUTTON_BASE_CLASS, NODE_GENERATE_BUTTON_ENABLED_CLASS, NODE_GENERATE_BUTTON_DISABLED_CLASS } from '@/features/canvas/ui/nodeControlStyles';
import { useCanvasStore } from '@/stores/canvasStore';
import { executeWorkflowHtmlNode, attachSavedArtifact } from '@/features/canvas/application/workflowHtmlRuntime';
import { subscribeNodeAction, publishNodeActionAccepted, publishNodeActionSuccess, publishNodeActionError } from '@/features/canvas/application/nodeActionResult';
import { useUpstreamNodes } from '@/features/canvas/application/useUpstreamGraph';
import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';
import { CreditCostInline } from '@/components/credit-cost-inline';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { useModelTaskAccess } from '@/lib/model-task-access';
import { BillingRuleNotConfiguredError } from '@/lib/api-errors';
import { useNodeGenerationHistory } from '@/features/canvas/hooks/useNodeGenerationHistory';
import {
  hasCompletedHistoryRecords,
  historyRecordHtmlIdentity,
  NodeGenerationHistory,
} from '@/features/canvas/ui/NodeGenerationHistory';

export const HtmlArtifactNode=memo(function HtmlArtifactNode({id,data,selected}:NodeProps){
  const {t}=useTranslation();const projectId=readUrl().project;
  const artifactId=typeof data.artifactId==='string'?data.artifactId:'';
  const version=typeof data.artifactVersion==='number'&&data.artifactVersion>0?data.artifactVersion:undefined;
  const canGenerate = true;
  const modelTaskAccess = useModelTaskAccess();
  const catalog = data.workflowCatalog as {recipeId?: unknown} | undefined;
  const hasRecipe = typeof catalog?.recipeId === 'string' && !!catalog.recipeId.trim();
  // Match the text node's estimate; the backend settles against actual output length.
  const estimatedChars = String(data.prompt ?? '').replace(/[\s\u3000]+/gu, '').length;
  const generationCost = useGenerationCreditCost('feature', selected && !hasRecipe ? 'freezone.text_generate' : null, {
    surface: 'canvas', quantity: estimatedChars,
    params: {operation: 'text_generate', billable_chars: estimatedChars, pricing_quantity: estimatedChars},
  });
  const billingRuleMissing = !hasRecipe && generationCost.error instanceof BillingRuleNotConfiguredError;
  const costDisplay = hasRecipe ? null : generationCost.data?.data.display ?? (billingRuleMissing ? t('common.billingRuleNotConfiguredShort') : null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [historyPreviewVersion, setHistoryPreviewVersion] = useState<number | null>(null);
  const {
    records: historyRecords,
    isLoading: historyLoading,
    refresh: refreshHistory,
  } = useNodeGenerationHistory(id, {enabled: Boolean(selected)});
  const upstreamNodes = useUpstreamNodes(id);
  const references = useMemo(() => buildHtmlReferences(upstreamNodes), [upstreamNodes]);
  const promptEditorRef = useRef<PromptMentionEditorHandle>(null);
  const updatePrompt = useCallback((prompt: string) => useCanvasStore.getState().updateNodeData(id, {prompt}), [id]);
  useReferenceMentionSync(String(data.prompt ?? ''), HTML_REFERENCE_PREFIXES.map(prefix => ({prefix, ids: references.filter(item => item.prefix === prefix).map(item => item.nodeId)})), updatePrompt);
  const candidates = references.map(item => ({key: item.nodeId, name: item.mention, index: item.index, displayName: item.name,
    imageUrl: item.prefix === '图片' && item.url ? resolveImageDisplayUrl(item.url) : '', // i18n-exempt -- canonical @mention protocol token
    videoUrl: item.prefix === '视频' && item.url ? resolveImageDisplayUrl(item.url) : undefined, // i18n-exempt -- canonical @mention protocol token
    audioUrl: item.prefix === '音频' && item.url ? resolveImageDisplayUrl(item.url) : undefined})); // i18n-exempt -- canonical @mention protocol token
  const detach = (nodeId: string) => {
    const store = useCanvasStore.getState();
    store.edges.filter(edge => edge.source === nodeId && edge.target === id && !isExecutionDependencyEdge(edge)).forEach(edge => store.deleteEdge(edge.id));
  };

  const isGenerating = data.isGenerating === true || isUploading;
  const generationError = typeof data.generationError === 'string' ? data.generationError : '';
  const generationPhase = typeof data.htmlGenerationPhase === 'string' ? data.htmlGenerationPhase : '';
  const submitLabel = isGenerating
    ? 'htmlArtifact.generating'
    : generationPhase === 'save_failed' || generationPhase === 'conflict'
      ? 'htmlArtifact.retrySave'
      : generationError
        ? 'htmlArtifact.retry'
        : artifactId
          ? 'htmlArtifact.regenerate'
          : 'htmlArtifact.generate';
  const submitDisabled = isGenerating || !String(data.prompt ?? '').trim() || modelTaskAccess.blocked || billingRuleMissing;
  const run = useCallback(async () => {
    if (modelTaskAccess.blocked) throw new Error(modelTaskAccess.message || t('modelTaskAccess.blocked.generic'));
    if (billingRuleMissing) throw new Error(t('common.billingRuleNotConfiguredShort'));
    const scope = readUrl();
    if (!scope.project || !scope.canvas) throw new Error(t('htmlArtifact.activeCanvasRequired'));
    return executeWorkflowHtmlNode(id, scope.project, scope.canvas).then((result) => {
      void refreshHistory();
      return result;
    });
  }, [id, t, modelTaskAccess.blocked, modelTaskAccess.message, billingRuleMissing, refreshHistory]);
  const open = useCallback(() => {
    if (!projectId || !artifactId) throw new Error(t('htmlArtifact.empty'));
    openHtmlArtifact({projectId,artifactId,version,nodeId:id});
  }, [artifactId, id, projectId, t, version]);
  useEffect(() => subscribeNodeAction(({nodeId, action, requestId}) => {
    if (nodeId !== id || !['generate_html','open','export','upload'].includes(action)) return;
    publishNodeActionAccepted(requestId, id, action);
    const execution = action === 'generate_html'
      ? run()
      : action === 'open'
        ? Promise.resolve().then(() => {open(); return {opened:true};})
        : action === 'export'
          ? projectId && artifactId && version
            ? exportHtmlArtifact(projectId,artifactId,version).then(() => ({download_started:true,version}))
            : Promise.reject(new Error(t('htmlArtifact.empty')))
          : Promise.resolve().then(() => {
              if (!uploadInput.current) throw new Error(t('htmlArtifact.empty'));
              uploadInput.current.click();
              return {picker_opened:true};
            });
    void execution
      .then(output => publishNodeActionSuccess(requestId, id, action, {...output}))
      .catch(error => publishNodeActionError(requestId, id, action, error));
  }), [artifactId, id, open, projectId, run, t, version]);
  const submit = () => { if (!submitDisabled) void run().catch(() => undefined); };
  const selectHistory = useCallback((record: Parameters<typeof historyRecordHtmlIdentity>[0]) => {
    const identity = historyRecordHtmlIdentity(record);
    if (!identity || identity.artifactId !== artifactId) return;
    if (isGenerating) {
      setHistoryPreviewVersion(identity.version);
      return;
    }
    setHistoryPreviewVersion(null);
    useCanvasStore.getState().updateNodeData(id, {
      artifactVersion: identity.version,
      htmlSelectionToken: `${Date.now()}:${identity.version}`,
      generationError: null,
    });
  }, [artifactId, id, isGenerating]);
  useEffect(() => {
    if (!isGenerating) setHistoryPreviewVersion(null);
  }, [isGenerating]);
  const mediaVariant=useNodeBodyVariant({width:384,height:224});
  const [media,setMedia]=useState<Array<{placeholder:string;url:string}>>([]);
  const [html,setHtml]=useState('');const [error,setError]=useState('');
  useEffect(()=>{
    if(!projectId||!artifactId){setHtml('');setMedia([]);setError('');return;}let alive=true;let release:(()=>void)|undefined;
    const load=()=>void readHtmlPreview(projectId,artifactId,historyPreviewVersion ?? version,mediaVariant).then(value=>{if(alive){release?.();release=value.release;setHtml(value.html);setMedia(value.media??[]);setError('');}else value.release?.();}).catch(err=>{if(alive)setError(String(err));});
    const changed=(event:Event)=>{const d=(event as CustomEvent).detail;if(d?.projectId===projectId&&d.artifact?.id===artifactId)load();};
    load();const refresh=window.setInterval(load,12*60*1000);window.addEventListener('focus',load);window.addEventListener(HTML_ARTIFACT_UPDATED_EVENT,changed);return()=>{alive=false;window.clearInterval(refresh);window.removeEventListener('focus',load);release?.();window.removeEventListener(HTML_ARTIFACT_UPDATED_EVENT,changed);};
  },[projectId,artifactId,version,historyPreviewVersion,mediaVariant]);
  const uploadHtml = async (file: File) => {
    const scope = readUrl();
    if (!scope.project || !scope.canvas) return;
    const current = captureFreezoneCanvasScope(scope.project, scope.canvas);
    setIsUploading(true);setError('');
    try {
      if (!/\.html?$/i.test(file.name)) throw new Error(t('htmlArtifact.invalidFile'));
      if (file.size > 2 * 1024 * 1024) throw new Error(t('htmlArtifact.fileTooLarge'));
      const source = await file.text();
      if (!/<html[\s>]/i.test(source) || !/<\/html\s*>/i.test(source)) throw new Error(t('htmlArtifact.invalidFile'));
      const artifact = await createHtmlArtifact(scope.project, file.name.replace(/\.html?$/i,''), source);
      await attachSavedArtifact(artifact, id, scope.project, scope.canvas, current);
    } catch (err) {setError(err instanceof Error ? err.message : String(err));}
    finally {setIsUploading(false);if(uploadInput.current) uploadInput.current.value='';}
  };
  const thumbnailChannel=useMemo(()=>crypto.randomUUID(),[html,artifactId,version]);
  const srcDoc=useMemo(()=>buildHtmlPreview(html,thumbnailChannel,false,false,media,true),[html,thumbnailChannel,media]);
  return <div className={`group relative w-96 overflow-visible rounded-[var(--node-radius)] border ${!html ? (selected ? CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS : CANVAS_NODE_INPUT_BODY_FRAME_CLASS) : canvasNodeFrameClass({selected})}`} onDoubleClick={open}>
    {selected && !artifactId && <>
      <input ref={uploadInput} type="file" accept=".html,.htm,text/html" className="hidden" onChange={event => {const file=event.target.files?.[0];if(file) void uploadHtml(file);}}/>
      <button type="button" disabled={isGenerating} className={`nodrag absolute left-[calc(100%+8px)] top-0 flex items-center gap-1.5 whitespace-nowrap rounded-[12px] px-3 py-2 text-xs text-text-dark ${CANVAS_NODE_OPS_PANEL_CLASS}`} onClick={event => {event.stopPropagation();uploadInput.current?.click();}}>
        <Upload className="h-3.5 w-3.5"/>{t('htmlArtifact.upload')}
      </button>
    </>}
    <Handle id="target" type="target" position={Position.Left}/><Handle id="source" type="source" position={Position.Right}/>
    <NodeHeader className={NODE_HEADER_FLOATING_POSITION_CLASS} icon={<Globe className="h-4 w-4"/>} titleText={String(data.displayName||t('htmlArtifact.webpage'))} titleClassName="inline-block max-w-[220px] truncate whitespace-nowrap align-bottom" rightSlot={<span className="rounded-md border border-border bg-background/80 px-2 py-0.5 text-xs text-muted-foreground">HTML</span>}/>

    <div className={`pointer-events-none h-56 overflow-hidden rounded-[var(--node-radius)] ${html ? 'bg-background' : CANVAS_NODE_INPUT_SURFACE_CLASS}`}>{html?<iframe title={t('htmlArtifact.thumbnail')} sandbox="allow-scripts" onLoad={event=>event.currentTarget.contentWindow?.postMessage({type:'html-artifact-media',token:thumbnailChannel,media},'*')} referrerPolicy="no-referrer" srcDoc={srcDoc} tabIndex={-1} className="h-[672px] w-[1152px] origin-top-left scale-[0.333333] border-0 bg-white"/>:<div className="flex h-full items-center justify-center gap-8 px-8">{error ? <p className="text-xs text-destructive">{error}</p> : <><div className="flex-1 text-sm leading-6 text-text-muted">{t(canGenerate ? 'htmlArtifact.readyToGenerate' : 'htmlArtifact.empty')}</div><Globe className="h-9 w-9 shrink-0 text-text-muted/46"/></>}</div>}</div>
    {isGenerating && <NodeGenerationOverlay startedAt={typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null}/>}
    {generationPhase === 'saving' && <p role="status" className="px-3 py-2 text-xs text-text-muted">{t('htmlArtifact.saving')}</p>}
    {generationError && <p role="alert" className="px-3 py-2 text-xs text-destructive">{generationError}</p>}
    {selected && canGenerate && <div className={`nodrag nowheel absolute left-1/2 top-[calc(100%+12px)] z-[300] flex h-[288px] w-[720px] -translate-x-1/2 flex-col rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS}`} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      {candidates.length > 0 && <div aria-label={t('htmlArtifact.references')} className="ui-scrollbar flex shrink-0 items-center gap-2 overflow-x-auto px-3 pt-3">
        {candidates.map(candidate => candidate.name.startsWith('文本') ? <div key={candidate.key} className="relative shrink-0"> {/* i18n-exempt -- canonical @mention protocol token */}
          <ReferenceTextChip nodeId={candidate.key} text={references.find(item => item.nodeId === candidate.key)?.text ?? ''} sourceLabel={candidate.displayName ?? undefined} onDetach={nodeId => {if (!isGenerating) detach(nodeId);}}/>
        </div> : <div key={candidate.key} title={candidate.displayName} className={NODE_REFERENCE_MEDIA_CHIP_CLASS}>
          {candidate.imageUrl ? <img src={candidate.imageUrl} alt="" className="h-full w-full object-cover" draggable={false}/> : candidate.videoUrl ? <video src={candidate.videoUrl} muted preload="metadata" className="h-full w-full object-cover"/> : <span className="text-xs text-text-muted">{candidate.name.replace(/\d+$/, '')}</span>}
          {!isGenerating && <>
            <ReferenceDetachButton nodeId={candidate.key} onDetach={detach} className={NODE_REFERENCE_MEDIA_DETACH_CLASS}/>
          </>}
        </div>)}
      </div>}
      <div className={`min-h-0 flex-1 ${isGenerating ? 'pointer-events-none opacity-60' : ''}`} inert={isGenerating || undefined}>
        <PromptMentionEditor ref={promptEditorRef} value={String(data.prompt ?? '')} onChange={updatePrompt} candidates={candidates}
          placeholder={t('htmlArtifact.generationPrompt')}
          className={`ui-scrollbar nodrag nowheel h-full w-full overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent px-3 py-2 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
          onKeyDown={event => event.stopPropagation()}/>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 px-3 py-2">
      <CreditCostInline display={costDisplay} promotion={hasRecipe ? null : generationCost.data?.data.promotion}/>
      <button type="button" className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${submitDisabled ? NODE_GENERATE_BUTTON_DISABLED_CLASS : NODE_GENERATE_BUTTON_ENABLED_CLASS}`} disabled={submitDisabled} onClick={submit}
        aria-label={t(submitLabel)}
        title={modelTaskAccess.message || (billingRuleMissing ? t('common.billingRuleNotConfiguredShort') : t(submitLabel))}>
        {isGenerating ? <Loader2 className="h-4 w-4 animate-spin"/> : <ArrowUp className="h-4 w-4"/>}
      </button>
      </div>
    </div>}
    {selected && hasCompletedHistoryRecords(historyRecords) && <div className={`nodrag absolute left-1/2 top-[calc(100%+312px)] z-[300] w-[720px] -translate-x-1/2 rounded-[var(--node-radius)] px-3 py-2 ${CANVAS_NODE_OPS_PANEL_CLASS}`} onClick={event=>event.stopPropagation()}>
      <NodeGenerationHistory
        records={historyRecords}
        isLoading={historyLoading}
        onRestore={selectHistory}
        onRefresh={()=>void refreshHistory()}
        isActive={record=>{
          const identity=historyRecordHtmlIdentity(record);
          return identity?.artifactId===artifactId&&identity.version===(historyPreviewVersion??version);
        }}
      />
    </div>}
  </div>;
});
