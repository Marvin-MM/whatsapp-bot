import { vi } from 'vitest';
import type { CapturedRequest, GroqHandler } from './groq';

export const MEDIA_HOST = 'https://lookaside.fbsbx.com';

export interface NetworkRoutes {
  /** `GET https://graph.facebook.com/{version}/{media-id}` */
  graphInfo?: (mediaId: string) => Response | Promise<Response>;
  /** `GET https://lookaside.fbsbx.com/...` (the file itself) */
  download?: (url: string) => Response | Promise<Response>;
  /** `POST https://graph.facebook.com/{version}/{phone-number-id}/messages`: may throw to simulate a network error. */
  graphSend?: (request: SentRequest, index: number) => Response | Promise<Response>;
  /** `GET https://graph.facebook.com/{version}/{waba-id}/message_templates` (any page: the handler sees the full URL). */
  graphTemplates?: (url: URL) => Response | Promise<Response>;
  /** `POST https://api.telegram.org/bot<token>/sendMessage` */
  telegram?: (request: TelegramRequest, index: number) => Response | Promise<Response>;
  /** Anything under https://api.groq.com/ */
  groq?: GroqHandler;
}

export interface TelegramRequest {
  url: string;
  body: Record<string, unknown>;
}

export interface SentRequest {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

export interface NetworkCalls {
  graph: string[];
  /** Every Telegram sendMessage call. */
  telegram: TelegramRequest[];
  /** Every GET of the template list, as the full URL. */
  templates: string[];
  /** Every POST to the send endpoint, in order. */
  sends: SentRequest[];
  download: string[];
  groq: CapturedRequest[];
}

/**
 * Stubs global fetch for everything the media pipeline talks to (Meta Graph, Meta's CDN, Groq): the network layer is the
 * only thing mocked. Any other host is a test bug and throws instead of leaving the machine.
 */
export function stubNetwork(routes: NetworkRoutes): NetworkCalls {
  const calls: NetworkCalls = { graph: [], sends: [], templates: [], telegram: [], download: [], groq: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://api.telegram.org/')) {
        const request: TelegramRequest = { url, body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown> };
        calls.telegram.push(request);
        if (!routes.telegram) throw new Error('no telegram route in this test');
        return routes.telegram(request, calls.telegram.length - 1);
      }
      if (url.startsWith('https://graph.facebook.com/') && init?.method === 'POST' && new URL(url).pathname.endsWith('/messages')) {
        const headers: Record<string, string> = {};
        new Headers(init.headers).forEach((value, key) => (headers[key] = value));
        const payload = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;
        const request: SentRequest = { url, headers, payload };
        calls.sends.push(request);
        if (!routes.graphSend) throw new Error('no graphSend route in this test');
        return routes.graphSend(request, calls.sends.length - 1);
      }
      if (url.startsWith('https://graph.facebook.com/') && new URL(url).pathname.endsWith('/message_templates')) {
        calls.templates.push(url);
        if (!routes.graphTemplates) throw new Error('no graphTemplates route in this test');
        return routes.graphTemplates(new URL(url));
      }
      if (url.startsWith('https://graph.facebook.com/')) {
        const id = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
        calls.graph.push(id);
        if (!routes.graphInfo) throw new Error('no graphInfo route in this test');
        return routes.graphInfo(id);
      }
      if (url.startsWith(MEDIA_HOST)) {
        calls.download.push(url);
        if (!routes.download) throw new Error('no download route in this test');
        return routes.download(url);
      }
      if (url.startsWith('https://api.groq.com/')) {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
        let body: Record<string, unknown> | null = null;
        let formFields: Record<string, string> | null = null;
        if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
        else if (init?.body instanceof FormData) {
          formFields = {};
          for (const [key, value] of init.body.entries()) formFields[key] = typeof value === 'string' ? value : `[file ${value.size} bytes]`;
        }
        const captured: CapturedRequest = { url, path: new URL(url).pathname, body, headers, formFields };
        calls.groq.push(captured);
        if (!routes.groq) throw new Error('no groq route in this test');
        return routes.groq(captured, calls.groq.length - 1);
      }
      throw new Error(`unexpected network call in test: ${url}`);
    }),
  );
  return calls;
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
