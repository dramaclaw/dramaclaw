import { describe, expect, it } from 'vitest';
import { buildHtmlPreview, isHtmlSelectionMessage } from './preview';

describe('isolated HTML preview', () => {
  it('puts a restrictive policy before untrusted markup and excludes privileged sandbox flags', () => {
    const html = buildHtmlPreview('<html><head></head><body><h1>Hello</h1><script>alert(1)</script></body></html>', 'nonce', true);
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<h1'));
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).not.toContain('allow-same-origin');
  });
  it('removes navigation and base elements while preserving authored inline scripts', () => {
    const html = buildHtmlPreview('<meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test"><script>const x=1</script>', 'nonce', false);
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain('<base');
    expect(html).toContain('const x=1');
  });
  it('accepts only current frame selection messages with bounded element references', () => {
    expect(isHtmlSelectionMessage({type:'html-artifact-selection', token:'a', selector:'body > h1:nth-of-type(1)', text:'Hello'}, 'a')).toBe(true);
    expect(isHtmlSelectionMessage({type:'html-artifact-selection', token:'old', selector:'h1', text:'Hello'}, 'a')).toBe(false);
    expect(isHtmlSelectionMessage({type:'html-artifact-selection', token:'a', selector:'x'.repeat(3000), text:'Hello'}, 'a')).toBe(false);
  });
});
it('blocks authored scripts by default while nonce-authorizing only the selection bridge',()=>{
 const html=buildHtmlPreview('<script>location.href="https://example.com"</script>','safe-token',true);
 expect(html).toContain("script-src 'nonce-safe-token'");
 expect(html).toContain('nonce="safe-token"');
 expect(html).not.toContain("script-src 'unsafe-inline'");
});
it('only enables authored scripts when interactive execution was explicitly selected',()=>{
 expect(buildHtmlPreview('<h1>Hi</h1>','a',false,true)).toContain("script-src 'unsafe-inline'");
});
