import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/media/[id]/route';
import { serveMedia } from '@/lib/media-serve';
import { createEnrolledOwner } from '../helpers/auth';
import { closeAllDb, migratorSql, resetDb } from '../helpers/db';
import { seedContact, seedConversation, seedMessage } from '../helpers/ingest';

// The route reads MEDIA_STORAGE_DIR from the environment, so point it at a temp directory before anything reads the env.
const root = mkdtempSync(join(tmpdir(), 'wab-serve-'));
process.env.MEDIA_STORAGE_DIR = root;

let admin: Sql;
let cookie: string;
let phoneCounter = 0;

beforeAll(() => {
  admin = migratorSql();
});

beforeEach(async () => {
  await resetDb(admin);
  cookie = (await createEnrolledOwner()).cookie;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await closeAllDb();
});

const BYTES = new Uint8Array(1000).map((_, i) => i % 256);

/** A message with a stored file; returns its id. */
async function seedMedia(o: { type?: string; mime?: string; path?: string; write?: boolean; deleted?: boolean } = {}): Promise<string> {
  phoneCounter += 1;
  const conversation = await seedConversation(admin, await seedContact(admin, { phone: `+2567001${String(phoneCounter).padStart(5, '0')}` }));
  const id = await seedMessage(admin, conversation, { type: o.type ?? 'image', content: '[Image]' });
  const path = o.path ?? `2026/10/${id}.jpg`;
  await admin`UPDATE messages SET media_path = ${path}, media_mime = ${o.mime ?? 'image/jpeg'}, deleted_at = ${o.deleted ? new Date() : null} WHERE id = ${id}`;
  if (o.write !== false) {
    const full = join(root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, BYTES);
  }
  return id;
}

const request = (id: string, headers: Record<string, string> = {}, method = 'GET') => new Request(`http://localhost:3000/api/media/${id}`, { method, headers });
const serve = (id: string, headers: Record<string, string> = {}, method = 'GET') => serveMedia(request(id, headers, method), id, { root });
const asOwner = (id: string, extra: Record<string, string> = {}) => GET(request(id, { cookie, ...extra }), { params: Promise.resolve({ id }) });

describe('GET /api/media/[id]: the owner’s session is verified by the route itself', () => {
  it('answers 401 with an empty body and no hint of what exists, to anonymous, forged and wrong-owner requests', async () => {
    const id = await seedMedia();
    const attempts: Array<Record<string, string>> = [{}, { cookie: 'better-auth.session_token=forged.value' }, { cookie: '' }];
    for (const headers of attempts) {
      const response = await GET(request(id, headers), { params: Promise.resolve({ id }) });
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    // The same 401 for an id that does not exist: existence is not revealed to the unauthenticated.
    const missing = await GET(request('0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee'), { params: Promise.resolve({ id: '0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee' }) });
    expect(missing.status).toBe(401);
  });

  it('serves the file to the authenticated owner', async () => {
    const id = await seedMedia();
    const response = await asOwner(id);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });
});

describe('serving untrusted bytes safely', () => {
  it('sends the VERIFIED type, forbids sniffing, sandboxes it, and never caches it', async () => {
    const id = await seedMedia();
    const response = await serve(id);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(response.headers.get('content-length')).toBe(String(BYTES.byteLength));
    expect(response.headers.get('accept-ranges')).toBe('bytes');
  });

  it('makes documents download instead of rendering, under a name we choose', async () => {
    const id = await seedMedia({ type: 'document', mime: 'application/pdf', path: `2026/10/doc.pdf` });
    const response = await serve(id);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="download.pdf"');
    expect(response.headers.get('content-type')).toBe('application/pdf');
  });

  it('never serves a type that is not on the allowlist even if the database somehow holds one', async () => {
    const id = await seedMedia({ mime: 'garbage' });
    expect((await serve(id)).status).toBe(404);
  });
});

describe('ranges (so audio and video can seek)', () => {
  it('answers a range with 206 and exactly those bytes', async () => {
    const id = await seedMedia();
    const response = await serve(id, { range: 'bytes=100-199' });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(response.headers.get('content-length')).toBe('100');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(100, 200));
  });

  it('supports open-ended and suffix ranges', async () => {
    const id = await seedMedia();
    expect(new Uint8Array(await (await serve(id, { range: 'bytes=990-' })).arrayBuffer())).toEqual(BYTES.slice(990));
    expect(new Uint8Array(await (await serve(id, { range: 'bytes=-10' })).arrayBuffer())).toEqual(BYTES.slice(990));
  });

  it('answers 416 with the size for an unsatisfiable or malformed range', async () => {
    const id = await seedMedia();
    for (const range of ['bytes=5000-', 'bytes=10-5', 'bytes=0-1,5-9', 'junk']) {
      const response = await serve(id, { range });
      expect(response.status, range).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */1000');
    }
  });

  it('answers HEAD without a body', async () => {
    const id = await seedMedia();
    const response = await serve(id, {}, 'HEAD');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('1000');
    expect(await response.text()).toBe('');
  });
});

describe('what is never served (404, not an error that explains itself)', () => {
  it('an unknown id, a malformed id, a message without a file, and a message the customer deleted', async () => {
    const withoutFile = await seedMedia({ write: false });
    const deleted = await seedMedia({ deleted: true });
    const noPath = await (async () => {
      const conversation = await seedConversation(admin, await seedContact(admin, { phone: '+256700999999' }));
      return seedMessage(admin, conversation, { type: 'text' });
    })();
    for (const id of ['0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', 'not-a-uuid', '../etc/passwd', withoutFile, deleted, noPath]) {
      expect((await serve(id)).status, id).toBe(404);
    }
  });

  it('a stored path that tries to leave the media directory, even though we wrote it ourselves', async () => {
    const outside = join(root, '..', 'wab-secret.txt');
    await writeFile(outside, 'secret');
    for (const path of ['../wab-secret.txt', '/etc/passwd', '2026/../../wab-secret.txt', '2026\\10\\x.jpg']) {
      const id = await seedMedia({ path, write: false });
      expect((await serve(id)).status, path).toBe(404);
    }
    await rm(outside, { force: true });
  });

  it('a directory in place of a file', async () => {
    const id = await seedMedia({ path: '2026/10/a-directory.jpg', write: false });
    await mkdir(join(root, '2026/10/a-directory.jpg'), { recursive: true });
    expect((await serve(id)).status).toBe(404);
  });

  it('a symlink inside the media directory that points OUTSIDE it is not followed', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'wab-target-'));
    const target = join(outsideDir, 'secret.jpg');
    await writeFile(target, 'outside the media directory');
    const id = await seedMedia({ path: '2026/10/link.jpg', write: false });
    await mkdir(join(root, '2026/10'), { recursive: true });
    await symlink(target, join(root, '2026/10/link.jpg'));

    expect((await serve(id)).status).toBe(404);
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('a symlink that stays inside the media directory is fine', async () => {
    const real = await seedMedia();
    const [row] = await admin<Array<{ media_path: string }>>`SELECT media_path FROM messages WHERE id = ${real}`;
    const id = await seedMedia({ path: '2026/10/alias.jpg', write: false });
    await symlink(join(root, row?.media_path ?? ''), join(root, '2026/10/alias.jpg'));
    expect((await serve(id)).status).toBe(200);
  });
});
