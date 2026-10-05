import type { Metadata } from 'next';
import Link from 'next/link';
import { ChartCard, Figure } from '@/components/analytics/chart-card';
import { EditDistanceChart, FirstResponseChart, OutcomesChart, TokensChart, VolumeChart } from '@/components/analytics/charts';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { getDb } from '@/lib/db';
import { getEnv, readAiPrices } from '@/lib/env';
import { RANGE_DAYS, type RangeDays, getAnalytics } from '@/lib/metrics/analytics';
import { compactNumber, distance, money, percent, shortDay } from '@/lib/metrics/chart-format';
import { formatDuration } from '@/lib/metrics/response-time';
import { TASK_TYPE_LABEL } from '@/lib/tasks/present';
import { requireOwnerPage } from '@/server/require-owner';

export const metadata: Metadata = { title: 'Analytics' };

const parseDays = (value: string | string[] | undefined): RangeDays => {
  const wanted = Number(Array.isArray(value) ? value[0] : value);
  return (RANGE_DAYS as readonly number[]).includes(wanted) ? (wanted as RangeDays) : 30;
};

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwnerPage();
  const days = parseDays((await searchParams).days);
  const env = getEnv();
  const data = await getAnalytics(getDb(), { now: new Date(), days, timeZone: env.OWNER_TIMEZONE, prices: readAiPrices(env.AI_PRICE_PER_MTOK_JSON) });

  const { volume, firstResponse, drafts, editDistance, tasks, ai } = data;
  const anyMessages = volume.some((day) => day.inbound + day.outbound > 0);
  const anyDrafts = Object.values(drafts.totals).some((n) => n > 0);
  const sentTotal = drafts.totals.unedited + drafts.totals.edited + drafts.totals.autopilot;

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Volume, response time, and how close the drafts are to what you actually send. Days are your own calendar days."
        hideDescriptionOnPhone
        actions={
          <nav aria-label="Period" className="flex gap-1">
            {RANGE_DAYS.map((option) => (
              <Link
                key={option}
                href={`/analytics?days=${option}`}
                aria-current={option === days ? 'page' : undefined}
                className={`inline-flex h-9 items-center rounded-full border px-3 text-sm ${option === days ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-muted'}`}
              >
                {option} days
              </Link>
            ))}
          </nav>
        }
      />

      {!anyMessages && !anyDrafts ? (
        <EmptyState title="Not enough data yet" description={`Charts appear once there are conversations in the last ${days} days.`} />
      ) : (
        <div className="space-y-4">
          <ChartCard
            title="How close are drafts to what you send?"
            definition="For every draft you sent, how far your final text is from what the assistant wrote: 0 = sent exactly as drafted, 1 = nothing in common. The line is the median per day (a gap is a day with nothing sent). This is the number that decides whether autopilot is ever worth switching on."
            empty={editDistance.sent === 0 ? `No drafts were sent in the last ${days} days.` : undefined}
            table={{ columns: ['Day', 'Median distance', 'Drafts sent'], rows: editDistance.byDay.map((d) => [shortDay(d.day), distance(d.median), d.sent]) }}
          >
            <dl className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Figure label="Median distance" value={distance(editDistance.median)} hint="over the whole period" />
              <Figure label="75th percentile" value={distance(editDistance.p75)} hint="a quarter of drafts changed more" />
              <Figure label="Drafts sent" value={String(editDistance.sent)} />
              <Figure label="Edited" value={percent(editDistance.editedShare)} hint="sent after you changed them" />
            </dl>
            <EditDistanceChart data={editDistance.byDay} threshold={env.AUTOPILOT_MAX_EDIT_DISTANCE} />
          </ChartCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="Messages per day"
              definition="Live messages from customers and your accepted replies (including ones typed on your phone). Reactions, imported history and failed sends are not counted."
              empty={!anyMessages ? `No messages in the last ${days} days.` : undefined}
              table={{ columns: ['Day', 'From customers', 'Your replies'], rows: volume.map((d) => [shortDay(d.day), d.inbound, d.outbound]) }}
            >
              <VolumeChart data={volume} />
            </ChartCard>

            <ChartCard
              title="How fast you reply"
              definition="The median wait between a customer starting a new turn and your first reply, by the day they wrote. Nights and weekends are included: the customer waited that long."
              empty={firstResponse.samples === 0 ? `No answered messages in the last ${days} days.` : undefined}
              table={{
                columns: ['Day', 'Median wait', 'First messages answered'],
                rows: firstResponse.byDay.map((d) => [shortDay(d.day), d.medianSeconds === null ? '–' : formatDuration(d.medianSeconds), d.samples]),
              }}
            >
              <dl className="mb-3 grid grid-cols-2 gap-3">
                <Figure label="Median wait" value={firstResponse.medianSeconds === null ? '–' : formatDuration(firstResponse.medianSeconds)} hint="over the whole period" />
                <Figure label="Answered" value={String(firstResponse.samples)} hint="first messages" />
              </dl>
              <FirstResponseChart data={firstResponse.byDay.map((d) => ({ day: d.day, minutes: d.medianSeconds === null ? null : Math.round((d.medianSeconds / 60) * 10) / 10, samples: d.samples }))} />
            </ChartCard>
          </div>

          <ChartCard
            title="What happened to the drafts"
            definition="Each draft by the day it was written: sent as written, sent after your edits, sent by autopilot, rejected, replaced (the customer wrote again or you asked for a new one), failed, or still waiting."
            empty={!anyDrafts ? `No drafts were written in the last ${days} days.` : undefined}
            table={{
              columns: ['Day', 'As written', 'Edited', 'Autopilot', 'Rejected', 'Replaced', 'Failed', 'Waiting'],
              rows: drafts.byDay.map((d) => [shortDay(d.day), d.unedited, d.edited, d.autopilot, d.rejected, d.superseded, d.failed, d.open]),
            }}
          >
            <p className="mb-3 text-sm">
              <strong>{sentTotal}</strong> sent ({drafts.totals.unedited} as written, {drafts.totals.edited} edited, {drafts.totals.autopilot} by autopilot), <strong>{drafts.totals.rejected}</strong> rejected,{' '}
              <strong>{drafts.totals.superseded}</strong> replaced, <strong>{drafts.totals.failed}</strong> failed, <strong>{drafts.totals.open}</strong> waiting.
            </p>
            <OutcomesChart data={drafts.byDay} />
          </ChartCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="Tasks by kind"
              definition="Tasks created in this period, by kind, and where they stand now. “By the assistant” are the ones it noted after your replies."
              empty={tasks.every((t) => t.open + t.done + t.cancelled === 0) ? `No tasks were created in the last ${days} days.` : undefined}
              table={{
                columns: ['Kind', 'Open', 'Done', 'Cancelled', 'By the assistant', 'By you'],
                rows: tasks.map((t) => [TASK_TYPE_LABEL[t.type], t.open, t.done, t.cancelled, t.byAssistant, t.byOwner]),
              }}
            >
              <ul className="space-y-3">
                {tasks.map((t) => {
                  const total = t.open + t.done + t.cancelled;
                  return (
                    <li key={t.type}>
                      <div className="mb-1 flex items-baseline justify-between text-sm">
                        <span className="font-medium">{TASK_TYPE_LABEL[t.type]}</span>
                        <span className="text-muted-foreground">
                          {total} · {t.open} open · {t.done} done · {t.cancelled} cancelled
                        </span>
                      </div>
                      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${TASK_TYPE_LABEL[t.type]}: ${t.open} open, ${t.done} done, ${t.cancelled} cancelled`}>
                        {total > 0 ? (
                          <>
                            <div className="bg-warning" style={{ width: `${(t.open / total) * 100}%` }} />
                            <div className="bg-success" style={{ width: `${(t.done / total) * 100}%` }} />
                            <div className="bg-muted-foreground/50" style={{ width: `${(t.cancelled / total) * 100}%` }} />
                          </>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </ChartCard>

            <ChartCard
              title="AI usage"
              definition={`Tokens the models read and wrote, as the provider reported them${ai.currency ? `; cost from the prices you configured (${ai.currency} per million tokens)` : '. No prices are configured, so no cost is shown: set AI_PRICE_PER_MTOK_JSON to see one'}.`}
              empty={ai.totals.calls === 0 ? `No model calls in the last ${days} days.` : undefined}
              table={{
                columns: ['Day', 'Calls', 'Failed', 'Read', 'Written', ...(ai.currency ? [`Cost (${ai.currency})`] : [])],
                rows: ai.byDay.map((d) => [shortDay(d.day), d.calls, d.failed, d.inputTokens, d.outputTokens, ...(ai.currency ? [d.cost === null ? '–' : d.cost.toFixed(5)] : [])]),
              }}
            >
              <dl className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Figure label="Calls" value={String(ai.totals.calls)} hint={ai.totals.failed > 0 ? `${ai.totals.failed} failed` : 'none failed'} />
                <Figure label="Read" value={compactNumber(ai.totals.inputTokens)} hint="tokens" />
                <Figure label="Written" value={compactNumber(ai.totals.outputTokens)} hint="tokens" />
                {ai.currency && ai.totals.cost !== null ? <Figure label="Cost" value={money(ai.totals.cost, ai.currency)} hint={ai.unpricedModels.length > 0 ? `at least: no price for ${ai.unpricedModels.join(', ')}` : undefined} /> : null}
              </dl>
              <TokensChart data={ai.byDay} />
              <ul className="mt-2 text-xs text-muted-foreground">
                {ai.byPurpose.map((p) => (
                  <li key={p.purpose}>
                    {p.purpose}: {p.calls} calls, {compactNumber(p.inputTokens)} read, {compactNumber(p.outputTokens)} written
                  </li>
                ))}
              </ul>
            </ChartCard>
          </div>

          <p className="text-xs text-muted-foreground">
            Autopilot sent versus sent for your approval appears here once autopilot is used (it is off). {sentTotal === 0 ? '' : `In this period: ${drafts.totals.autopilot} sent by autopilot.`}
          </p>
        </div>
      )}
    </>
  );
}
