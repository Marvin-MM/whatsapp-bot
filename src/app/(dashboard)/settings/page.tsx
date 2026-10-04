import type { Metadata } from 'next';
import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatFullTimestamp } from '@/lib/conversations/format';
import { getIngestHealth } from '@/lib/dashboard/ingest-health';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Settings' };

/** The fields to subscribe to in the Meta app dashboard, with what each is for. */
const WEBHOOK_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['messages', 'customer messages and delivery statuses'],
  ['smb_message_echoes', 'messages you send from the WhatsApp Business app'],
  ['history', 'your past chats, when the number is connected'],
  ['smb_app_state_sync', 'contact names saved in the Business app'],
  ['user_id_update', 'a customer’s ID changing (they changed number)'],
  ['account_update', 'warnings about the account itself'],
];

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'danger' | 'warning' }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`text-lg font-semibold ${tone === 'danger' ? 'text-destructive' : tone === 'warning' ? 'text-warning' : ''}`}>{value}</dd>
    </div>
  );
}

export default async function SettingsPage() {
  await requireOwnerPage();
  const env = getEnv();
  const health = await getIngestHealth(getDb());
  const when = (date: Date | null) => (date ? formatFullTimestamp(date, env.OWNER_TIMEZONE) : 'Never');
  const webhookUrl = `${env.APP_URL.replace(/\/$/, '')}/api/webhooks/whatsapp`;

  return (
    <>
      <PageHeader title="Settings" description="WhatsApp connection, business profile, kill switches and audit log." />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>WhatsApp connection</CardTitle>
          <CardDescription>
            {health.lastReceivedAt ? `Last message from Meta: ${when(health.lastReceivedAt)}` : 'Meta has not sent anything yet. Finish the webhook setup below.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Received (24 h)" value={health.received24h} />
            <Stat label="Waiting to process" value={health.unprocessed} tone={health.unprocessed > 20 ? 'warning' : undefined} />
            <Stat label="Stuck over 10 min" value={health.stuck} tone={health.stuck > 0 ? 'danger' : undefined} />
            <Stat label="Set aside (24 h)" value={health.settledWithNote24h} />
          </dl>
          {health.stuck > 0 ? (
            <p role="alert" className="text-sm text-destructive">
              Some events have waited more than ten minutes. The worker is probably not running: start it with <code>pnpm dev:worker</code>.
            </p>
          ) : null}

          <section aria-labelledby="history-heading" className="space-y-2">
            <h3 id="history-heading" className="text-sm font-semibold">
              History import
            </h3>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Chunks received" value={health.history.chunks} />
              <Stat label="Last chunk" value={when(health.history.lastChunkAt)} />
              <Stat label="Your messages imported" value={health.history.ownerMessagesImported} />
              <Stat label="Sync errors" value={health.history.errors} tone={health.history.errors > 0 ? 'warning' : undefined} />
            </dl>
            <p className="text-xs text-muted-foreground">
              Meta sends your recent chats in chunks after you connect the number. Your own past replies are what the assistant learns your style from.
            </p>
          </section>

          <section aria-labelledby="alerts-heading" className="space-y-2">
            <h3 id="alerts-heading" className="text-sm font-semibold">
              Recent alerts
            </h3>
            {health.alerts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No alerts.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {health.alerts.map((alert) => (
                  <li key={`${alert.kind}-${alert.at.toISOString()}`} className="flex items-center justify-between gap-2">
                    <Badge variant="warning">{alert.kind.replaceAll('_', ' ')}</Badge>
                    <time dateTime={alert.at.toISOString()} className="text-xs text-muted-foreground">
                      {formatFullTimestamp(alert.at, env.OWNER_TIMEZONE)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="setup-heading" className="space-y-2 border-t border-border pt-4">
            <h3 id="setup-heading" className="text-sm font-semibold">
              Webhook setup
            </h3>
            <p className="text-sm">
              Callback URL: <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">{webhookUrl}</code>
            </p>
            <p className="text-sm text-muted-foreground">Verify token: the value of WEBHOOK_VERIFY_TOKEN in your environment (never shown here). Subscribe to these fields:</p>
            <ul className="list-inside list-disc text-sm text-muted-foreground">
              {WEBHOOK_FIELDS.map(([field, purpose]) => (
                <li key={field}>
                  <code className="text-xs">{field}</code>: {purpose}
                </li>
              ))}
            </ul>
          </section>
        </CardContent>
      </Card>
    </>
  );
}
