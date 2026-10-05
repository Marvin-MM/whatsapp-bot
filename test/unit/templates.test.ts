import { describe, expect, it } from 'vitest';
import { type RawTemplate, rawTemplateSchema, renderTemplateBody, resolveTemplate, summariseTemplate, validateParamValue } from '@/lib/whatsapp/templates';

const raw = (over: Record<string, unknown> = {}): RawTemplate =>
  rawTemplateSchema.parse({
    name: 'order_update',
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hello {{1}}, your order {{2}} is ready.' }],
    ...over,
  });

describe('summariseTemplate', () => {
  it('reads an approved positional template and lists its values in order', () => {
    expect(summariseTemplate(raw())).toMatchObject({
      key: 'order_update/en',
      supported: true,
      unsupportedReason: null,
      paramFormat: 'positional',
      params: ['1', '2'],
      category: 'UTILITY',
    });
  });

  it('reads a named template, and a repeated placeholder is ONE value', () => {
    const summary = summariseTemplate(
      raw({ parameter_format: 'NAMED', components: [{ type: 'BODY', text: 'Hi {{customer_name}}, bye {{customer_name}} ({{ order_id }})' }] }),
    );
    expect(summary).toMatchObject({ paramFormat: 'named', params: ['customer_name', 'order_id'], supported: true });
  });

  it('a template with no values is supported and needs no components', () => {
    const summary = summariseTemplate(raw({ components: [{ type: 'BODY', text: 'We are open until 6pm.' }] }));
    expect(summary).toMatchObject({ supported: true, params: [] });
    expect(resolveTemplate(summary, {})).toMatchObject({ ok: true, resolved: { components: [], renderedContent: 'We are open until 6pm.' } });
  });

  it.each([
    ['PENDING', /not approved/i],
    ['REJECTED', /rejected/i],
    ['PAUSED', /paused/i],
    ['DISABLED', /disabled/i],
    ['SOMETHING_NEW', /not approved \(status: SOMETHING_NEW\)/],
  ])('disables a %s template with a reason', (status, reason) => {
    const summary = summariseTemplate(raw({ status }));
    expect(summary.supported).toBe(false);
    expect(summary.unsupportedReason).toMatch(reason);
  });

  it.each([
    ['an image header', { components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'x' }] }, /image header/],
    ['a header with a value', { components: [{ type: 'HEADER', format: 'TEXT', text: 'Order {{1}}' }, { type: 'BODY', text: 'x' }] }, /header with values/],
    ['a button link with a value', { components: [{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://x.test/{{1}}' }] }] }, /button link with a value/],
    ['a one-time-code button', { components: [{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'OTP' }] }] }, /button type/],
    ['a carousel', { components: [{ type: 'BODY', text: 'x' }, { type: 'CAROUSEL' }] }, /carousel/],
    ['no body', { components: [{ type: 'FOOTER', text: 'x' }] }, /no text body/],
    ['an authentication category', { category: 'AUTHENTICATION' }, /one-time code/],
    ['numbered values out of order', { components: [{ type: 'BODY', text: '{{2}} then {{1}}' }] }, /not in order/],
    ['a gap in numbered values', { components: [{ type: 'BODY', text: '{{1}} and {{3}}' }] }, /not in order/],
  ])('disables a template with %s', (_name, over, reason) => {
    const summary = summariseTemplate(raw(over));
    expect(summary.supported).toBe(false);
    expect(summary.unsupportedReason).toMatch(reason);
  });

  it('allows quick-reply, phone and static-link buttons and a text footer', () => {
    const summary = summariseTemplate(
      raw({
        components: [
          { type: 'BODY', text: 'Hi {{1}}' },
          { type: 'FOOTER', text: 'Reply STOP to opt out' },
          { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY' }, { type: 'PHONE_NUMBER' }, { type: 'URL', url: 'https://shop.example/menu' }] },
        ],
      }),
    );
    expect(summary.supported).toBe(true);
  });
});

describe('resolveTemplate', () => {
  const summary = summariseTemplate(raw());

  it('builds positional body components and the exact text the customer will read', () => {
    const result = resolveTemplate(summary, { '1': 'Amina', '2': '#1042' });
    expect(result).toEqual({
      ok: true,
      resolved: {
        name: 'order_update',
        language: 'en',
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Amina' }, { type: 'text', text: '#1042' }] }],
        renderedContent: 'Hello Amina, your order #1042 is ready.',
      },
    });
  });

  it('puts `parameter_name` on named parameters', () => {
    const named = summariseTemplate(raw({ parameter_format: 'NAMED', components: [{ type: 'BODY', text: 'Hi {{customer_name}}' }] }));
    expect(resolveTemplate(named, { customer_name: 'Amina' })).toMatchObject({
      ok: true,
      resolved: { components: [{ type: 'body', parameters: [{ type: 'text', parameter_name: 'customer_name', text: 'Amina' }] }] },
    });
  });

  it('never guesses: a missing value is a problem naming that value', () => {
    const result = resolveTemplate(summary, { '1': 'Amina' });
    expect(result).toMatchObject({ ok: false, problems: [{ param: '2' }] });
  });

  it('refuses values the template does not have (a typo is not silently dropped)', () => {
    expect(resolveTemplate(summary, { '1': 'a', '2': 'b', '3': 'c' })).toMatchObject({ ok: false, problems: [{ param: '3' }] });
  });

  it('refuses an unsupported template with its reason', () => {
    const paused = summariseTemplate(raw({ status: 'PAUSED' }));
    expect(resolveTemplate(paused, { '1': 'a', '2': 'b' })).toMatchObject({ ok: false, error: expect.stringMatching(/paused/i) });
  });

  it('values are inserted verbatim: a value that looks like a placeholder is not expanded again', () => {
    expect(renderTemplateBody(summary, { '1': '{{2}}', '2': 'X' })).toBe('Hello {{2}}, your order X is ready.');
  });
});

describe('validateParamValue', () => {
  it.each([
    ['', /fill/i],
    ['   ', /fill/i],
    ['two\nlines', /line breaks/],
    ['tab\there', /tabs/],
    ['a    b', /4 or more spaces/],
    ['x'.repeat(1025), /1024/],
  ])('rejects %j', (value, reason) => {
    expect(validateParamValue(value)).toMatch(reason);
  });
  it('accepts ordinary values, including a few spaces and Luganda', () => {
    for (const value of ['Amina', 'Kampala Road, Shop 4', 'Webale nnyo   mukwano', 'UGX 50,000']) expect(validateParamValue(value)).toBeNull();
  });
});
