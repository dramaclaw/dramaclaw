// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { useCanvasTextEditTracking } from '@/features/freezone/canvasTextEditTracking';

const edits = () => useCanvasStore.getState().editingNodeFields;
const editingN1 = [{ nodeId: 'n1', field: 'data.*' }];

function CanvasTextEditors({ inputType = 'text' }: { inputType?: string }) {
  useCanvasTextEditTracking();
  return <>
    <div className="react-flow__node" data-id="n1" data-testid="node">
      <textarea aria-label="Text" />
      <input aria-label="Node input" type={inputType} />
      <div contentEditable data-testid="editor"><span data-testid="editor-child" /></div>
      <button>Action</button>
    </div>
    <div className="react-flow__node" data-id="n2"><textarea aria-label="Other text" /></div>
    <input aria-label="Outside input" />
  </>;
}

beforeEach(() => { useCanvasStore.getState().setCanvasData([], []); });

describe('canvas text edit tracking', () => {
  it('tracks focused textarea once and clears the edit on blur', () => {
    const view = render(<CanvasTextEditors />);
    const textarea = view.getByLabelText('Text');
    act(() => textarea.focus());
    expect(edits()).toEqual(editingN1);
    fireEvent.focusIn(textarea);
    expect(edits()).toEqual(editingN1);
    act(() => textarea.blur());
    expect(edits()).toEqual([]);
  });

  it.each(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])(
    'tracks a %s input inside a node', inputType => {
      const view = render(<CanvasTextEditors inputType={inputType} />);
      act(() => view.getByLabelText('Node input').focus());
      expect(edits()).toEqual(editingN1);
    },
  );

  it.each(['checkbox', 'radio', 'range', 'button', 'color', 'file'])(
    'ignores a %s input', inputType => {
      const view = render(<CanvasTextEditors inputType={inputType} />);
      act(() => view.getByLabelText('Node input').focus());
      expect(edits()).toEqual([]);
    },
  );

  it('ignores an input outside any node', () => {
    const view = render(<CanvasTextEditors />);
    act(() => view.getByLabelText('Outside input').focus());
    expect(edits()).toEqual([]);
  });

  it('keeps one edit while moving between editors in the same node', () => {
    const view = render(<CanvasTextEditors />);
    act(() => view.getByLabelText('Text').focus());
    const activeEdits = edits();
    act(() => view.getByLabelText('Node input').focus());
    expect(edits()).toBe(activeEdits);
  });

  it('moves the edit when focus enters another node', () => {
    const view = render(<CanvasTextEditors />);
    act(() => view.getByLabelText('Text').focus());
    act(() => view.getByLabelText('Other text').focus());
    expect(edits()).toEqual([{ nodeId: 'n2', field: 'data.*' }]);
  });

  it('ends editing when focus moves to a non-editor in the same node', () => {
    const view = render(<CanvasTextEditors />);
    act(() => view.getByLabelText('Text').focus());
    act(() => view.getByRole('button', { name: 'Action' }).focus());
    expect(edits()).toEqual([]);
  });

  it('tracks contenteditable focus including descendants', () => {
    const view = render(<CanvasTextEditors />);
    const editor = view.getByTestId('editor');
    const child = view.getByTestId('editor-child');
    // jsdom does not implement the browser's inherited isContentEditable property.
    Object.defineProperty(editor, 'isContentEditable', { value: true });
    Object.defineProperty(child, 'isContentEditable', { value: true });
    fireEvent.focusIn(editor);
    const activeEdits = edits();
    expect(activeEdits).toEqual(editingN1);
    fireEvent.focusOut(editor, { relatedTarget: child });
    fireEvent.focusIn(child);
    expect(edits()).toBe(activeEdits);
    fireEvent.focusOut(child, { relatedTarget: view.getByLabelText('Outside input') });
    expect(edits()).toEqual([]);
  });

  it('clears an open edit and removes listeners on unmount', () => {
    const view = render(<CanvasTextEditors />);
    const textarea = view.getByLabelText('Text');
    const node = view.getByTestId('node');
    act(() => textarea.focus());
    expect(edits()).toEqual(editingN1);
    view.unmount();
    expect(edits()).toEqual([]);
    document.body.append(node);
    act(() => textarea.focus());
    expect(edits()).toEqual([]);
    node.remove();
  });
});
