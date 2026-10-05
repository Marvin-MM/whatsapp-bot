import 'server-only';
import { count, inArray } from 'drizzle-orm';
import { countOpenDrafts } from '@/lib/drafts/queries';
import { countTasks } from '@/lib/tasks/queries';
import { getDb } from '@/lib/db';
import { messages, settings } from '@/lib/db/schema';

export interface ShellState {
  aiPaused: boolean;
  sendingPaused: boolean;
  autopilotPaused: boolean;
  /** Messages that are queued, unknown or failed: they need the owner's attention. */
  problemCount: number;
  /** Drafts waiting for the owner's decision (shown on the Approvals tab). */
  pendingDrafts: number;
  /** Open tasks past their time (shown on the Tasks tab). */
  overdueTasks: number;
}

/** What the global header shows: kill-switch state and the alert counter. */
export async function getShellState(): Promise<ShellState> {
  const db = getDb();
  const [row] = await db
    .select({ aiPaused: settings.aiPaused, sendingPaused: settings.sendingPaused, autopilotPaused: settings.autopilotPaused })
    .from(settings)
    .limit(1);
  const [problems] = await db
    .select({ n: count() })
    .from(messages)
    .where(inArray(messages.status, ['queued', 'unknown', 'failed']));
  const pendingDrafts = await countOpenDrafts(db);
  const { overdue: overdueTasks } = await countTasks(db, new Date());

  return {
    aiPaused: row?.aiPaused ?? false,
    sendingPaused: row?.sendingPaused ?? false,
    // The safe default: until settings exist, autopilot is off.
    autopilotPaused: row?.autopilotPaused ?? true,
    problemCount: problems?.n ?? 0,
    pendingDrafts,
    overdueTasks,
  };
}
