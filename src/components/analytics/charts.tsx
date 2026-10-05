'use client';

import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { compactNumber, shortDay } from '@/lib/metrics/chart-format';

/**
 * The charts. Plain data in, pictures out: every number is computed on the server (`lib/metrics/analytics.ts`) and each chart sits beside a
 * table of the same numbers (the page's "Show the numbers"), so nothing is only available as a picture. Colours are the theme's own tokens
 * (they follow dark mode) and every series is also named in the legend, never colour alone.
 */

const HEIGHT = 220;
const AXIS = { fontSize: 12, fill: 'var(--color-muted-foreground)' } as const;
const GRID = 'var(--color-border)';
const TOOLTIP = { contentStyle: { background: 'var(--color-card)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 13, color: 'var(--color-foreground)' } } as const;

// Fewer labels on a long range or a narrow screen: Recharts skips ticks that would overlap when interval is "preserveStartEnd".
const xAxis = <XAxis dataKey="day" tickFormatter={shortDay} tick={AXIS} tickLine={false} axisLine={{ stroke: GRID }} interval="preserveStartEnd" minTickGap={24} />;

export function EditDistanceChart({ data, threshold }: { data: Array<{ day: string; median: number | null; sent: number }>; threshold: number }) {
  return (
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        {xAxis}
        <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(value) => Number(value).toFixed(2)} tick={AXIS} tickLine={false} axisLine={false} width={44} />
        <Tooltip
          {...TOOLTIP}
          labelFormatter={(label) => shortDay(String(label))}
          formatter={(value, _name, item) => [`${Number(value).toFixed(2)} (${(item.payload as { sent: number }).sent} sent)`, 'Median distance']}
        />
        <ReferenceLine y={threshold} stroke="var(--color-warning)" strokeDasharray="4 4" label={{ value: `autopilot limit ${threshold.toFixed(2)}`, position: 'insideTopRight', fill: 'var(--color-warning)', fontSize: 11 }} />
        {/* A day with nothing sent is a GAP, not a zero: a line through zero would claim "perfect" on days nothing was measured. */}
        <Line type="monotone" dataKey="median" name="Median distance" stroke="var(--color-info)" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function VolumeChart({ data }: { data: Array<{ day: string; inbound: number; outbound: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        {xAxis}
        <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} width={40} />
        <Tooltip {...TOOLTIP} labelFormatter={(label) => shortDay(String(label))} cursor={{ fill: 'var(--color-muted)' }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="inbound" name="From customers" fill="var(--color-info)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="outbound" name="Your replies" fill="var(--color-success)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function FirstResponseChart({ data }: { data: Array<{ day: string; minutes: number | null; samples: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        {xAxis}
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={52} tickFormatter={(value) => `${compactNumber(Number(value))} min`} />
        <Tooltip
          {...TOOLTIP}
          labelFormatter={(label) => shortDay(String(label))}
          formatter={(value, _name, item) => [`${Math.round(Number(value))} min (${(item.payload as { samples: number }).samples} first messages)`, 'Median wait']}
        />
        <Line type="monotone" dataKey="minutes" name="Median wait" stroke="var(--color-warning)" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

const OUTCOME_STYLE = [
  { key: 'unedited', name: 'Sent as written', color: 'var(--color-success)' },
  { key: 'edited', name: 'Sent after edits', color: 'var(--color-info)' },
  { key: 'autopilot', name: 'Sent by autopilot', color: 'var(--color-primary)' },
  { key: 'rejected', name: 'Rejected', color: 'var(--color-destructive)' },
  { key: 'superseded', name: 'Replaced', color: 'var(--color-muted-foreground)' },
  { key: 'failed', name: 'Failed', color: 'var(--color-warning)' },
  { key: 'open', name: 'Waiting', color: 'var(--color-border)' },
] as const;

export function OutcomesChart({ data }: { data: Array<{ day: string } & Record<(typeof OUTCOME_STYLE)[number]['key'], number>> }) {
  return (
    <ResponsiveContainer width="100%" height={HEIGHT + 20}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        {xAxis}
        <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} width={40} />
        <Tooltip {...TOOLTIP} labelFormatter={(label) => shortDay(String(label))} cursor={{ fill: 'var(--color-muted)' }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {OUTCOME_STYLE.map((outcome) => (
          <Bar key={outcome.key} dataKey={outcome.key} name={outcome.name} stackId="drafts" fill={outcome.color} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TokensChart({ data }: { data: Array<{ day: string; inputTokens: number; outputTokens: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        {xAxis}
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(value) => compactNumber(Number(value))} />
        <Tooltip {...TOOLTIP} labelFormatter={(label) => shortDay(String(label))} formatter={(value) => compactNumber(Number(value))} cursor={{ fill: 'var(--color-muted)' }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="inputTokens" name="Read by the model" stackId="tokens" fill="var(--color-info)" isAnimationActive={false} />
        <Bar dataKey="outputTokens" name="Written by the model" stackId="tokens" fill="var(--color-warning)" isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

const AUTOPILOT_STYLE = [
  { key: 'sent', name: 'Sent by autopilot', color: 'var(--color-primary)' },
  { key: 'routed', name: 'Handed to you', color: 'var(--color-warning)' },
  { key: 'silent', name: 'Closed without a reply', color: 'var(--color-border)' },
] as const;

export function AutopilotChart({ data }: { data: Array<{ day: string; sent: number; routed: number; silent: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={HEIGHT}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        {xAxis}
        <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} width={40} />
        <Tooltip {...TOOLTIP} labelFormatter={(label) => shortDay(String(label))} cursor={{ fill: 'var(--color-muted)' }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {AUTOPILOT_STYLE.map((item) => (
          <Bar key={item.key} dataKey={item.key} name={item.name} stackId="autopilot" fill={item.color} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
