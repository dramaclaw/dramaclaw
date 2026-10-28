// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectXiahuaMenu } from '@/components/layout/project-header-navigation';
import { FREEZONE_VIEW_MODE_KEY, resetFreezoneViewMode, useFreezoneViewMode } from '@/features/freezone/useFreezoneViewMode';

const location = vi.hoisted(() => ({ pathname: '/projects/demo/freezone' }));
vi.mock('@tanstack/react-router', () => ({
  Link: () => null,
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: { location: typeof location }) => unknown }) => select({ location }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => ({
    'freezone.viewMode.label': '画布视图切换',
    'freezone.viewMode.workflow': '工作流',
    'freezone.viewMode.board': '故事板',
  })[key] ?? key }),
}));

function Workspace() {
  const [mode, setMode] = useFreezoneViewMode();
  return <><output data-testid="view">{mode}</output><button onClick={() => setMode('workflow')}>定位到工作流</button></>;
}

describe('project canvas view menu', () => {
  beforeEach(() => {
    location.pathname = '/projects/demo/freezone';
    const { unmount } = render(<Workspace />);
    act(() => fireEvent.click(screen.getByText('定位到工作流')));
    unmount();
    localStorage.clear();
  });

  it('shares the selected view with the workspace and persists it', () => {
    render(<><ProjectXiahuaMenu /><Workspace /></>);
    fireEvent.click(screen.getByRole('tab', { name: '故事板' }));
    expect(screen.getByTestId('view')).toHaveTextContent('board');
    expect(screen.getByRole('tab', { name: '故事板' })).toHaveAttribute('aria-selected', 'true');
    expect(localStorage.getItem(FREEZONE_VIEW_MODE_KEY)).toBe('board');

    fireEvent.click(screen.getByText('定位到工作流'));
    expect(screen.getByRole('tab', { name: '工作流' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('view')).toHaveTextContent('workflow');
  });

  it('resets the live menu, workspace and stored mode on project-folder entry', () => {
    render(<><ProjectXiahuaMenu /><Workspace /></>);
    fireEvent.click(screen.getByRole('tab', { name: '故事板' }));
    expect(screen.getByTestId('view')).toHaveTextContent('board');
    act(() => resetFreezoneViewMode());
    expect(screen.getByTestId('view')).toHaveTextContent('workflow');
    expect(screen.getByRole('tab', { name: '工作流' })).toHaveAttribute('aria-selected', 'true');
    expect(localStorage.getItem(FREEZONE_VIEW_MODE_KEY)).toBe('workflow');
  });

  it('supports keyboard selection and only appears under XiaHua', () => {
    const { rerender } = render(<ProjectXiahuaMenu />);
    const workflow = screen.getByRole('tab', { name: '工作流' });
    workflow.focus();
    fireEvent.keyDown(workflow, { key: 'End' });
    const board = screen.getByRole('tab', { name: '故事板' });
    expect(board).toHaveFocus();
    expect(board).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(board, { key: 'ArrowLeft' });
    expect(workflow).toHaveFocus();
    expect(workflow).toHaveAttribute('aria-selected', 'true');

    location.pathname = '/projects/demo/ingest';
    rerender(<ProjectXiahuaMenu />);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });
});
