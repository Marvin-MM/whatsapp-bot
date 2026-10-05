import { describe, expect, it } from 'vitest';
import nextConfig, { API_SECURITY_HEADERS } from '../../next.config';
import { BASE_SECURITY_HEADERS, HSTS_VALUE, applyBaseHeaders, buildCsp, createNonce } from '@/lib/security/headers';

const production = { nonce: 'abc123==', development: false, https: true };

function directive(csp: string, name: string): string[] {
  const found = csp.split('; ').find((part) => part === name || part.startsWith(`${name} `));
  return found ? found.split(' ').slice(1) : [];
}

describe('createNonce', () => {
  it('is 128 random bits in base64, different every time', () => {
    const nonces = Array.from({ length: 200 }, createNonce);
    expect(new Set(nonces).size).toBe(200);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
    }
  });
});

describe('buildCsp', () => {
  const csp = buildCsp(production);

  it('runs scripts only with the nonce: no unsafe-inline, no unsafe-eval, no host list', () => {
    expect(directive(csp, 'script-src')).toEqual(["'self'", "'nonce-abc123=='", "'strict-dynamic'"]);
  });

  it('allows styles from files and nonced <style> elements, and inline style ATTRIBUTES only', () => {
    expect(directive(csp, 'style-src')).toEqual(["'self'", "'nonce-abc123=='"]);
    expect(directive(csp, 'style-src-attr')).toEqual(["'unsafe-inline'"]);
    expect(directive(csp, 'style-src-elem')).toEqual([]);
  });

  it('keeps unsafe-inline out of everything except style attributes', () => {
    const offenders = csp.split('; ').filter((part) => part.includes("'unsafe-inline'") && !part.startsWith('style-src-attr'));
    expect(offenders).toEqual([]);
  });

  it('confines everything else to this origin and forbids plugins, framing and base rewriting', () => {
    expect(directive(csp, 'default-src')).toEqual(["'self'"]);
    expect(directive(csp, 'connect-src')).toEqual(["'self'"]);
    expect(directive(csp, 'img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(directive(csp, 'media-src')).toEqual(["'self'"]);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(csp, 'base-uri')).toEqual(["'self'"]);
    expect(directive(csp, 'form-action')).toEqual(["'self'"]);
  });

  it('upgrades insecure requests only when served over https', () => {
    expect(csp).toContain('upgrade-insecure-requests');
    expect(buildCsp({ ...production, https: false })).not.toContain('upgrade-insecure-requests');
  });

  it('allows eval and the dev websocket only in development', () => {
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('ws:');
    const dev = buildCsp({ ...production, development: true });
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(dev, 'connect-src')).toContain('ws:');
  });

  it('carries the nonce exactly where scripts and style elements need it, and nowhere else', () => {
    expect(csp.match(/nonce-abc123==/g)).toHaveLength(2);
  });
});

describe('applyBaseHeaders', () => {
  it('sets the fixed headers without HSTS on http', () => {
    const headers = new Headers();
    applyBaseHeaders(headers, { https: false });
    for (const [name, value] of BASE_SECURITY_HEADERS) expect(headers.get(name)).toBe(value);
    expect(headers.get('strict-transport-security')).toBeNull();
  });

  it('adds HSTS on https', () => {
    const headers = new Headers();
    applyBaseHeaders(headers, { https: true });
    expect(headers.get('strict-transport-security')).toBe(HSTS_VALUE);
    expect(HSTS_VALUE).toMatch(/max-age=\d{8,}/);
  });

  it('matches the literal headers next.config.ts puts on the API (they must not drift apart)', () => {
    expect(API_SECURITY_HEADERS.map((h) => [h.key, h.value])).toEqual(BASE_SECURITY_HEADERS.map(([k, v]) => [k, v]));
  });

  it('is actually attached to the API routes (and only the API: pages get theirs from the proxy)', async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules).toEqual([{ source: '/api/:path*', headers: API_SECURITY_HEADERS }]);
  });
});
