import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { writeAudit } from '@/lib/audit';
import { type Db, type Tx } from '@/lib/db';
import { settings, styleGuides } from '@/lib/db/schema';
import { styleGuideContentSchema, type StyleGuideContent } from '@/lib/schemas/style-guide';
import { chatModelId } from './models';
import { runStructured } from './run';
import { ELIGIBLE_OWNER_PROVENANCE, pairsCte } from './fewshot-sql';
import { GENERIC_ASSISTANT_PHRASES, STYLE_PROMPT_VERSION, type StyleSample, styleInstructions, styleUserPrompt } from './prompts/style';
import type { Stage } from './stages';

/**
 * Style extraction (spec 9.6): read the owner's own messages, ask the analysis model what is characteristic about them, store the answer
 * as a NEW, INACTIVE version. The owner activates a version from /style after reading it and seeing what changed. Nothing here ever
 * reaches the model except the owner's own eligible words: no customer message, and never an `ai_unedited` / `ai_autopilot` message
 * (a model that learns its style from its own output drifts toward its own habits).
 */

/** Fewer than this and a "style" would be a few coincidences. Refused, not guessed at. */
export const MIN_STYLE_MESSAGES = 30;
export const MAX_STYLE_MESSAGES = 400;
/** The same sentence ("ok", "thank you") more than twice says nothing new about style and would crowd out everything else. */
const MAX_COPIES = 2;

export class StyleExtractionError extends Error {
  constructor(
    readonly code: 'insufficient_data',
    message: string,
  ) {
    super(message);
    this.name = 'StyleExtractionError';
  }
}

interface Candidate {
  text: string;
  stage: Stage;
  occurredAt: Date;
}

const normalise = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
const STAGES: readonly Stage[] = ['opening', 'mid', 'followup', 'closing'];

/**
 * Up to `limit` messages, spread across the four stages (an equal share each; a stage with fewer gives its unused share to the others),
 * newest first within a stage, with no sentence repeated more than twice. Pure, so the policy is tested without a database.
 */
export function stratify(candidates: readonly Candidate[], limit: number = MAX_STYLE_MESSAGES): Candidate[] {
  const copies = new Map<string, number>();
  const byStage = new Map<Stage, Candidate[]>(STAGES.map((stage) => [stage, []]));
  for (const candidate of [...candidates].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())) {
    const key = normalise(candidate.text);
    if ((copies.get(key) ?? 0) >= MAX_COPIES) continue;
    copies.set(key, (copies.get(key) ?? 0) + 1);
    byStage.get(candidate.stage)?.push(candidate);
  }

  const picked: Candidate[] = [];
  const taken = new Map<Stage, number>(STAGES.map((stage) => [stage, 0]));
  const share = Math.floor(limit / STAGES.length);
  for (const stage of STAGES) {
    const items = byStage.get(stage) ?? [];
    const count = Math.min(share, items.length);
    picked.push(...items.slice(0, count));
    taken.set(stage, count);
  }
  // Hand the unused share to whichever stages still have messages, one at a time, so no stage takes it all.
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const stage of STAGES) {
      if (picked.length >= limit) break;
      const items = byStage.get(stage) ?? [];
      const next = items[taken.get(stage) ?? 0];
      if (next) {
        picked.push(next);
        taken.set(stage, (taken.get(stage) ?? 0) + 1);
        progressed = true;
      }
    }
  }
  return picked.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
}

interface SampleRow extends Record<string, unknown> {
  reply: string;
  stage: Stage;
  occurred_at: string;
}

export async function loadStyleCandidates(db: Db, now: Date): Promise<Candidate[]> {
  const rows = await db.execute<SampleRow>(sql`
    WITH ${pairsCte(now.toISOString())}
    SELECT reply, stage, occurred_at FROM pairs WHERE eligible ORDER BY occurred_at DESC LIMIT 6000
  `);
  return rows.map((row) => ({ text: row.reply, stage: row.stage, occurredAt: new Date(row.occurred_at) }));
}

/** How many of the owner's own messages style learning can read (Settings and /style show it; extraction needs MIN_STYLE_MESSAGES). */
export async function countEligibleOwnerMessages(db: Db): Promise<number> {
  const provenance = sql.join(ELIGIBLE_OWNER_PROVENANCE.map((value) => sql`${value}`), sql`, `);
  const rows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM messages
    WHERE direction = 'outbound' AND type = 'text' AND status <> 'failed' AND provenance IN (${provenance})
      AND coalesce(btrim(content), '') <> '' AND content NOT LIKE '%[[%'
  `);
  return rows[0]?.n ?? 0;
}

/** The generic-assistant phrases the owner really never writes, added to whatever the model found. Capped at the schema's 30. */
export function withDefaultForbidden(content: StyleGuideContent, ownerTexts: readonly string[]): StyleGuideContent {
  const written = ownerTexts.map((text) => text.toLowerCase());
  const have = new Set(content.forbiddenPatterns.map((pattern) => pattern.trim().toLowerCase()));
  const additions = GENERIC_ASSISTANT_PHRASES.filter((phrase) => !have.has(phrase.toLowerCase()) && !written.some((text) => text.includes(phrase.toLowerCase())));
  return { ...content, forbiddenPatterns: [...content.forbiddenPatterns, ...additions].slice(0, 30) };
}

export interface ExtractedStyle {
  id: string;
  version: number;
  sourceMessageCount: number;
}

/** Runs one extraction and stores the result as the next version, inactive. Throws `StyleExtractionError` when there is too little to learn from. */
export async function extractStyleGuide(db: Db, options: { now?: Date } = {}): Promise<ExtractedStyle> {
  const now = options.now ?? new Date();
  const sample = stratify(await loadStyleCandidates(db, now));
  if (sample.length < MIN_STYLE_MESSAGES) {
    throw new StyleExtractionError('insufficient_data', `Only ${sample.length} of your own messages are available to learn from; at least ${MIN_STYLE_MESSAGES} are needed. Import more chats first (pnpm import:chats).`);
  }
  const [row] = await db.select({ businessName: settings.businessName }).from(settings).where(eq(settings.id, 1)).limit(1);
  const samples: StyleSample[] = sample.map((item) => ({ text: item.text, stage: item.stage }));

  const result = await runStructured({
    purpose: 'style_extract',
    modelId: chatModelId('analysis'),
    promptVersion: STYLE_PROMPT_VERSION,
    schema: styleGuideContentSchema,
    instructions: styleInstructions(),
    prompt: styleUserPrompt(samples, row?.businessName ?? ''),
    temperature: 0.1,
    db,
  });
  const content = withDefaultForbidden(result.output, sample.map((item) => item.text));

  return db.transaction((tx) => insertStyleVersion(tx, content, sample.length));
}

/** Stores `content` as the next version number, inactive. Two extractions at once must not both claim the same number. */
export async function insertStyleVersion(tx: Tx, content: StyleGuideContent, sourceMessageCount: number): Promise<ExtractedStyle> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('style-version', 0))`);
  const [latest] = await tx.select({ version: sql<number>`coalesce(max(${styleGuides.version}), 0)::int` }).from(styleGuides);
  const version = (latest?.version ?? 0) + 1;
  const [created] = await tx.insert(styleGuides).values({ version, content, sourceMessageCount, isActive: false }).returning({ id: styleGuides.id });
  if (!created) throw new Error('style guide insert returned nothing');
  await writeAudit(tx, { actor: 'system', action: 'style.extracted', entityType: 'style_guide', entityId: created.id, metadata: { version, sourceMessageCount, promptVersion: STYLE_PROMPT_VERSION } });
  return { id: created.id, version, sourceMessageCount };
}

export class StyleActivationError extends Error {
  constructor(readonly code: 'not_found', message: string) {
    super(message);
    this.name = 'StyleActivationError';
  }
}

/**
 * Makes one version the active guide: exactly one is active at any time. Both writes happen in the caller's transaction under an
 * advisory lock, and the database's partial unique index is the last line of defence if two activations ever raced.
 */
export async function activateStyleGuide(tx: Tx, id: string): Promise<{ version: number; previousVersion: number | null }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('style-activate', 0))`);
  const [target] = await tx.select({ id: styleGuides.id, version: styleGuides.version }).from(styleGuides).where(eq(styleGuides.id, id)).limit(1);
  if (!target) throw new StyleActivationError('not_found', 'That style version no longer exists.');
  const [previous] = await tx.select({ version: styleGuides.version }).from(styleGuides).where(eq(styleGuides.isActive, true)).limit(1);
  await tx.update(styleGuides).set({ isActive: false }).where(eq(styleGuides.isActive, true));
  await tx.update(styleGuides).set({ isActive: true, activatedAt: new Date() }).where(eq(styleGuides.id, id));
  return { version: target.version, previousVersion: previous?.version ?? null };
}

/** The active guide, or null (cold start: drafts are plain and autopilot is impossible). */
export async function getActiveStyleGuide(db: Db): Promise<{ id: string; version: number; content: StyleGuideContent } | null> {
  const [row] = await db.select({ id: styleGuides.id, version: styleGuides.version, content: styleGuides.content }).from(styleGuides).where(eq(styleGuides.isActive, true)).limit(1);
  return row ?? null;
}
