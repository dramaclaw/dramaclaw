// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useState } from 'react';
import type { FreezoneViewMode } from './useFreezoneViewMode';

const CHAT_OPEN_STORAGE_KEY = 'st.freezone.chatOpen';

function loadWorkflowChatOpen(): boolean {
  try {
    return window.localStorage.getItem(CHAT_OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Storyboard auto-opening must not change the user's workflow preference.
 * Compose is a page of its own and always starts with the assistant open, but
 * its closing must not overwrite that same workflow preference either.
 */
export function useFreezoneChatVisibility(
  viewMode: FreezoneViewMode,
  active: boolean,
  compose = false,
): [boolean, (open: boolean) => void] {
  const [state, setState] = useState(() => ({
    viewMode,
    active,
    compose,
    workflowOpen: loadWorkflowChatOpen(),
    boardOpen: true,
    composeOpen: true,
  }));

  // Reconcile before rendering children: returning to workflow must never paint
  // one frame with the storyboard's open state. Each board or compose visit
  // starts open.
  let current = state;
  if (
    state.viewMode !== viewMode ||
    state.active !== active ||
    state.compose !== compose
  ) {
    const enteringBoard = viewMode === 'board'
      && (state.viewMode !== 'board' || (active && !state.active));
    const enteringCompose = compose && (!state.compose || (active && !state.active));
    current = {
      ...state,
      viewMode,
      active,
      compose,
      boardOpen: enteringBoard ? true : state.boardOpen,
      composeOpen: enteringCompose ? true : state.composeOpen,
    };
    setState(current);
  }

  // Stable across view switches so existing event handlers always change the
  // current view, even when they subscribed while another view was selected.
  const setOpen = useCallback((open: boolean) => {
    setState((previous) => {
      const key = previous.compose
        ? 'composeOpen'
        : previous.viewMode === 'board'
          ? 'boardOpen'
          : 'workflowOpen';
      return previous[key] === open ? previous : { ...previous, [key]: open };
    });
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(CHAT_OPEN_STORAGE_KEY, state.workflowOpen ? '1' : '0');
    } catch {
      // Unavailable storage only affects restoring the preference next time.
    }
  }, [state.workflowOpen]);

  return [
    compose ? current.composeOpen : viewMode === 'board' ? current.boardOpen : current.workflowOpen,
    setOpen,
  ];
}
