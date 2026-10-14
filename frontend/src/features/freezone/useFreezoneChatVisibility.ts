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

/** Storyboard auto-opening must not change the user's workflow preference. */
export function useFreezoneChatVisibility(
  viewMode: FreezoneViewMode,
  active: boolean,
): [boolean, (open: boolean) => void] {
  const [state, setState] = useState(() => ({
    viewMode,
    active,
    workflowOpen: loadWorkflowChatOpen(),
    boardOpen: true,
  }));

  // Reconcile before rendering children: returning to workflow must never paint
  // one frame with the storyboard's open state. Each board visit starts open.
  let current = state;
  if (state.viewMode !== viewMode || state.active !== active) {
    const enteringBoard = viewMode === 'board'
      && (state.viewMode !== 'board' || (active && !state.active));
    current = {
      ...state,
      viewMode,
      active,
      boardOpen: enteringBoard ? true : state.boardOpen,
    };
    setState(current);
  }

  // Stable across view switches so existing event handlers always change the
  // current view, even when they subscribed while another view was selected.
  const setOpen = useCallback((open: boolean) => {
    setState((previous) => {
      const key = previous.viewMode === 'board' ? 'boardOpen' : 'workflowOpen';
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

  return [viewMode === 'board' ? current.boardOpen : current.workflowOpen, setOpen];
}
