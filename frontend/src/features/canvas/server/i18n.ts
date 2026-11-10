// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createInstance } from 'i18next';
import zh from '../../../../public/locales/zh/translation.json';
import en from '../../../../public/locales/en/translation.json';
import vi from '../../../../public/locales/vi/translation.json';
import pt from '../../../../public/locales/pt/translation.json';
import { normalize } from '@/i18n/languages';
import type { CanvasEnvironment } from '../core/environment';

export async function createServerTranslate(locale?: string): Promise<CanvasEnvironment['translate']> {
  const instance = createInstance();
  await instance.init({
    lng: normalize(locale),
    fallbackLng: 'zh',
    initAsync: false,
    interpolation: { escapeValue: false },
    resources: { zh: { translation: zh }, en: { translation: en }, vi: { translation: vi }, pt: { translation: pt } },
  });
  return (key, options) => instance.t(key, options);
}
