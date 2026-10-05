import type { Sql } from 'postgres';
import { DRAFT_PROMPT_VERSION } from '@/lib/ai/prompts/draft';
import { FIXTURE } from './fixtures';
import { HOUR, NOW, seedContact, seedConversation, seedMessage } from './ingest';

/**
 * A conversation on autopilot, with everything the 10 rules need to pass, and a system whose eligibility gate passes. Tests then break exactly one
 * thing. "Now" for the autopilot is `NOW` (11:46 in Kampala: outside the default quiet hours); the window closes 20 hours later.
 */
export const DAY = 24 * HOUR;
export const MIN = 60 * 1000;

export async function seedGatePassing(admin: Sql, over: { approved?: number } = {}): Promise<void> {
  // The system-wide gate: a fresh evaluation of what is in use now, and a track record of approved drafts.
  await admin`INSERT INTO eval_runs (id, prompt_version, model, style_guide_version, sample_size, median_edit_distance, invented_fact_rate, forbidden_hit_rate, report_path, created_at)
    VALUES (gen_random_uuid(), ${DRAFT_PROMPT_VERSION}, 'test-draft-model', NULL, 50, 0.12, 0, 0, 'eval/results/test.md', ${new Date(NOW.getTime() - 2 * DAY)})`;
  const contact = await seedContact(admin, { phone: '+256700999001', bsuid: 'UG.RECORD0000000000001', name: 'Record keeper' });
  const conversation = await seedConversation(admin, contact, { status: 'resolved' });
  const approved = over.approved ?? 200;
  const message = await seedMessage(admin, conversation, { direction: 'outbound', provenance: 'ai_unedited', occurredAt: new Date(NOW.getTime() - 3 * DAY) });
  await admin`INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, model, prompt_version, status, edit_distance, approved_at, final_message_id)
    SELECT gen_random_uuid(), ${conversation}, '{}'::uuid[], 'ok', 'ok', 'question', 'a', 'test-draft-model', ${DRAFT_PROMPT_VERSION}, 'approved', 0.1, ${new Date(NOW.getTime() - 3 * DAY)}::timestamptz, ${message}
    FROM generate_series(1, ${approved})`;
}

export interface World {
  conversationId: string;
  contactId: string;
  /** The customer message the draft answers. */
  questionId: string;
  draftId: string;
}

export interface WorldOptions {
  replyMode?: 'approval' | 'autopilot';
  paused?: boolean;
  gate?: boolean;
  content?: string;
  intent?: string;
  riskFlags?: string[];
  missingFacts?: string[];
  noReplyNeeded?: boolean;
  ownerMessages?: number;
  windowHours?: number;
  delaySeconds?: number;
  disclosure?: string;
}

export async function seedAutopilotWorld(admin: Sql, o: WorldOptions = {}): Promise<World> {
  await admin`
    INSERT INTO settings (id, owner_name, business_name, business_profile, ai_paused, sending_paused, autopilot_paused, autopilot_delay_seconds, autopilot_disclosure)
    VALUES (1, 'Marvin', 'agent_47', 'Open 9am to 6pm. Dress: UGX 50,000', false, false, ${o.paused ?? false}, ${o.delaySeconds ?? 120}, ${o.disclosure ?? '(sent by my assistant)'})
    ON CONFLICT (id) DO UPDATE SET autopilot_paused = ${o.paused ?? false}, autopilot_delay_seconds = ${o.delaySeconds ?? 120}, autopilot_disclosure = ${o.disclosure ?? '(sent by my assistant)'}, ai_paused = false, sending_paused = false`;
  if (o.gate ?? true) await seedGatePassing(admin);

  const contactId = await seedContact(admin, { phone: `+${FIXTURE.amina.wa}`, bsuid: FIXTURE.amina.bsuid, name: 'Amina' });
  const conversationId = await seedConversation(admin, contactId, { status: 'waiting_on_me' });
  await admin`UPDATE conversations SET reply_mode = ${o.replyMode ?? 'autopilot'}, window_expires_at = ${new Date(NOW.getTime() + (o.windowHours ?? 20) * HOUR)}, last_inbound_at = ${new Date(NOW.getTime() - 5 * MIN)} WHERE id = ${conversationId}`;

  // History: the owner has written plenty to this customer, and the customer is a person (minutes between messages, not seconds).
  const owner = o.ownerMessages ?? 6;
  for (let i = 0; i < owner; i += 1) {
    const at = new Date(NOW.getTime() - (10 - i) * HOUR);
    await seedMessage(admin, conversationId, { direction: 'inbound', content: `question ${i}`, occurredAt: new Date(at.getTime() - 20 * MIN) });
    await seedMessage(admin, conversationId, { direction: 'outbound', provenance: 'owner_manual', content: `answer ${i}`, occurredAt: at });
  }
  const questionId = await seedMessage(admin, conversationId, { direction: 'inbound', content: 'What time do you close?', occurredAt: new Date(NOW.getTime() - 5 * MIN) });

  const [draft] = await admin<{ id: string }[]>`
    INSERT INTO drafts (id, conversation_id, trigger_message_ids, content, original_content, intent, analysis, missing_facts, risk_flags, no_reply_needed, model, prompt_version, status)
    VALUES (gen_random_uuid(), ${conversationId}, ${admin.array([questionId])}::uuid[], ${o.content ?? 'We close at 6pm 🙏'}, ${o.content ?? 'We close at 6pm 🙏'}, ${o.intent ?? 'question'}, 'Asks the closing time.',
            ${admin.array(o.missingFacts ?? [])}::text[], ${admin.array(o.riskFlags ?? [])}::text[], ${o.noReplyNeeded ?? false}, 'test-draft-model', ${DRAFT_PROMPT_VERSION}, 'pending')
    RETURNING id`;
  if (!draft) throw new Error('draft seed failed');
  return { conversationId, contactId, questionId, draftId: draft.id };
}

