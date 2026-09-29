// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** `PrevizSelect` 的面板挂在 body 上，选项靠 `data-value` 认，与原生 `<option value>` 一一对应。 */
function openOptions(): HTMLElement[] {
  return screen.queryAllByRole('option');
}

/** 替代 `user.selectOptions`：点开下拉，按值点中那一项。 */
export async function pickOption(user: UserEvent, trigger: HTMLElement, value: string): Promise<void> {
  await user.click(trigger);
  const option = await waitFor(() => {
    const found = openOptions().find((element) => element.dataset.value === value);
    if (!found) throw new Error(`option ${value} not found`);
    return found;
  });
  await user.click(option);
}

/** 点开下拉读出全部选项，再按 Esc 收起。 */
async function readOptions(user: UserEvent, trigger: HTMLElement): Promise<HTMLElement[]> {
  await user.click(trigger);
  const options = await waitFor(() => {
    const found = openOptions();
    if (found.length === 0) throw new Error('no options');
    return found;
  });
  await user.keyboard('{Escape}');
  return options;
}

export async function optionValues(user: UserEvent, trigger: HTMLElement): Promise<string[]> {
  return (await readOptions(user, trigger)).map((option) => option.dataset.value ?? '');
}

export async function optionLabels(user: UserEvent, trigger: HTMLElement): Promise<string[]> {
  return (await readOptions(user, trigger)).map((option) => option.textContent ?? '');
}
