/** Generated code runs in an opaque-origin iframe, never in the application DOM. */
export function buildHtmlPreview(html: string, token: string, selecting: boolean, interactive = false): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('base, meta[http-equiv]').forEach((element) => element.remove());
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  const scripts = interactive ? "'unsafe-inline'" : `'nonce-${token}'`;
  policy.content = `default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
  doc.head.prepend(policy);
  const bridge = doc.createElement('script');
  bridge.setAttribute('nonce',token);
  // The bridge reports untrusted descriptive context only, never commands or source changes.
  bridge.textContent = `(() => {
    const selecting = ${JSON.stringify(selecting)};
    const mediaUrls = [];
    window.addEventListener('message', event => {
      const data = event.data;
      if (event.source !== parent || data?.type !== 'html-artifact-media' || data.token !== ${JSON.stringify(token)} || !Array.isArray(data.media)) return;
      for (const item of data.media) {
        if (!/^html-media-[a-f0-9]{64}$/.test(item.placeholder) || !(item.blob instanceof Blob)) continue;
        const url = URL.createObjectURL(item.blob); mediaUrls.push(url);
        for (const element of document.querySelectorAll('*')) {
          for (const attr of [...element.attributes]) {
            if (['src','poster','style'].includes(attr.name) && attr.value.includes(item.placeholder)) element.setAttribute(attr.name, attr.value.split(item.placeholder).join(url));
          }
          if (element.tagName === 'STYLE') element.textContent = (element.textContent || '').split(item.placeholder).join(url);
        }
      }
      for (const video of document.querySelectorAll('video,audio')) video.load();
    });
    window.addEventListener('pagehide', () => mediaUrls.forEach(url => URL.revokeObjectURL(url)));

    document.addEventListener('click', (event) => {
      const el = event.target instanceof Element ? event.target : null;
      if (!el) return;
      if (selecting || el.closest('a,form')) { event.preventDefault(); event.stopImmediatePropagation(); }
      if (!selecting) return;
      const path = []; let current = el;
      while (current && current !== document.documentElement && path.length < 16) {
        const tag = current.tagName.toLowerCase();
        const siblings = current.parentElement ? [...current.parentElement.children].filter(x => x.tagName === current.tagName) : [current];
        path.unshift(tag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'); current = current.parentElement;
      }
      parent.postMessage({type:'html-artifact-selection',token:${JSON.stringify(token)},selector:path.join(' > ').slice(0,2048),text:(el.textContent || '').slice(0,1000)}, '*');
    }, true);
    document.addEventListener('submit', event => event.preventDefault(), true);
    if (selecting) { const style = document.createElement('style'); style.textContent = 'body *:hover{outline:2px solid #00bdcf!important;cursor:crosshair!important}'; document.head.append(style); }
  })();`;
  doc.head.insertBefore(bridge, policy.nextSibling);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

export type HtmlSelection = { type: 'html-artifact-selection'; token: string; selector: string; text: string };
export function isHtmlSelectionMessage(value: unknown, token: string): value is HtmlSelection {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return data.type === 'html-artifact-selection' && data.token === token
    && typeof data.selector === 'string' && data.selector.length > 0 && data.selector.length <= 2048
    && typeof data.text === 'string' && data.text.length <= 1000;
}
