// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export function createInFlightRequestCache<Key, Value>(
  load: (key: Key) => Promise<Value>,
) {
  const requests = new Map<Key, Promise<Value>>();

  return (key: Key): Promise<Value> => {
    const existing = requests.get(key);
    if (existing) return existing;

    const request = load(key);
    requests.set(key, request);
    const clear = () => {
      if (requests.get(key) === request) requests.delete(key);
    };
    void request.then(clear, clear);
    return request;
  };
}
