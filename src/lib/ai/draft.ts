import 'server-only';
import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db';
import { conversations, messages, settings, styleGuides } from '@/lib/db/schema';
import { getEnv } from '@/lib/env';
import { selectFewShot } from './fewshot';
import { anyLooksLikePromptInjection } from './injection';
import { chatModelId } from './models';
import { type ConversationLine, DRAFT_PROMPT_VERSION, type DraftContext, HISTORY_LIMIT, draftInstructions, draftUserPrompt } from './prompts/draft';
import { runStructured } from './run';
import { type DraftOutput, type RiskFlag, draftOutputSchema } from './schemas';
import { type StageMessage, stageOfNextReply } from './stages';

/**
 * Drafting (spec 9): build the context from the database, ask the model once for a structured answer, then check what the model cannot be
 * trusted to check itself. Used by `generate-draft` (Phase 4) and by the evaluation (`pnpm eval:drafts`), which is why context building
 * is separate from the model call and takes an explicit "as of" time and exclusion list.
 */

export interface LoadedContext {
  context: DraftContext;
  fewshotMessageIds: string[];
  styleGuideVersion: number | null;
  /** A voice note whose transcript was unreliable, or media with nothing readable: the draft must say so. */
  unreadableMedia: boolean;
}

export interface LoadOptions {
  conversationId: string;
  /** The customer messages being answered. Their order in time is used, not the order given. */
  burstMessageIds: readonly string[];
  /** "Now" for the prompt and for the few-shot 24-hour exclusion. The evaluation passes the time of the real reply. */
  now: Date;
  /** Owner replies that must not be used as examples (the evaluation's held-out sample). */
  excludeReplyIds?: readonly string[];
  /** False for the evaluation: the stored summary describes the conversation as it is today, not as it was then. */
  useSummary?: boolean;
}

export class DraftContextError extends Error {
  constructor(readonly code: 'no_burst' | 'no_conversation', message: string) {
    super(message);
    this.name = 'DraftContextError';
  }
}

function textOf(row: { content: string | null }): string | null {
  const text = row.content?.trim();
  return text ? row.content : null;
}

export async function loadDraftContext(db: Db, options: LoadOptions): Promise<LoadedContext> {
  const { conversationId, now } = options;
  const [conversation] = await db.select({ summary: conversations.summary }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!conversation) throw new DraftContextError('no_conversation', 'That conversation does not exist.');

  const burstRows = await db
    .select({ id: messages.id, content: messages.content, occurredAt: messages.occurredAt, type: messages.type, transcription: messages.transcriptionStatus, deletedAt: messages.deletedAt })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), inArray(messages.id, [...options.burstMessageIds]), eq(messages.direction, 'inbound')))
    .orderBy(asc(messages.occurredAt), asc(messages.id));
  const burst: ConversationLine[] = burstRows.flatMap((row) => {
    const text = row.deletedAt === null ? textOf(row) : null;
    return text === null ? [] : [{ at: row.occurredAt, from: 'customer' as const, text }];
  });
  const firstBurst = burstRows[0];
  const lastBurst = burstRows.at(-1);
  if (!firstBurst || !lastBurst || burst.length === 0) throw new DraftContextError('no_burst', 'There is nothing from the customer to answer.');
  const unreadableMedia = burstRows.some((row) => row.transcription === 'low_confidence' || row.transcription === 'failed');

  const historyRows = await db
    .select({ direction: messages.direction, content: messages.content, occurredAt: messages.occurredAt })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        lt(messages.occurredAt, firstBurst.occurredAt),
        ne(messages.type, 'reaction'),
        ne(messages.status, 'failed'),
        sql`${messages.deletedAt} IS NULL`,
        sql`coalesce(btrim(${messages.content}), '') <> ''`,
      ),
    )
    .orderBy(desc(messages.occurredAt), desc(messages.id))
    .limit(HISTORY_LIMIT);
  const history: ConversationLine[] = historyRows.reverse().map((row) => ({ at: row.occurredAt, from: row.direction === 'inbound' ? ('customer' as const) : ('owner' as const), text: row.content ?? '' }));

  const [profile] = await db.select({ ownerName: settings.ownerName, businessName: settings.businessName, businessProfile: settings.businessProfile }).from(settings).where(eq(settings.id, 1)).limit(1);
  const [guide] = await db.select({ version: styleGuides.version, content: styleGuides.content }).from(styleGuides).where(eq(styleGuides.isActive, true)).limit(1);

  // The stage the reply will have, from the conversation up to the end of the burst.
  const timeline: StageMessage[] = (
    await db
      .select({ id: messages.id, direction: messages.direction, occurredAt: messages.occurredAt })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), ne(messages.type, 'reaction'), ne(messages.status, 'failed'), sql`${messages.occurredAt} <= ${lastBurst.occurredAt.toISOString()}::timestamptz`))
  ).map((row) => ({ id: row.id, direction: row.direction, occurredAt: row.occurredAt }));

  const examples = await selectFewShot(db, {
    conversationId,
    burstText: burst.map((line) => line.text).join('\n'),
    stage: stageOfNextReply(timeline),
    now,
    ...(options.excludeReplyIds ? { excludeReplyIds: options.excludeReplyIds } : {}),
  });

  return {
    context: {
      ownerName: profile?.ownerName ?? '',
      businessName: profile?.businessName ?? '',
      ownerTimezone: getEnv().OWNER_TIMEZONE,
      now,
      businessProfile: profile?.businessProfile ?? '',
      styleGuide: guide?.content ?? null,
      examples: examples.map((example) => ({ stage: example.stage, customerText: example.customerText, reply: example.reply })),
      summary: options.useSummary === false ? null : conversation.summary,
      history,
      burst,
    },
    fewshotMessageIds: examples.map((example) => example.replyMessageId),
    styleGuideVersion: guide?.version ?? null,
    unreadableMedia,
  };
}

export interface DraftResult {
  output: DraftOutput;
  /** The reply names facts it is missing (`missingFacts`) but contains no `[[placeholder]]`: the owner must read it before it goes (spec 9.3). */
  missingFactsUnmarked: boolean;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/** Reasoning models (gpt-oss, qwen3) draft with low effort (spec 9.1); a model that has no such setting is not sent one. */
export function reasoningFor(modelId: string): 'low' | undefined {
  return /gpt-oss|qwen/i.test(modelId) ? 'low' : undefined;
}

/** The checks the model cannot be trusted to make about itself (spec 9.3). Pure. */
export function postValidate(output: DraftOutput, forcedFlags: readonly RiskFlag[] = []): { output: DraftOutput; missingFactsUnmarked: boolean } {
  const reply = output.reply.trim();
  const hasPlaceholder = reply.includes('[[');
  const missingFacts = hasPlaceholder && output.missingFacts.length === 0 ? ['A detail the reply still needs'] : output.missingFacts;
  const riskFlags = [...new Set<RiskFlag>([...output.riskFlags, ...forcedFlags])];
  return { output: { ...output, reply, missingFacts, riskFlags }, missingFactsUnmarked: output.missingFacts.length > 0 && !hasPlaceholder };
}

export async function generateDraftFromContext(
  db: Db,
  loaded: Pick<LoadedContext, 'context' | 'unreadableMedia'>,
  options: { purpose?: 'draft' | 'eval'; draftId?: string } = {},
): Promise<DraftResult> {
  const modelId = chatModelId('draft');
  const reasoning = reasoningFor(modelId);
  const result = await runStructured({
    purpose: options.purpose ?? 'draft',
    modelId,
    promptVersion: DRAFT_PROMPT_VERSION,
    schema: draftOutputSchema,
    instructions: draftInstructions(loaded.context),
    prompt: draftUserPrompt(loaded.context),
    temperature: 0.4,
    ...(reasoning ? { reasoning } : {}),
    ...(options.draftId ? { draftId: options.draftId } : {}),
    db,
  });
  // Flags the pipeline adds itself, because they are about the INPUT and a model that was successfully injected would not report it.
  const forced: RiskFlag[] = [];
  if (loaded.unreadableMedia) forced.push('unreadable_media');
  if (anyLooksLikePromptInjection(loaded.context.burst.filter((line) => line.from === 'customer').map((line) => line.text))) forced.push('prompt_injection');
  const checked = postValidate(result.output, forced);
  return { ...checked, model: modelId, promptVersion: DRAFT_PROMPT_VERSION, inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs };
}
