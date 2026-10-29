// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PrevizSelect } from '@/features/previz/ui/PrevizSelect';

const OPTIONS = [
  { value: 'ff', label: '全画幅' },
  { value: 's35', label: 'Super 35' },
] as const;

describe('PrevizSelect', () => {
  it('shows the current label and commits a picked option', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PrevizSelect aria-label="画幅" value="ff" options={OPTIONS} onChange={onChange} />);

    const trigger = screen.getByRole('combobox', { name: '画幅' });
    expect(trigger).toHaveTextContent('全画幅');
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'Super 35' }));
    expect(onChange).toHaveBeenCalledWith('s35');
  });

  it('keeps the placeholder in an action menu after a pick', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PrevizSelect aria-label="切到" placeholder="切到…" value={null} options={OPTIONS} onChange={onChange} />,
    );

    const trigger = screen.getByRole('combobox', { name: '切到' });
    expect(trigger).toHaveTextContent('切到…');
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: '全画幅' }));
    expect(onChange).toHaveBeenCalledWith('ff');
    expect(trigger).toHaveTextContent('切到…');
  });
});
