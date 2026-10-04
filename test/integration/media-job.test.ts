import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiProviderError } from '@/lib/ai/errors';
import { resetModelProvider } from '@/lib/ai/models';
import { UNRELIABLE_LABEL } from '@/lib/ai/transcribe';
import { downloadMediaForMessage } from '@/lib/ingest/media-job';
import { GraphError } from '@/lib/whatsapp/client';
import { apiError, transcription } from '../helpers/groq';
import { count, ingestFixture, NOW, setupIngestHarness } from '../helpers/ingest';
import { MEDIA_HOST, jsonResponse, stubNetwork } from '../helpers/network';

const h = setupIngestHarness();
const sql = () => h.admin();

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'wab-media-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  resetModelProvider();
  await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), 'wab-media-'));
});

const IMAGE = new Uint8Array(2048).map((_, i) => i % 251);
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const base64 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('base64');

type Row = {
  id: string;
  wamid: string;
  type: string;
  content: string | null;
  content_source: string | null;
  media_id: string | null;
  media_path: string | null;
  media_mime: string | null;
  transcription_status: string | null;
  deleted_at: Date | null;
};
const rowOf = async (wamid: string) => (await sql()<Row[]>`SELECT * FROM messages WHERE wamid = ${wamid}`)[0] as Row;
const run = (id: string, finalAttempt = false) => downloadMediaForMessage(id, { finalAttempt, root, now: NOW });
const filesUnder = async (): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(path.slice(root.length + 1));
    }
  };
  await walk(root);
  return out;
};

/** The usual happy network for one image. */
const imageNetwork = (overrides: { mime?: string; sha256?: string; fileSize?: number; bytes?: Uint8Array } = {}) => {
  const bytes = overrides.bytes ?? IMAGE;
  return stubNetwork({
    graphInfo: () =>
      jsonResponse({ id: 'MEDIA_IMG_1', url: `${MEDIA_HOST}/file/1`, mime_type: overrides.mime ?? 'image/jpeg', sha256: overrides.sha256 ?? hex(bytes), file_size: overrides.fileSize ?? bytes.byteLength }),
    download: () => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/jpeg' } }),
  });
};

async function ingestImage(): Promise<Row> {
  await ingestFixture('image-caption');
  return rowOf('wamid.IN.IMG.1');
}

describe('downloading an image', () => {
  it('stores it under a path made only of our own values, records the verified type, and tells the dashboard', async () => {
    const message = await ingestImage();
    const calls = imageNetwork();

    expect(await run(message.id)).toBe('stored');

    const stored = await rowOf('wamid.IN.IMG.1');
    expect(stored.media_path).toBe(`2026/10/${message.id}.jpg`);
    expect(stored.media_mime).toBe('image/jpeg');
    expect(await filesUnder()).toEqual([`2026/10/${message.id}.jpg`]);
    expect(new Uint8Array(await readFile(join(root, stored.media_path ?? '')))).toEqual(IMAGE);
    expect(calls.graph).toEqual(['MEDIA_IMG_1']);
    expect(calls.download).toHaveLength(1);
    expect((await h.events()).some((event) => event.type === 'conversation:updated')).toBe(true);
    // The caption (what the customer wrote) is untouched by a successful download.
    expect(stored.content).toBe('This one?');
  });

  it('writes with restrictive permissions and leaves no temp files behind', async () => {
    const message = await ingestImage();
    imageNetwork();
    await run(message.id);
    const [path] = await filesUnder();
    expect((await stat(join(root, path ?? ''))).mode & 0o777).toBe(0o640);
    expect((await filesUnder()).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('is idempotent: running it again changes nothing and fetches nothing', async () => {
    const message = await ingestImage();
    const calls = imageNetwork();
    await run(message.id);
    expect(await run(message.id)).toBe('already_stored');
    expect(calls.graph).toHaveLength(1);
    expect(calls.download).toHaveLength(1);
    expect(await filesUnder()).toHaveLength(1);
  });

  it('accepts the hash in base64 as well as hex (Meta is inconsistent)', async () => {
    const message = await ingestImage();
    imageNetwork({ sha256: base64(IMAGE) });
    expect(await run(message.id)).toBe('stored');
  });

  it('two workers racing on the same message end with one file and one database update', async () => {
    const message = await ingestImage();
    imageNetwork();
    const outcomes = await Promise.all([run(message.id), run(message.id)]);
    expect(outcomes.filter((outcome) => outcome === 'stored')).toHaveLength(1);
    expect(await filesUnder()).toEqual([`2026/10/${message.id}.jpg`]);
  });
});

describe('a file we will not keep', () => {
  it('REJECTS bytes that do not match the hash Meta reported: retried first, then given up on visibly', async () => {
    const message = await ingestImage();
    imageNetwork({ sha256: 'f'.repeat(64) });

    await expect(run(message.id, false)).rejects.toMatchObject({ failure: 'retryable' });
    expect(await filesUnder()).toEqual([]);
    expect((await rowOf('wamid.IN.IMG.1')).media_path).toBeNull();
    expect((await rowOf('wamid.IN.IMG.1')).media_id).toBe('MEDIA_IMG_1'); // still retryable

    expect(await run(message.id, true)).toBe('unavailable');
    const after = await rowOf('wamid.IN.IMG.1');
    expect(after.media_id).toBeNull();
    expect(after.media_path).toBeNull();
    expect(await filesUnder()).toEqual([]);
  });

  it.each([
    ['text/html', 'image'],
    ['image/svg+xml', 'image'],
    ['application/x-msdownload', 'image'],
    ['application/pdf', 'image'],
  ])('refuses %s for an %s message, writes nothing, and the job still succeeds (retrying would not help)', async (mime) => {
    const message = await ingestImage();
    imageNetwork({ mime });
    expect(await run(message.id)).toBe('unavailable');
    expect(await filesUnder()).toEqual([]);
    expect((await rowOf('wamid.IN.IMG.1')).media_id).toBeNull();
  });

  it('refuses a file whose declared size is over the cap without downloading it', async () => {
    const message = await ingestImage();
    const calls = imageNetwork({ fileSize: 9 * 1024 * 1024 });
    expect(await run(message.id)).toBe('unavailable');
    expect(calls.download).toHaveLength(0);
  });

  it('refuses a file that lies about its size and keeps nothing', async () => {
    const message = await ingestImage();
    const huge = new Uint8Array(9 * 1024 * 1024);
    stubNetwork({
      graphInfo: () => jsonResponse({ url: `${MEDIA_HOST}/file/1`, mime_type: 'image/jpeg', file_size: 1000 }),
      download: () => new Response(new Uint8Array(huge), { headers: { 'content-length': '1000' } }),
    });
    expect(await run(message.id)).toBe('unavailable');
    expect(await filesUnder()).toEqual([]);
  });

  it('turns a bare placeholder into "[Image unavailable]" but never overwrites what the customer wrote', async () => {
    await ingestFixture('sticker'); // no caption: content is the placeholder "[Sticker]"
    const sticker = await rowOf('wamid.IN.STK.1');
    stubNetwork({ graphInfo: () => jsonResponse({}, 404) });
    expect(await run(sticker.id)).toBe('unavailable');
    expect((await rowOf('wamid.IN.STK.1')).content).toBe('[Sticker unavailable]');

    const image = await ingestImage(); // has the caption "This one?"
    expect(await run(image.id)).toBe('unavailable');
    expect((await rowOf('wamid.IN.IMG.1')).content).toBe('This one?');
  });

  it('settles media that Meta no longer has (404, or Graph "does not exist") as unavailable and stops', async () => {
    const message = await ingestImage();
    stubNetwork({ graphInfo: () => jsonResponse({ error: { code: 100 } }, 400) });
    expect(await run(message.id)).toBe('unavailable');
    expect((await rowOf('wamid.IN.IMG.1')).media_id).toBeNull();
    // Nothing re-enqueues it any more: a replay of the webhook sees no media id to fetch.
    await h.clearMediaJobs();
    await sql()`UPDATE webhook_events SET processed_at = NULL`;
    await ingestFixture('image-caption');
    expect(await h.mediaJobs()).toHaveLength(0);
  });
});

describe('failures that must be retried, not settled', () => {
  it.each([
    ['rate limited', 429],
    ['Meta is down', 503],
  ])('%s: the job fails (the queue retries) and the message is left untouched', async (_label, status) => {
    const message = await ingestImage();
    stubNetwork({ graphInfo: () => jsonResponse({ error: { code: 4 } }, status) });
    await expect(run(message.id)).rejects.toBeInstanceOf(GraphError);
    expect((await rowOf('wamid.IN.IMG.1')).media_id).toBe('MEDIA_IMG_1');
    expect(await filesUnder()).toEqual([]);
  });

  it('a network failure is retried', async () => {
    const message = await ingestImage();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))));
    await expect(run(message.id)).rejects.toMatchObject({ failure: 'retryable' });
  });

  it('a rejected access token raises ONE critical alert, fails the job, and does not mark the media gone', async () => {
    const message = await ingestImage();
    stubNetwork({ graphInfo: () => jsonResponse({ error: { code: 190 } }, 401) });
    await expect(run(message.id)).rejects.toMatchObject({ failure: 'auth' });
    await expect(run(message.id)).rejects.toMatchObject({ failure: 'auth' });

    expect((await rowOf('wamid.IN.IMG.1')).media_id).toBe('MEDIA_IMG_1');
    expect(await count(sql(), 'notifications', `kind = 'alert:whatsapp_token_invalid'`)).toBe(1);
  });
});

describe('messages that have nothing to fetch', () => {
  it('a message the customer deleted is never downloaded', async () => {
    const message = await ingestImage();
    await sql()`UPDATE messages SET deleted_at = now()`;
    const calls = imageNetwork();
    expect(await run(message.id)).toBe('no_media');
    expect(calls.graph).toHaveLength(0);
  });

  it('a text message, an unknown id, and a message already settled as unavailable', async () => {
    await ingestFixture('text-message');
    const text = await rowOf('wamid.IN.TEXT.1');
    const calls = imageNetwork();
    expect(await run(text.id)).toBe('no_media');
    expect(await run('00000000-0000-4000-8000-000000000000')).toBe('message_missing');
    await sql()`UPDATE messages SET media_id = NULL WHERE wamid = 'wamid.IN.TEXT.1'`;
    expect(await run(text.id)).toBe('no_media');
    expect(calls.graph).toHaveLength(0);
  });
});

describe('voice notes', () => {
  const AUDIO = new Uint8Array(4096).map((_, i) => (i * 7) % 256);

  async function ingestVoice(): Promise<Row> {
    await ingestFixture('voice-note');
    return rowOf('wamid.IN.AUD.1');
  }

  const audioRoutes = (groq: Parameters<typeof stubNetwork>[0]['groq']) =>
    stubNetwork({
      graphInfo: () => jsonResponse({ url: `${MEDIA_HOST}/audio/1`, mime_type: 'audio/ogg; codecs=opus', sha256: hex(AUDIO), file_size: AUDIO.byteLength }),
      download: () => new Response(new Uint8Array(AUDIO), { headers: { 'content-type': 'audio/ogg' } }),
      ...(groq ? { groq } : {}),
    });

  it('stores the audio and a transcript that is LABELLED as machine-made', async () => {
    const message = await ingestVoice();
    const calls = audioRoutes(() => transcription('Hi, I would like to order the blue dress please.', 'english', 6));

    expect(await run(message.id)).toBe('stored');

    const stored = await rowOf('wamid.IN.AUD.1');
    expect(stored).toMatchObject({
      media_mime: 'audio/ogg',
      media_path: `2026/10/${message.id}.ogg`,
      transcription_status: 'done',
      content_source: 'transcript',
      content: '[Voice message, auto-transcribed] Hi, I would like to order the blue dress please.',
    });
    expect(calls.groq).toHaveLength(1);
    expect(calls.groq[0]?.path).toBe('/openai/v1/audio/transcriptions');
    expect(calls.groq[0]?.formFields?.model).toBe('test-transcribe-model');
    expect(calls.groq[0]?.formFields?.response_format).toBe('verbose_json');
    const [aiRun] = await sql()<Array<{ purpose: string; model: string; ok: boolean }>>`SELECT purpose, model, ok FROM ai_runs`;
    expect(aiRun).toEqual({ purpose: 'transcribe', model: 'test-transcribe-model', ok: true });
  });

  it('marks a transcript in the wrong language low-confidence and DISCARDS its text: invented words never reach the owner or a model', async () => {
    const message = await ingestVoice();
    audioRoutes(() => transcription('Nkulamusizza nnyo omukwano gwange invented-secret-words', 'swahili', 5));

    await run(message.id);

    const stored = await rowOf('wamid.IN.AUD.1');
    expect(stored.transcription_status).toBe('low_confidence');
    expect(stored.content).toBe(UNRELIABLE_LABEL);
    expect(stored.content_source).toBe('rendered');
    expect(stored.media_path).not.toBeNull(); // the owner can still listen
    for (const table of ['messages', 'ai_runs', 'audit_log', 'notifications', 'webhook_events']) {
      const [row] = await sql().unsafe<Array<{ found: boolean }>>(`SELECT (${table}::text LIKE '%invented-secret-words%') AS found FROM ${table} LIMIT 1`).catch(() => [{ found: false }]);
      expect(row?.found ?? false, `${table} must not contain the discarded transcript`).toBe(false);
    }
  });

  it('a transient transcription failure keeps the downloaded file and retries ONLY the transcription', async () => {
    const message = await ingestVoice();
    // The SDK retries once inside the call, so two failures are what make the whole first attempt fail.
    let failures = 2;
    const calls = audioRoutes(() => (failures-- > 0 ? apiError(503, 'overloaded') : transcription('Please send the price list today.', 'english', 5)));

    await expect(run(message.id, false)).rejects.toBeInstanceOf(AiProviderError);
    const midway = await rowOf('wamid.IN.AUD.1');
    expect(midway.media_path).not.toBeNull();
    expect(midway.transcription_status).toBe('pending');
    expect(midway.content).toBe('[Voice message]');

    expect(await run(message.id, false)).toBe('already_stored');
    expect((await rowOf('wamid.IN.AUD.1')).transcription_status).toBe('done');
    expect(calls.download).toHaveLength(1); // the file was not downloaded again
  });

  it('on the last attempt a failing transcription settles as failed and keeps the file and the placeholder', async () => {
    const message = await ingestVoice();
    audioRoutes(() => apiError(503, 'overloaded'));
    await run(message.id, true);
    const stored = await rowOf('wamid.IN.AUD.1');
    expect(stored).toMatchObject({ transcription_status: 'failed', content: '[Voice message]' });
    expect(stored.media_path).not.toBeNull();
  });

  it('a non-retryable transcription failure (rejected audio) settles immediately', async () => {
    const message = await ingestVoice();
    audioRoutes(() => apiError(400, 'could not process file'));
    await run(message.id, false);
    expect((await rowOf('wamid.IN.AUD.1')).transcription_status).toBe('failed');
  });

  it('never transcribes twice', async () => {
    const message = await ingestVoice();
    const calls = audioRoutes(() => transcription('Please send the price list today.', 'english', 5));
    await run(message.id);
    await run(message.id);
    expect(calls.groq).toHaveLength(1);
  });

  it('does NOT resurrect text the customer deleted while the transcript was being produced', async () => {
    const message = await ingestVoice();
    audioRoutes(async () => {
      // The customer deletes the message for everyone while Groq is still working.
      await sql()`UPDATE messages SET deleted_at = now(), content = NULL, content_source = NULL WHERE id = ${message.id}`;
      return transcription('Hi, I would like to order the blue dress please.', 'english', 6);
    });
    await run(message.id);
    const stored = await rowOf('wamid.IN.AUD.1');
    expect(stored.content).toBeNull();
    expect(stored.transcription_status).toBe('pending');
  });
});
