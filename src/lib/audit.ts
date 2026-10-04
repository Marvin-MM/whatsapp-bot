import 'server-only';
import type { DbOrTx } from '@/lib/db';
import { auditLog } from '@/lib/db/schema';

export type AuditActor = 'owner' | 'system' | 'autopilot';

export interface AuditEntry {
  actor: AuditActor;
  /** Dotted verb, e.g. `settings.kill_switch`, `message.send`. */
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Appends an audit entry. Pass the surrounding transaction so the entry commits or
 * rolls back together with the change it describes. Metadata must not hold message bodies or tokens.
 */
export async function writeAudit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadata: entry.metadata ?? {},
  });
}
