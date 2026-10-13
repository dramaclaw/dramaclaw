// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasEventBus, CanvasEventMap } from './ports';

export class InMemoryCanvasEventBus implements CanvasEventBus {
  private readonly listeners = new Map<keyof CanvasEventMap, Set<(payload: unknown) => void>>();

  publish<TType extends keyof CanvasEventMap>(
    type: TType,
    payload: CanvasEventMap[TType]
  ): number {
    const handlers = this.listeners.get(type);
    if (!handlers) {
      return 0;
    }

    for (const handler of handlers) {
      handler(payload);
    }
    return handlers.size;
  }

  subscribe<TType extends keyof CanvasEventMap>(
    type: TType,
    handler: (payload: CanvasEventMap[TType]) => void
  ): () => void {
    const handlers = this.listeners.get(type) ?? new Set<(payload: unknown) => void>();
    handlers.add(handler as (payload: unknown) => void);
    this.listeners.set(type, handlers);

    return () => {
      const currentHandlers = this.listeners.get(type);
      if (!currentHandlers) {
        return;
      }

      currentHandlers.delete(handler as (payload: unknown) => void);
      if (currentHandlers.size === 0) {
        this.listeners.delete(type);
      }
    };
  }
}
