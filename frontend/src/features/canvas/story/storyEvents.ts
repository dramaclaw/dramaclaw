/** Host pages can subscribe without giving the player credentials or a network endpoint. */
export function emitStoryEvent(type: string, detail: Record<string, unknown> = {}) {
  window.dispatchEvent(new CustomEvent('dramaclaw:story', {
    detail: { type, timestamp: Date.now(), ...detail },
  }));
}

export function safeCtaUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
