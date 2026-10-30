// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { enTranslation, zhTranslation } from '@/__tests__/helpers/i18n-fixtures';
import { ImageGenerationForm, type ImageGenerationFormProps } from '@/features/canvas/nodes/shared/ImageGenerationForm';
import { NodeIdBadge } from '@/features/canvas/ui/NodeIdBadge';

const updateNodeData = vi.hoisted(() => vi.fn());
vi.mock('@/stores/canvasStore', () => ({
  useCanvasStore: (selector: (state: { updateNodeData: typeof updateNodeData }) => unknown) =>
    selector({ updateNodeData }),
}));
vi.mock('@/features/canvas/ui/ProviderModelPicker', () => ({ ProviderModelPicker: () => null }));
vi.mock('@/features/canvas/ui/MediaModelParameterChip', () => ({ MediaModelParameterChip: () => null }));
vi.mock('@/components/credits/credit-visual', () => ({ CreditCostPill: () => null }));
vi.mock('@/features/canvas/nodes/ContextPromptPaletteButton', () => ({ NodeContextPromptPaletteButton: () => null }));
vi.mock('@/features/canvas/hooks/useFreezoneStyleTemplates', () => ({
  useFreezoneStyleTemplates: () => ({ templates: [], isLoading: false }),
}));
vi.mock('@/features/canvas/nodes/PromptMentionEditor', () => ({
  PromptMentionEditor: ({ value, placeholder }: { value: string; placeholder: string }) =>
    <textarea aria-label="Prompt" value={value} placeholder={placeholder} readOnly />,
}));

function formProps(patch: Partial<ImageGenerationFormProps> = {}): ImageGenerationFormProps {
  return {
    nodeId: 'image-16',
    styleTemplateId: null,
    selectedStyleLabel: null,
    onStylePickerOpenChange: vi.fn(),
    onOpenAssetLibrary: vi.fn(),
    upstreamTextContents: [],
    upstreamImageContents: [],
    onDetachUpstream: vi.fn(),
    prompt: '用户填写的中文提示词不应被改写',
    onPromptChange: vi.fn(),
    onCompositionStart: vi.fn(),
    onCompositionEnd: vi.fn(),
    mentionCandidates: [],
    upstreamTextJoined: '上游中文内容不应被改写',
    modelId: 'example',
    aspectRatio: '16:9',
    size: '2K',
    sizeOptions: ['1K', '2K'],
    aspectOptions: [{ value: 'auto', label: '自适应' }, { value: '16:9', label: '16:9' }],
    quality: 'medium',
    qualityOptions: ['low', 'medium', 'high'],
    showQuality: true,
    modelParameters: undefined,
    modelParams: undefined,
    modelParamsMode: undefined,
    selectedModelReferenceError: null,
    getModelOptionDisabledReason: () => null,
    cameraSelection: null,
    cameraSummary: null,
    showCountSelect: true,
    count: 1,
    isTranslatingPrompt: false,
    isGenerating: false,
    onTranslate: vi.fn(),
    totalCreditCostDisplay: null,
    creditPromotion: null,
    submitDisabled: false,
    onSubmit: vi.fn(),
    ...patch,
  };
}

async function mount(props = formProps()) {
  const i18n = createInstance();
  await i18n.init({
    lng: 'en',
    fallbackLng: 'zh',
    resources: { en: { translation: enTranslation }, zh: { translation: zhTranslation } },
    interpolation: { escapeValue: false },
  });
  render(
    <I18nextProvider i18n={i18n}>
      <ImageGenerationForm {...props} />
      <NodeIdBadge nodeId="image-16" />
    </I18nextProvider>,
  );
  return i18n;
}

describe('image node form localization', () => {
  it('renders English controls and switches language without rewriting the prompt', async () => {
    const i18n = await mount();
    expect(screen.getByRole('button', { name: 'Style' })).toBeInTheDocument();
    expect(screen.getByText('Asset library')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Camera' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
    expect(screen.getByTitle('Copy node ID')).toHaveTextContent('Node ID');
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveAttribute(
      'placeholder', 'Upstream content is wired in — add more prompt detail…',
    );
    expect(screen.getByTitle('Translate prompt (Chinese ↔ English)')).toBeInTheDocument();

    await act(async () => { await i18n.changeLanguage('zh'); });
    expect(screen.getByRole('button', { name: '风格' })).toBeInTheDocument();
    expect(screen.getByText('资产库')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '摄像机' })).toBeInTheDocument();
    expect(screen.getByTitle('复制节点 ID')).toHaveTextContent('节点 ID');
    expect(screen.getByRole('textbox', { name: 'Prompt' })).toHaveValue('用户填写的中文提示词不应被改写');
  });

  it('localizes quality, aspect, count and style popovers without changing submitted values', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: /16:9.*Standard.*2K/ }));
    expect(screen.getByText('Quality')).toBeInTheDocument();
    expect(screen.getByText('Resolution')).toBeInTheDocument();
    expect(screen.getByText('Aspect ratio')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'High' }));
    expect(updateNodeData).toHaveBeenCalledWith('image-16', { quality: 'high' });
    fireEvent.click(screen.getByRole('button', { name: '×1' }));
    fireEvent.click(screen.getByRole('button', { name: '×2' }));
    expect(updateNodeData).toHaveBeenCalledWith('image-16', { count: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Style' }));
    expect(screen.getByText('No style templates yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('preserves model-specific quality labels instead of showing an untranslated key', async () => {
    await mount(formProps({ quality: 'Ultra', qualityOptions: ['Ultra'] }));
    expect(screen.getByRole('button', { name: /16:9.*Ultra.*2K/ })).toBeInTheDocument();
  });
});
