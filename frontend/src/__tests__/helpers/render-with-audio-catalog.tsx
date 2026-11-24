// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

export function renderWithAudioCatalog(ui: ReactElement, project = 'demo-project') {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(['freezone-audio-models', project], [
    { id: 'seed', label: 'Seed', model: 'seed-audio-1.0', requiresVoiceId: false },
    { id: 'my-index', label: 'Index', model: 'index-tts-2', requiresVoiceId: false },
  ]);
  return render(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}
