// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentAutosave } from '@/features/director/useDocumentAutosave';
import { ApiError } from '@/api/client';
import { commitManualDocument, type DirectorDocument } from '@/api/director';

vi.mock('@/api/director', async () => ({ ...await vi.importActual('@/api/director'), commitManualDocument: vi.fn() }));
const initial: Required<DirectorDocument> = { doc_key: 'characters', document_id: 'doc-one', version: 1, content: 'Original.', origin: 'user', created_at: 1, content_hash: 'test-hash', semantic_input_hash: 'test-input', schema_version: 1 };
const props = { project: 'synthetic', workId: 'work-one', workRevision: 2, initial, currentVersion: 1, blocked: false, enabled: true, onSaved: vi.fn() };
const reply = (text: string, version: number) => ({ workRevision: version + 1, document: { ...initial, version, content: text } });
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('versioned Director autosave', () => {
  it('does not write on open and coalesces edits after one idle second', async () => {
    vi.mocked(commitManualDocument).mockResolvedValue(reply('Final 😀', 2));
    const { result } = renderHook(() => useDocumentAutosave(props));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(commitManualDocument).not.toHaveBeenCalled();
    act(() => result.current.edit('First'));
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    act(() => result.current.edit('Final 😀'));
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(commitManualDocument).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(commitManualDocument).toHaveBeenCalledOnce();
    expect(vi.mocked(commitManualDocument).mock.calls[0][1]).toMatchObject({ expected: { workRevision: 2, documentVersions: { 'doc-one': 1 } }, payload: { text: 'Final 😀' } });
    expect(result.current.status).toBe('saved');
    expect(sessionStorage.length).toBe(0);
  });
  it('serializes in-flight edits using acknowledged versions without losing newer typing', async () => {
    let resolve!: (value: ReturnType<typeof reply>) => void;
    vi.mocked(commitManualDocument).mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValueOnce(reply('Second', 3));
    const { result } = renderHook(() => useDocumentAutosave(props));
    act(() => result.current.edit('First'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    act(() => result.current.edit('Second'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(commitManualDocument).toHaveBeenCalledOnce();
    await act(async () => resolve(reply('First', 2)));
    expect(commitManualDocument).toHaveBeenCalledTimes(2);
    expect(vi.mocked(commitManualDocument).mock.calls[1][1]).toMatchObject({ expected: { workRevision: 3, documentVersions: { 'doc-one': 2 } }, payload: { text: 'Second' } });
    expect(result.current.text).toBe('Second');
    expect(result.current.baseline.version).toBe(3);
  });
  it('retains the original intent across lost response, refresh and further edits', async () => {
    vi.mocked(commitManualDocument).mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(reply('First', 2)).mockResolvedValueOnce(reply('Second', 3));
    const first = renderHook(() => useDocumentAutosave(props));
    act(() => first.result.current.edit('First'));
    await act(async () => { await first.result.current.flush(); });
    const original = vi.mocked(commitManualDocument).mock.calls[0][1];
    expect(first.result.current.status).toBe('failed');
    first.unmount();
    const restored = renderHook(() => useDocumentAutosave({ ...props, initial: reply('First', 2).document, currentVersion: 2, workRevision: 3 }));
    expect(restored.result.current.status).toBe('recovered');
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(commitManualDocument).toHaveBeenCalledOnce();
    act(() => restored.result.current.edit('Second'));
    await act(async () => { await restored.result.current.flush(); });
    expect(vi.mocked(commitManualDocument).mock.calls[1][1]).toEqual(original);
    expect(vi.mocked(commitManualDocument).mock.calls[2][1].commandId).not.toBe(original.commandId);
    expect(restored.result.current.status).toBe('saved');
  });
  it('does not silently rebase onto an external version', async () => {
    const { result, rerender } = renderHook(options => useDocumentAutosave(options), { initialProps: props });
    act(() => result.current.edit('My retained edit'));
    rerender({ ...props, currentVersion: 2, workRevision: 3 });
    await act(async () => { expect(await result.current.flush()).toBe(false); });
    expect(commitManualDocument).not.toHaveBeenCalled();
    expect(result.current.status).toBe('conflict');
    expect(result.current.text).toBe('My retained edit');
  });
  it('does not retry a conflict or network error on each keystroke', async () => {
    vi.mocked(commitManualDocument).mockRejectedValue(new ApiError('VERSION_CONFLICT', 409));
    const { result } = renderHook(() => useDocumentAutosave(props));
    act(() => result.current.edit('First'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    act(() => result.current.edit('Second'));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(commitManualDocument).toHaveBeenCalledOnce();
    expect(result.current.status).toBe('conflict');
  });
  it('waits for IME/read-only blocks and flushes before a navigation request', async () => {
    vi.mocked(commitManualDocument).mockResolvedValue(reply('中文', 2));
    const { result, rerender } = renderHook(options => useDocumentAutosave(options), { initialProps: { ...props, blocked: true } });
    act(() => result.current.edit('中文'));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); expect(await result.current.flush()).toBe(false); });
    expect(commitManualDocument).not.toHaveBeenCalled();
    rerender({ ...props, blocked: false });
    await act(async () => { expect(await result.current.flush()).toBe(true); });
    expect(result.current.savedVersion()).toBe(2);
  });
  it('namespaces recovery by project, work and document', () => {
    const one = renderHook(() => useDocumentAutosave(props));
    act(() => one.result.current.edit('Private text'));
    const other = renderHook(() => useDocumentAutosave({ ...props, workId: 'work-two' }));
    expect(other.result.current.text).toBe(initial.content);
  });
  it('explicitly loads the server version after a conflict without overwriting it', async () => {
    vi.mocked(commitManualDocument).mockRejectedValueOnce(new ApiError('VERSION_CONFLICT', 409));
    const { result } = renderHook(() => useDocumentAutosave(props));
    act(() => result.current.edit('Backed-up local text'));
    await act(async () => { await result.current.flush(); });
    act(() => { expect(result.current.loadServerVersion(reply('Someone else wrote this', 2).document, 3)).toBe(true); });
    expect(result.current.text).toBe('Someone else wrote this');
    expect(result.current.status).toBe('saved');
    expect(result.current.dirty).toBe(false);
    expect(commitManualDocument).toHaveBeenCalledOnce();
  });
  it('does not abandon an unknown write to load a newer server baseline', async () => {
    vi.mocked(commitManualDocument).mockRejectedValueOnce(new Error('lost response'));
    const { result } = renderHook(() => useDocumentAutosave(props));
    act(() => result.current.edit('Unknown write'));
    await act(async () => { await result.current.flush(); });
    act(() => { expect(result.current.loadServerVersion(reply('Unknown write', 2).document, 3)).toBe(false); });
    expect(result.current.status).toBe('failed');
    expect(result.current.dirty).toBe(true);
  });
});
