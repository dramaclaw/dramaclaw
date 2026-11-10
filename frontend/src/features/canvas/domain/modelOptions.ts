// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { MediaModelRequestSchema } from '@/api/ops';

import {
  FALLBACK_IMAGE_ASPECT_OPTIONS,
  FALLBACK_IMAGE_SIZE_OPTIONS,
  FALLBACK_VIDEO_ASPECT_OPTIONS,
} from './mediaModelOptions';

export type ProviderId =
  | 'newapi'
  | 'huimeng'
  | 'openrouter'
  | 'openai'
  | 'seedance'
  | 'minimax'
  | 'eleven'
  | 'mureka';

export interface ProviderOption {
  id: ProviderId;
  label: string;
}

export interface ModelOption {
  catalogId?: string;
  id: string;
  providerId: ProviderId;
  apiModel: string;
  label: string;
  resolutionOptions?: string[];
  qualityOptions?: string[];
  humanReview?: boolean;
  supportsGenerateAudio?: boolean;
  minDuration?: number | null;
  maxDuration?: number | null;
  sceneOptimizeOptions?: Array<'anime' | 'realistic'>;
  defaultSceneOptimize?: 'anime' | 'realistic' | null;
  ratioOptions?: string[];
  supportedModes?: string[];
  referenceImageMax?: number | null;
  referenceVideoMax?: number | null;
  referenceAudioMax?: number | null;
  referenceFileMax?: number | null;
  referenceLinkMax?: number | null;
  referenceFileTypes?: string[];
  referenceAudioMinSeconds?: number | null;
  referenceAudioMaxSeconds?: number | null;
  referenceAudioTotalMinSeconds?: number | null;
  /** Total reference audio limit in seconds. */
  referenceAudioTotalMaxSeconds?: number | null;
  referenceVideoMinSeconds?: number | null;
  referenceVideoMaxSeconds?: number | null;
  referenceVideoTotalMinSeconds?: number | null;
  referenceVideoTotalMaxSeconds?: number | null;
  request?: MediaModelRequestSchema;
}

// Provider brands do not follow the interface language.
// i18n-exempt-start
export const SHARED_PROVIDERS: ProviderOption[] = [
  { id: 'newapi', label: 'DramaClawAPI' },
  { id: 'huimeng', label: '绘梦 / HuiMeng' },
// i18n-exempt-end
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai', label: 'OpenAI' },
];

// Used when the image catalog cannot be loaded.
export const SHARED_MODELS: ModelOption[] = [
  {
    id: 'newapi_gpt_image2',
    providerId: 'newapi',
    apiModel: 'newapi_gpt_image2',
    label: 'LingShan-G2',
  },
  {
    id: 'newapi_nanobanana2',
    providerId: 'newapi',
    apiModel: 'newapi_nanobanana2',
    label: 'LingShan-NB-2',
  },
  {
    id: 'huimeng/gpt-image-2',
    providerId: 'huimeng',
    apiModel: 'huimeng_gpt_image2',
    label: 'LingShan-G2',
    resolutionOptions: [...FALLBACK_IMAGE_SIZE_OPTIONS],
    ratioOptions: [...FALLBACK_IMAGE_ASPECT_OPTIONS],
  },
  {
    id: 'openrouter/gemini-2.5-flash-image',
    providerId: 'openrouter',
    apiModel: 'google/gemini-2.5-flash-image-preview',
    label: 'Gemini 2.5 Flash Image',
    resolutionOptions: [...FALLBACK_IMAGE_SIZE_OPTIONS],
    ratioOptions: [...FALLBACK_IMAGE_ASPECT_OPTIONS],
  },
  {
    id: 'openai/gpt-image-2',
    providerId: 'openai',
    apiModel: 'gpt-image-2',
    label: 'GPT Image 2',
    resolutionOptions: [...FALLBACK_IMAGE_SIZE_OPTIONS],
    ratioOptions: [...FALLBACK_IMAGE_ASPECT_OPTIONS],
    qualityOptions: ['low', 'medium', 'high'],
  },
];

export const DEFAULT_UPSCALE_MODEL_ID = 'newapi_gpt_image2';

// Video generation models. `id` is the raw backend model id sent to
// /freezone/video/gen so we don't need a separate apiModel mapping.
export const VIDEO_PROVIDERS: ProviderOption[] = [
  { id: 'seedance', label: 'Seedance' },
  { id: 'huimeng', label: '绘梦 / HuiMeng' }, // i18n-exempt -- provider brand
];

// Used when the video catalog cannot be loaded.
export const VIDEO_MODELS: ModelOption[] = [
  {
    id: 'newapi_seedance-2.0-fast',
    providerId: 'seedance',
    apiModel: 'newapi_seedance-2.0-fast',
    label: 'Seedance2.0 Fast',
    resolutionOptions: ['480p', '720p'],
    ratioOptions: [...FALLBACK_VIDEO_ASPECT_OPTIONS],
    minDuration: 4,
    maxDuration: 15,
  },
  {
    id: 'newapi_seedance-2.0',
    providerId: 'seedance',
    apiModel: 'newapi_seedance-2.0',
    label: 'Seedance2.0',
    resolutionOptions: ['480p', '720p', '1080p'],
    ratioOptions: [...FALLBACK_VIDEO_ASPECT_OPTIONS],
    minDuration: 4,
    maxDuration: 15,
  },
  {
    id: 'newapi_seedance-2.0-value',
    providerId: 'seedance',
    apiModel: 'newapi_seedance-2.0-value',
    label: 'Seedance2.0 Value',
    resolutionOptions: ['720p', '1080p'],
    ratioOptions: [...FALLBACK_VIDEO_ASPECT_OPTIONS],
    minDuration: 4,
    maxDuration: 15,
    sceneOptimizeOptions: ['anime', 'realistic'],
    defaultSceneOptimize: 'anime',
  },
  {
    id: 'newapi_seedance-2.0-fast-value',
    providerId: 'seedance',
    apiModel: 'newapi_seedance-2.0-fast-value',
    label: 'Seedance2.0 Fast Value',
    resolutionOptions: ['720p', '1080p'],
    ratioOptions: [...FALLBACK_VIDEO_ASPECT_OPTIONS],
    minDuration: 4,
    maxDuration: 15,
    sceneOptimizeOptions: ['anime', 'realistic'],
    defaultSceneOptimize: 'realistic',
  },
  {
    id: 'newapi_seedance-1.5-pro',
    providerId: 'seedance',
    apiModel: 'newapi_seedance-1.5-pro',
    label: 'Seedance1.5 Pro',
    ratioOptions: [...FALLBACK_VIDEO_ASPECT_OPTIONS],
    minDuration: 4,
    maxDuration: 12,
  },
  {
    id: 'newapi_seedance-1.0-pro-fast',
    providerId: 'seedance',
    apiModel: 'newapi_seedance-1.0-pro-fast',
    label: 'Seedance1.0 Pro Fast',
    ratioOptions: [...FALLBACK_VIDEO_ASPECT_OPTIONS],
    minDuration: 2,
    maxDuration: 12,
  },
];

export type ProviderModelDomain = 'image' | 'video';

