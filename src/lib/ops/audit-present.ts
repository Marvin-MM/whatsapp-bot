/** Wording for the audit viewer: pure, so it is testable without rendering. */

/** Where an audit entry's subject lives in the dashboard, when it has a page of its own. */
export function auditEntityHref(entityType: string, entityId: string): string | null {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(entityId)) return null;
  switch (entityType) {
    case 'conversation':
      return `/conversations/${entityId}`;
    case 'task':
      return `/tasks#task-${entityId}`;
    case 'draft':
      return `/approvals?d=${entityId}`;
    default:
      return null;
  }
}

const MAX_VALUE = 60;

/** `key: value` pairs from an entry's metadata, short enough to read in a row (ids and kinds: the log never holds message text). */
export function describeMetadata(metadata: Record<string, unknown>): string[] {
  return Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .slice(0, 8)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${key}: ${text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text}`;
    });
}
