// Keep the browser's active IME text local until the user commits a candidate.
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CompositionEvent } from "react";

export function useCompositionSafeText(value: string, onCommit: (next: string) => void) {
  const [draft, setDraft] = useState(value);
  const isComposingRef = useRef(false);
  const lastCommittedValueRef = useRef(value);

  useEffect(() => {
    lastCommittedValueRef.current = value;
    if (!isComposingRef.current) setDraft(value);
  }, [value]);

  const commit = useCallback((next: string) => {
    // 部分浏览器会在 compositionend 后补发 change；去重避免重复写历史记录。
    if (next === lastCommittedValueRef.current) return;
    lastCommittedValueRef.current = next;
    onCommit(next);
  }, [onCommit]);

  return {
    value: draft,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const next = event.target.value;
      setDraft(next);
      if (!isComposingRef.current) commit(next);
    },
    onCompositionStart: () => {
      isComposingRef.current = true;
    },
    onCompositionEnd: (event: CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      isComposingRef.current = false;
      const next = event.currentTarget.value;
      setDraft(next);
      commit(next);
    },
  };
}
