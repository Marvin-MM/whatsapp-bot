import type { Metadata } from 'next';
import { AutopilotSettingsForm } from '@/components/settings/autopilot-settings-form';
import { AutopilotConversationRow, ScheduledSendRow } from '@/components/settings/autopilot-lists';
import { AutopilotSwitch } from '@/components/settings/autopilot-switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getAutopilotOverview } from '@/lib/autopilot/overview';
import { ALLOWABLE_INTENTS, DELAY_SECONDS, MAX_DISCLOSURE_CHARS } from '@/lib/autopilot/settings';
import { getAutopilotStatus } from '@/lib/autopilot/status';
import { formatFullTimestamp } from '@/lib/conversations/format';
import { getDb } from '@/lib/db';
import { intentLabel } from '@/lib/drafts/present';
import { getEnv } from '@/lib/env';
import { requireOwnerPage } from '@/server/require-owner';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Autopilot' };

export default async function AutopilotSettingsPage() {
  await requireOwnerPage();
  const db = getDb();
  const now = new Date();
  const timeZone = getEnv().OWNER_TIMEZONE;
  const [status, overview] = await Promise.all([getAutopilotStatus(db, now), getAutopilotOverview(db)]);

  return (
    <>
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Autopilot</CardTitle>
          <CardDescription>
            Autopilot sends simple, well-supported replies by itself after a short delay you can cancel. It starts off, and it can be switched on only after it has proven itself on your own replies. Anything unusual
            still comes to you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AutopilotSwitch paused={status.paused} eligible={status.eligible} checks={status.checks.map((check) => ({ id: check.id, ok: check.ok, title: check.title, detail: check.detail }))} />
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Counting down</CardTitle>
          <CardDescription>Automatic replies waiting to be sent. Cancel one and it waits for you in Approvals instead.</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.scheduled.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing is counting down.</p>
          ) : (
            <ul className="space-y-2">
              {overview.scheduled.map((item) => (
                <ScheduledSendRow
                  key={item.draftId}
                  draftId={item.draftId}
                  conversationId={item.conversationId}
                  name={item.name}
                  sendAtIso={item.sendAt?.toISOString() ?? null}
                  serverNowIso={now.toISOString()}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Conversations on autopilot</CardTitle>
          <CardDescription>Every other conversation stays in approval mode. Switch one on from its own page.</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No conversation is on autopilot.</p>
          ) : (
            <ul className="space-y-2">
              {overview.conversations.map((item) => (
                <AutopilotConversationRow
                  key={item.conversationId}
                  conversationId={item.conversationId}
                  name={item.name}
                  untilLabel={item.until ? formatFullTimestamp(item.until, timeZone) : null}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Rules</CardTitle>
          <CardDescription>The limits autopilot works inside. A reply outside any of them comes to you.</CardDescription>
        </CardHeader>
        <CardContent>
          <AutopilotSettingsForm
            initial={overview.settings}
            intents={ALLOWABLE_INTENTS.map((intent) => ({ id: intent, label: intentLabel(intent) }))}
            delayRange={DELAY_SECONDS}
            maxDisclosureChars={MAX_DISCLOSURE_CHARS}
          />
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Replies you marked bad</CardTitle>
          <CardDescription>Use “Mark bad” on an automatic reply in a conversation. The conversation goes back to approval mode.</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.markedBad.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {overview.markedBad.map((item) => (
                <li key={item.messageId} className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/conversations/${item.conversationId}`} className="font-medium underline-offset-4 hover:underline">
                    {item.name}
                  </Link>
                  <time dateTime={item.markedAt.toISOString()} className="text-xs text-muted-foreground">
                    {formatFullTimestamp(item.markedAt, timeZone)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
