// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';

const textInputTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

function editableNodeId(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null;
  const editable = target instanceof HTMLTextAreaElement
    || (target instanceof HTMLInputElement && textInputTypes.has(target.type))
    || target.isContentEditable;
  return editable
    ? target.closest<HTMLElement>('.react-flow__node[data-id]')?.dataset.id ?? null
    : null;
}

export function useCanvasTextEditTracking(): void {
  useEffect(() => {
    let editingNodeId: string | null = null;
    const track = (nodeId: string | null) => {
      if (nodeId === editingNodeId) return;
      const store = useCanvasStore.getState();
      if (editingNodeId !== null) store.endNodeFieldEdit(editingNodeId, 'data.*');
      editingNodeId = nodeId;
      if (nodeId !== null) store.beginNodeFieldEdit(nodeId, 'data.*');
    };
    const onFocusIn = (event: FocusEvent) => track(editableNodeId(event.target));
    const onFocusOut = (event: FocusEvent) => {
      if (editableNodeId(event.relatedTarget) !== editingNodeId) track(null);
    };
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    track(editableNodeId(document.activeElement));
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      track(null);
    };
  }, []);
}
