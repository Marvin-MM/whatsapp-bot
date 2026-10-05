import { z } from 'zod';

/**
 * Message templates: the only thing that may be sent outside the 24-hour window (spec 6.4).
 *
 * Meta's template reference was unreachable when this was written (D-031), so the parts of it we depend on are kept small and
 * DEFENSIVE: anything this module does not fully understand is shown to the owner as "not supported here" with a reason, never
 * sent with a guess. v1 supports exactly: an APPROVED template whose body takes text values (positional `{{1}}` or named
 * `{{customer_name}}`), with an optional text footer, an optional header that has no variables, and quick-reply / phone / static
 * URL buttons. Media headers, buttons with variables, carousels, limited-time offers and authentication (OTP) templates are
 * listed but disabled. This file is pure (no network): `templates-client.ts` fetches and caches.
 */

export const MAX_PARAM_LENGTH = 1024;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

const rawComponentSchema = z.looseObject({
  type: z.string(),
  format: z.string().optional(),
  text: z.string().optional(),
  buttons: z.array(z.looseObject({ type: z.string().optional(), url: z.string().optional() })).optional(),
});

export const rawTemplateSchema = z.looseObject({
  name: z.string().min(1),
  language: z.string().min(1),
  status: z.string().optional(),
  category: z.string().optional(),
  parameter_format: z.string().optional(),
  components: z.array(rawComponentSchema).default([]),
});
export type RawTemplate = z.infer<typeof rawTemplateSchema>;

export interface TemplateSummary {
  /** `${name}/${language}`: a template name can exist in several languages. */
  key: string;
  name: string;
  language: string;
  category: string;
  status: string;
  /** The body as written, placeholders intact. */
  body: string;
  paramFormat: 'positional' | 'named';
  /** Distinct placeholder names in order of first appearance (`1`, `2` ... or the named ones). */
  params: string[];
  supported: boolean;
  /** Plain words, only when `supported` is false. */
  unsupportedReason: string | null;
}

function placeholdersOf(text: string): string[] {
  const seen: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

function unsupportedReason(raw: RawTemplate, params: string[], format: 'positional' | 'named'): string | null {
  const status = (raw.status ?? '').toUpperCase();
  if (status !== 'APPROVED') {
    const reason: Record<string, string> = {
      PENDING: 'WhatsApp has not approved this template yet.',
      REJECTED: 'WhatsApp rejected this template.',
      PAUSED: 'WhatsApp has paused this template because of low quality.',
      DISABLED: 'WhatsApp has disabled this template.',
      IN_APPEAL: 'This template is in appeal.',
    };
    return reason[status] ?? `This template is not approved (status: ${status || 'unknown'}).`;
  }
  if ((raw.category ?? '').toUpperCase() === 'AUTHENTICATION') return 'Authentication (one-time code) templates are not supported here.';
  const body = raw.components.find((component) => component.type.toUpperCase() === 'BODY');
  if (!body || body.text === undefined) return 'This template has no text body.';
  if (format === 'positional') {
    const expected = params.map((_, index) => String(index + 1));
    if (params.some((name, index) => name !== expected[index])) return 'This template’s numbered values are not in order (1, 2, 3 ...), so it cannot be filled in safely.';
  }

  for (const component of raw.components) {
    switch (component.type.toUpperCase()) {
      case 'BODY':
      case 'FOOTER':
        break;
      case 'HEADER':
        if ((component.format ?? 'TEXT').toUpperCase() !== 'TEXT') return `This template has a ${(component.format ?? 'media').toLowerCase()} header, which is not supported here.`;
        if (component.text !== undefined && placeholdersOf(component.text).length > 0) return 'This template has a header with values, which is not supported here.';
        break;
      case 'BUTTONS':
        for (const button of component.buttons ?? []) {
          const type = (button.type ?? '').toUpperCase();
          if (type === 'URL' && (button.url ?? '').includes('{{')) return 'This template has a button link with a value, which is not supported here.';
          if (type !== 'QUICK_REPLY' && type !== 'PHONE_NUMBER' && type !== 'URL') return 'This template has a button type that is not supported here.';
        }
        break;
      default:
        return `This template uses a "${component.type.toLowerCase()}" component, which is not supported here.`;
    }
  }
  return null;
}

export function summariseTemplate(raw: RawTemplate): TemplateSummary {
  const body = raw.components.find((component) => component.type.toUpperCase() === 'BODY')?.text ?? '';
  const params = placeholdersOf(body);
  // Meta says which format a template uses; fall back to what the placeholders look like.
  const format: 'positional' | 'named' =
    (raw.parameter_format ?? '').toUpperCase() === 'NAMED' ? 'named' : params.length > 0 && params.every((name) => /^\d+$/.test(name)) ? 'positional' : params.length === 0 ? 'positional' : 'named';
  const reason = unsupportedReason(raw, params, format);
  return {
    key: `${raw.name}/${raw.language}`,
    name: raw.name,
    language: raw.language,
    category: (raw.category ?? 'UNKNOWN').toUpperCase(),
    status: (raw.status ?? 'UNKNOWN').toUpperCase(),
    body,
    paramFormat: format,
    params,
    supported: reason === null,
    unsupportedReason: reason,
  };
}

export type ParamProblem = { param: string; message: string };

/** WhatsApp rejects text values with line breaks, tabs or runs of 4+ spaces (error 132018; unverified, kept conservative). */
export function validateParamValue(value: string): string | null {
  if (value.trim() === '') return 'Fill this in.';
  if (/[\n\r\t]/.test(value)) return 'No line breaks or tabs: WhatsApp rejects them in template values.';
  if (/ {4,}/.test(value)) return 'No runs of 4 or more spaces: WhatsApp rejects them in template values.';
  if (value.length > MAX_PARAM_LENGTH) return `At most ${MAX_PARAM_LENGTH} characters.`;
  return null;
}

/** The body with the owner's values in: what the customer will read, what the pre-check inspects, what is stored. */
export function renderTemplateBody(summary: TemplateSummary, values: Readonly<Record<string, string>>): string {
  return summary.body.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole);
}

export type ResolveResult =
  | {
      ok: true;
      resolved: { name: string; language: string; components: Array<Record<string, unknown>>; renderedContent: string };
    }
  | { ok: false; error: string; problems: ParamProblem[] };

/** Checks the owner's values against the template and builds the exact `components` Meta expects. Never guesses a value. */
export function resolveTemplate(summary: TemplateSummary, values: Readonly<Record<string, string>>): ResolveResult {
  if (!summary.supported) return { ok: false, error: summary.unsupportedReason ?? 'This template cannot be sent from here.', problems: [] };

  const problems: ParamProblem[] = [];
  for (const param of summary.params) {
    const problem = validateParamValue(values[param] ?? '');
    if (problem) problems.push({ param, message: problem });
  }
  const extra = Object.keys(values).filter((name) => !summary.params.includes(name));
  if (extra.length > 0) return { ok: false, error: 'That template does not take those values.', problems: extra.map((param) => ({ param, message: 'Not a value of this template.' })) };
  if (problems.length > 0) return { ok: false, error: 'Some values need fixing.', problems };

  const components: Array<Record<string, unknown>> =
    summary.params.length === 0
      ? []
      : [
          {
            type: 'body',
            parameters: summary.params.map((param) =>
              summary.paramFormat === 'named' ? { type: 'text', parameter_name: param, text: values[param] } : { type: 'text', text: values[param] },
            ),
          },
        ];
  return { ok: true, resolved: { name: summary.name, language: summary.language, components, renderedContent: renderTemplateBody(summary, values) } };
}
