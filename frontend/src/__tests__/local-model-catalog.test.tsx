import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { rememberTextModels, textModelAccepts, textModelPresentation, type CatalogModel, type LocalCatalog } from '@/lib/local-model-catalog';
import { LocalModelCatalogPanel } from '@/components/settings/local-model-catalog';

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: apiMock }));

const entry = (provider: string, vision: boolean): CatalogModel => ({
  id: `${provider}::deepseek`, provider, providerLabel: provider === 'ark' ? 'Volcengine · Agent Plan' : 'SiliconFlow',
  upstreamModel: 'deepseek', label: 'DeepSeek', kind: 'text', inputModalities: vision ? ['text', 'image'] : ['text'],
  videoInput: vision ? 'sampled_frames' : 'none', enabled: true, available: true, blockedReason: '', source: 'provider_api',
});

afterEach(() => { rememberTextModels(); cleanup(); });
describe('provider-aware text selections', () => {
  it('distinguishes the same model name from two providers', () => {
    rememberTextModels([entry('ark', true), entry('siliconflow', false)]);
    expect(textModelPresentation('ark::deepseek').providerLabel).toContain('Agent Plan');
    expect(textModelPresentation('siliconflow::deepseek').providerLabel).toBe('SiliconFlow');
  });
  it('uses catalog capabilities to keep media references visible', () => {
    rememberTextModels([entry('ark', true), entry('siliconflow', false)]);
    expect(textModelAccepts('ark::deepseek', 'video')).toBe(true);
    expect(textModelAccepts('ark::deepseek', 'image')).toBe(true);
    expect(textModelAccepts('siliconflow::deepseek', 'image')).toBe(false);
    expect(textModelAccepts('siliconflow::deepseek', 'text')).toBe(true);
  });
  it('preserves legacy selection display when no catalog metadata exists', () => {
    expect(textModelPresentation('deepseek-ai/DeepSeek-V4-Flash').label).toBe('DeepSeek-V4-Flash');
    expect(textModelAccepts('Qwen/Qwen3-VL-32B-Instruct', 'video')).toBe(true);
    expect(textModelAccepts('unknown', 'image')).toBe(false);
  });
});


import { rememberMediaDefault, readMediaDefault } from '@/lib/local-model-catalog';
import { CanvasNodeFactory } from '@/features/canvas/application/nodeFactory';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { NodeCatalog } from '@/features/canvas/application/ports';
it('applies configured defaults to new nodes and preserves explicit selections', () => {
  rememberMediaDefault('video', [{ id: 'siliconflow::video', isDefault: true }]);
  const catalog = { getDefinition: () => ({ createDefaultData: () => ({ model: 'MiniMax-H3' }) }) } as unknown as NodeCatalog;
  const factory = new CanvasNodeFactory({ next: () => 'new-node' }, catalog);
  expect(factory.createNode(CANVAS_NODE_TYPES.video, { x: 0, y: 0 }).data.model).toBe('siliconflow::video');
  expect(factory.createNode(CANVAS_NODE_TYPES.video, { x: 0, y: 0 }, { model: 'MiniMax-H3' }).data.model).toBe('MiniMax-H3');
  rememberMediaDefault('video', []);
  expect(readMediaDefault('video')).toBeUndefined();
});

const settingsCatalog: LocalCatalog = {
  models: [entry('ark', true), entry('siliconflow', false)],
  defaults: { text: 'siliconflow::deepseek' },
  providers: [
    { id: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://provider.example/v1', configured: true, source: 'provider_api', syncedAt: '', error: '', plan: '', catalogDate: '' },
    { id: 'ark', label: 'Volcengine · Agent Plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', configured: true, source: 'official_catalog', syncedAt: '', error: '', plan: 'Medium', catalogDate: '' },
  ],
};

describe('provider settings visibility and recovery', () => {
  beforeEach(() => {
    apiMock.get.mockReset(); apiMock.post.mockReset();
    apiMock.get.mockReturnValue({ json: async () => ({ data: settingsCatalog }) });
    apiMock.post.mockReturnValue({ json: async () => ({ data: settingsCatalog }) });
  });

  it('shows server Base URLs and empty replacement key inputs without expanding details', async () => {
    render(<LocalModelCatalogPanel />);
    await waitFor(() => expect(screen.getByLabelText('SiliconFlow API Key')).toBeEnabled());
    expect(screen.getByLabelText('SiliconFlow Base URL')).toHaveValue('https://provider.example/v1');
    expect(screen.getByLabelText('SiliconFlow Base URL')).toHaveAttribute('readonly');
    const field = screen.getByLabelText('Volcengine · Agent Plan API Key');
    expect(field).toBeVisible();
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveValue('');
    expect(field.closest('details')).toBeNull();
    expect(apiMock.get).toHaveBeenCalledWith('api/v1/model-gateway/local/catalog', { timeout: 10000, retry: 0 });
  });

  it('explains old backends, keeps addresses visible, and restores editing after retry', async () => {
    apiMock.get.mockReturnValueOnce({ json: async () => { throw { response: { status: 404 } }; } });
    render(<LocalModelCatalogPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('404');
    expect(screen.getByRole('alert')).toHaveTextContent('重启');
    expect(screen.getByLabelText('SiliconFlow API Key')).toBeDisabled();
    expect(screen.getByLabelText('SiliconFlow Base URL')).toHaveValue('https://api.siliconflow.cn/v1');
    expect(screen.getAllByText(/内置默认地址/)).toHaveLength(2);
    expect(apiMock.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重新读取配置' }));
    await waitFor(() => expect(screen.getByLabelText('SiliconFlow API Key')).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/内置默认地址/)).toBeNull();
    expect(screen.getByLabelText('SiliconFlow Base URL')).toHaveValue('https://provider.example/v1');
  });

  it('offers retry for unavailable servers without calling it an old backend', async () => {
    apiMock.get.mockReturnValueOnce({ json: async () => { throw new TypeError('Failed to fetch'); } });
    render(<LocalModelCatalogPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('读取模型目录失败');
    expect(screen.getByRole('alert')).not.toHaveTextContent('404');
    expect(screen.getByRole('button', { name: '重新读取配置' })).toBeEnabled();
    expect(screen.getByLabelText('Volcengine · Agent Plan API Key')).toBeDisabled();
  });

  it('saves a replacement to the selected provider, then clears the password input', async () => {
    render(<LocalModelCatalogPanel />);
    const field = screen.getByLabelText('Volcengine · Agent Plan API Key');
    await waitFor(() => expect(field).toBeEnabled());
    fireEvent.change(field, { target: { value: 'test-only-replacement' } });
    fireEvent.submit(field.closest('form')!);
    await waitFor(() => expect(field).toHaveValue(''));
    expect(apiMock.post).toHaveBeenCalledWith('api/v1/model-gateway/local/providers/ark/key', { json: { api_key: 'test-only-replacement' }, timeout: 60000 });
    expect(screen.getByRole('status')).toHaveTextContent('密钥已保存');
    expect(screen.getByLabelText('SiliconFlow API Key')).toHaveValue('');
    expect(screen.queryByText('test-only-replacement')).toBeNull();
  });

  it('keeps a replacement draft on failed save and never claims success', async () => {
    apiMock.post.mockReturnValue({ json: async () => { throw new Error('failed'); } });
    render(<LocalModelCatalogPanel />);
    const field = screen.getByLabelText('SiliconFlow API Key');
    await waitFor(() => expect(field).toBeEnabled());
    fireEvent.change(field, { target: { value: 'test-only-replacement' } });
    fireEvent.submit(field.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('操作失败');
    expect(field).toHaveValue('test-only-replacement');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
