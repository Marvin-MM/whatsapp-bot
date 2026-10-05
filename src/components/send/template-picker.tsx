'use client';

import { RefreshCw } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { listTemplates } from '@/actions/templates';
import type { TemplateListView } from '@/actions/templates';
import { sendTemplate } from '@/actions/send';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { renderTemplateBody, validateParamValue } from '@/lib/whatsapp/templates';
import { newIdempotencyKey } from './new-key';

type Load = { state: 'loading' } | { state: 'ready'; list: TemplateListView } | { state: 'error'; message: string };

/**
 * Sends an approved template: the only thing WhatsApp allows outside the 24-hour window. The list comes from Meta (cached five
 * minutes); a template this app cannot fill in safely is listed with the reason instead of being offered.
 */
export function TemplatePicker({ conversationId, onSent }: { conversationId: string; onSent: () => void }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [selected, setSelected] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const key = useRef(newIdempotencyKey());
  const selectId = useId();

  const fetchList = (refresh: boolean) => {
    setLoad({ state: 'loading' });
    void listTemplates({ refresh }).then((result) => {
      if (result.ok) setLoad({ state: 'ready', list: result.data });
      else setLoad({ state: 'error', message: result.error.message });
    });
  };

  useEffect(() => {
    let cancelled = false;
    void listTemplates({}).then((result) => {
      if (cancelled) return;
      setLoad(result.ok ? { state: 'ready', list: result.data } : { state: 'error', message: result.error.message });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const list = load.state === 'ready' ? load.list : null;
  const usable = useMemo(() => list?.templates.filter((template) => template.supported) ?? [], [list]);
  const unusable = useMemo(() => list?.templates.filter((template) => !template.supported) ?? [], [list]);
  const template = usable.find((candidate) => candidate.key === selected) ?? null;

  const problems = template ? template.params.map((param) => [param, validateParamValue(values[param] ?? '')] as const).filter(([, problem]) => problem !== null) : [];
  const ready = template !== null && problems.length === 0;

  const submit = () => {
    if (!template || !ready) return;
    setError(null);
    startTransition(async () => {
      const result = await sendTemplate({ conversationId, templateKey: template.key, values, idempotencyKey: key.current });
      if (result.ok) {
        key.current = newIdempotencyKey();
        setValues({});
        setSelected('');
        onSent();
      } else {
        setError(result.error.message);
      }
    });
  };

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={selectId}>Template</Label>
        <button
          type="button"
          onClick={() => fetchList(true)}
          disabled={load.state === 'loading'}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw aria-hidden="true" className="h-3 w-3" />
          Refresh list
        </button>
      </div>

      {load.state === 'loading' ? <p className="text-muted-foreground">Loading templates…</p> : null}
      {load.state === 'error' ? (
        <p role="alert" className="text-destructive">
          {load.message}
        </p>
      ) : null}

      {list ? (
        <>
          {list.stale ? <p className="text-xs text-warning">Meta could not be reached: this is an older copy of your template list.</p> : null}
          {usable.length === 0 ? (
            <p className="text-muted-foreground">No template can be sent from here. Create and get one approved in WhatsApp Manager first.</p>
          ) : (
            <select
              id={selectId}
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value);
                setValues({});
                setError(null);
              }}
              className="h-10 w-full rounded-md border border-input bg-card px-3 text-base md:text-sm"
            >
              <option value="">Choose a template…</option>
              {usable.map((candidate) => (
                <option key={candidate.key} value={candidate.key}>
                  {candidate.name} ({candidate.language})
                </option>
              ))}
            </select>
          )}

          {template ? (
            <div className="space-y-3">
              {template.params.map((param) => {
                const problem = values[param] === undefined ? null : validateParamValue(values[param]);
                const id = `${selectId}-${param}`;
                return (
                  <div key={param} className="space-y-1">
                    <Label htmlFor={id}>{template.paramFormat === 'positional' ? `Value ${param}` : param.replaceAll('_', ' ')}</Label>
                    <Input
                      id={id}
                      value={values[param] ?? ''}
                      onChange={(event) => setValues((previous) => ({ ...previous, [param]: event.target.value }))}
                      aria-invalid={problem !== null}
                      aria-describedby={problem ? `${id}-problem` : undefined}
                    />
                    {problem ? (
                      <p id={`${id}-problem`} className="text-xs text-destructive">
                        {problem}
                      </p>
                    ) : null}
                  </div>
                );
              })}
              <div className="rounded-lg bg-muted p-3">
                <p className="mb-1 text-xs font-medium text-muted-foreground">The customer will read</p>
                <p className="whitespace-pre-wrap break-words" data-testid="template-preview">
                  {renderTemplateBody(template, values)}
                </p>
              </div>
              <Button type="button" onClick={submit} disabled={!ready || pending} className="w-full sm:w-auto">
                {pending ? 'Sending…' : 'Send template'}
              </Button>
            </div>
          ) : null}

          {unusable.length > 0 ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Not available from here ({unusable.length})</summary>
              <ul className="mt-2 space-y-1">
                {unusable.map((candidate) => (
                  <li key={candidate.key}>
                    <span className="font-medium text-foreground">
                      {candidate.name} ({candidate.language})
                    </span>
                    : {candidate.unsupportedReason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}

      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
