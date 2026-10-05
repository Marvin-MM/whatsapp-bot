import 'server-only';
import { z } from 'zod';
import { getEnv } from '@/lib/env';

/**
 * The Graph API client. Phase 1 needs only media retrieval; the send path (Phase 2) adds its calls here.
 * `fetch` is resolved at call time (never captured at import) so tests can stub it at the network layer.
 */

export const GRAPH_ORIGIN = 'https://graph.facebook.com';
const INFO_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Graph error codes that mean "slow down / try again" rather than "this will never work". */
const RETRYABLE_GRAPH_CODES: ReadonlySet<number> = new Set([1, 2, 4, 17, 32, 613, 80007, 130429, 131056]);

export type GraphFailure =
  /** The media no longer exists (Meta keeps it for ~30 days). Retrying will never help. */
  | 'gone'
  /** The token is rejected. Retrying only helps after the owner fixes it, so this raises an alert. */
  | 'auth'
  /** Rate limit, 5xx, network or timeout: try again later. */
  | 'retryable'
  /** Anything else: our request is wrong or the file is unacceptable. */
  | 'permanent';

export class GraphError extends Error {
  constructor(
    message: string,
    readonly failure: GraphFailure,
    readonly status: number | null = null,
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

const graphErrorBody = z.looseObject({
  error: z.looseObject({ code: z.number().optional(), message: z.string().optional(), error_subcode: z.number().optional() }).optional(),
});

async function failureFromResponse(response: Response, what: string): Promise<GraphError> {
  let code: number | null = null;
  try {
    const parsed = graphErrorBody.safeParse(await response.json());
    code = parsed.success ? (parsed.data.error?.code ?? null) : null;
  } catch {
    // Not JSON (a CDN error page, an empty body): the status alone decides.
  }
  const status = response.status;
  const failure: GraphFailure =
    status === 404 || status === 410 || (status === 400 && code === 100)
      ? 'gone'
      : status === 401 || status === 403 || code === 190
        ? 'auth'
        : status === 429 || status >= 500 || (code !== null && RETRYABLE_GRAPH_CODES.has(code))
          ? 'retryable'
          : 'permanent';
  return new GraphError(`${what} failed with HTTP ${status}`, failure, status, code);
}

function networkFailure(error: unknown, what: string): GraphError {
  const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  return new GraphError(timedOut ? `${what} timed out` : `${what} could not reach Meta`, 'retryable');
}

const MEDIA_ID = /^[A-Za-z0-9_-]{1,128}$/;

const mediaInfoSchema = z.looseObject({
  url: z.string(),
  mime_type: z.string().optional(),
  sha256: z.string().optional(),
  file_size: z.union([z.number(), z.string()]).optional(),
});

export interface MediaInfo {
  url: string;
  mimeType: string | null;
  sha256: string | null;
  fileSize: number | null;
}

/**
 * Only https to a public host. The URL comes out of a Graph response, so it is trusted about as far as Meta is, and we still
 * will not fetch `http:`, a bare IP, localhost or an internal name with our access token attached.
 */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GraphError('media url is not a url', 'permanent');
  }
  const host = url.hostname.toLowerCase();
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (url.protocol !== 'https:' || host === 'localhost' || isIpLiteral || !host.includes('.') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new GraphError('media url is not a public https url', 'permanent');
  }
  return url;
}

/** `GET /{media-id}`: where to download a file and what Meta says it is. */
export async function getMediaInfo(mediaId: string): Promise<MediaInfo> {
  if (!MEDIA_ID.test(mediaId)) throw new GraphError('media id has an unexpected shape', 'permanent');
  const env = getEnv();
  let response: Response;
  try {
    response = await globalThis.fetch(`${GRAPH_ORIGIN}/${env.META_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkFailure(error, 'media lookup');
  }
  if (!response.ok) throw await failureFromResponse(response, 'media lookup');

  const parsed = mediaInfoSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new GraphError('media lookup returned an unexpected body', 'permanent', response.status);
  assertPublicHttpsUrl(parsed.data.url);
  const size = parsed.data.file_size === undefined ? null : Number(parsed.data.file_size);
  return {
    url: parsed.data.url,
    mimeType: parsed.data.mime_type ?? null,
    sha256: parsed.data.sha256 ?? null,
    fileSize: size !== null && Number.isFinite(size) && size >= 0 ? size : null,
  };
}

export interface DownloadedMedia {
  bytes: Uint8Array;
  contentType: string | null;
}

/** Reads a response body but refuses to hold more than `max` bytes: a lying Content-Length cannot exhaust memory. */
async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    return whole.byteLength > max ? null : whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Downloads the file behind a media URL (the token is required here too), capped at `maxBytes`. */
export async function downloadMedia(url: string, maxBytes: number): Promise<DownloadedMedia> {
  assertPublicHttpsUrl(url);
  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      headers: { Authorization: `Bearer ${getEnv().WHATSAPP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw networkFailure(error, 'media download');
  }
  if (!response.ok) throw await failureFromResponse(response, 'media download');

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new GraphError('media is larger than the allowed size', 'permanent', response.status);
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(response, maxBytes);
  } catch (error) {
    throw networkFailure(error, 'media download');
  }
  if (bytes === null) throw new GraphError('media is larger than the allowed size', 'permanent', response.status);
  return { bytes, contentType: response.headers.get('content-type') };
}
