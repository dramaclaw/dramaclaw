import { textModelPresentation } from '@/lib/local-model-catalog';
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, WandSparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { fetchFreezoneTextModels, streamFreezoneH3, formatFreezoneH3Locally } from '@/api/ops';
import { readUrl } from '@/lib/url-params';
import { backendErrorToastMessage } from '@/lib/api-errors';
import { useCanvasStore } from '@/stores/canvasStore';
import type { ReferenceMediaItem } from '@/features/canvas/nodes/VideoNode';
import type { VideoGenMode } from '@/features/canvas/domain/canvasNodes';

interface Props {
  id: string;
  prompt: string;
  genMode: VideoGenMode;
  durationSec: number;
  references: ReferenceMediaItem[];
  upstreamText: string;
  disabled: boolean;
}

/** A format draft is deliberately detached from node generation/recovery state. */
export function H3PromptOptimizer(props: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('local-h3-format');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [source, setSource] = useState('');
  const [validated, setValidated] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const request = useRef(0);
  const snapshot = useRef('');
  const project = readUrl().project;
  const canvas = readUrl().canvas ?? 'default';
  const signature = JSON.stringify([project, canvas, props.id, props.prompt, props.genMode, props.durationSec, props.references, props.upstreamText]);
  const latest = useRef(signature);
  latest.current = signature;
  const hasAudio = props.references.some(r => r.kind === 'audio');
  const textOnlyModel = model !== 'local-h3-format';
  const localMode = model === 'local-h3-format';
  const compatible = useMemo(() => ['local-h3-format', ...models], [models]);

  useEffect(() => () => { request.current += 1; controller.current?.abort(); }, []);
  useEffect(() => {
    if (!open || !project) return;
    let disposed = false;
    setLoadingModels(true);
    void fetchFreezoneTextModels(project).then(catalog => {
      if (disposed) return;
      setModels(catalog.models);
    }).catch(e => { if (!disposed) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!disposed) setLoadingModels(false); });
    return () => { disposed = true; };
  }, [open, project]);
  useEffect(() => {
    if (!compatible.includes(model)) setModel('local-h3-format');
  }, [compatible, model]);

  const close = () => {
    request.current += 1;
    controller.current?.abort();
    setValidated(false);
    setOpen(false);
    setBusy(false);
    setDraft('');
    setError('');
  };

  const convert = async () => {
    if (!project || !model || busy || props.disabled) return;
    const version = ++request.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setValidated(false);
    snapshot.current = signature;
    setSource(props.prompt);
    setDraft('');
    setError('');
    setBusy(true);
    const counts = { image: 0, video: 0, audio: 0 };
    const labels = { image: 'Picture', video: 'Video', audio: 'Audio' };
    const references = props.references.map((r, index) => {
      const label = `<${labels[r.kind]} ${++counts[r.kind]}>`;
      return {
        node_id: r.nodeId,
        text: `${label} = {{Mixed ${index + 1}}}. ${r.displayName ?? ''}${r.kind === 'audio' ? ' (audio label only; no audio analysis)' : ''}`,
        image_url: r.kind === 'image' ? r.imageUrl : undefined,
        video_url: r.kind === 'video' ? r.videoUrl : undefined,
      };
    });
    if (props.upstreamText.trim()) references.push({ node_id: 'upstream-text-context', text: props.upstreamText, image_url: undefined, video_url: undefined });
    try {
      // No nodeId: a preview must not be auto-applied by canvas task recovery.
      const payload = {
        prompt: props.prompt, model, references, canvasId: canvas,
        h3Options: { mode: props.genMode, duration_sec: props.durationSec, reference_order: props.references.map(r => r.kind) },
      };
      const result = await (async () => {
        if (localMode) return formatFreezoneH3Locally(project, payload);
        return streamFreezoneH3(project, payload, text => {
          if (request.current === version && latest.current === snapshot.current) setDraft(text);
        }, abort.signal);
      })();
      if (request.current !== version) return;
      if (latest.current !== snapshot.current) { setError(t('node.h3Format.stale')); return; }
      setDraft(result.generated_text);
      setValidated(true);
    } catch (e) {
      if (request.current === version) setError(backendErrorToastMessage(e, t));
    } finally {
      if (request.current === version) setBusy(false);
    }
  };

  const apply = () => {
    if (!validated || busy) return;
    const state = useCanvasStore.getState();
    const node = state.nodes.find(n => n.id === props.id);
    if (!node || node.data.isGenerating || latest.current !== snapshot.current || String(node.data.prompt ?? '') !== source) {
      setError(t('node.h3Format.stale')); return;
    }
    for (const match of draft.matchAll(/\{\{\s*Mixed\s+(\d+)\s*\}\}/gi)) {
      if (+match[1] < 1 || +match[1] > props.references.length) { setError(t('node.h3Format.invalidReference')); return; }
    }
    state.updateNodeData(props.id, { prompt: draft.trim() });
    close();
  };

  return <>
    <button type="button" title={t('node.h3Format.title')} disabled={props.disabled || !props.prompt.trim()}
      className="nodrag inline-flex h-7 items-center gap-1 rounded px-1 text-xs text-text-dark/72 hover:text-text-dark disabled:opacity-40"
      onClick={e => { e.stopPropagation(); setSource(props.prompt); setOpen(true); }}>
      <WandSparkles className="h-4 w-4" />{t('node.h3Format.title')}
    </button>
    <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
      <DialogContent className="canvas-node-transient-ui nodrag nowheel z-[10001] flex overflow-y-auto max-h-[90vh] flex-col sm:max-w-5xl bg-[var(--ui-surface-modal)] text-text-dark" overlayClassName="z-[10000]"
        onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
        <DialogTitle>{t('node.h3Format.title')}</DialogTitle>
        <DialogDescription>{t('node.h3Format.description')}</DialogDescription>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">{t('node.h3Format.model')}
            <select className="max-w-[min(420px,65vw)] rounded-lg border border-[var(--ui-border-strong)] bg-[var(--ui-surface-field)] p-2 text-text-dark" value={model} disabled={busy || loadingModels} onChange={e => setModel(e.target.value)}>
              {!compatible.length && <option value="">{t('node.h3Format.noModel')}</option>}
              {compatible.map(m => <option key={m} value={m}>{m === 'local-h3-format' ? t('node.h3Format.local') : `${textModelPresentation(m).label} · ${textModelPresentation(m).providerLabel}`}</option>)}
            </select>
          </label>
          <Button disabled={busy || (!localMode && loadingModels) || !model || props.disabled} onClick={() => void convert()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{t(busy ? 'node.h3Format.working' : 'node.h3Format.convert')}
          </Button>
        </div>
        <p className="text-xs text-text-muted">{t(localMode ? 'node.h3Format.localMaterials' : textOnlyModel ? 'node.h3Format.textOnlyMaterials' : 'node.h3Format.materials')}{hasAudio ? ` ${t('node.h3Format.audioNote')}` : ''}</p>
        <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-2">
          <label className="flex min-h-0 flex-col gap-2">{t('node.h3Format.original')}
            <textarea readOnly value={source} className="nowheel ui-scrollbar h-[45vh] min-h-48 resize-none rounded-xl border border-[var(--ui-border-strong)] bg-[var(--ui-surface-field)] p-3 text-sm leading-6" />
          </label>
          <label className="flex min-h-0 flex-col gap-2">{t('node.h3Format.preview')}
            <textarea value={draft} onChange={e => setDraft(e.target.value)} disabled={busy} placeholder={t('node.h3Format.placeholder')}
              className="nowheel ui-scrollbar h-[45vh] min-h-48 resize-none rounded-xl border border-[var(--ui-border-strong)] bg-[var(--ui-surface-field)] p-3 text-sm leading-6" />
          </label>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close}>{t('node.h3Format.discard')}</Button>
          <Button disabled={busy || !validated || !draft.trim() || props.disabled || signature !== snapshot.current} onClick={apply}>{t('node.h3Format.use')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
