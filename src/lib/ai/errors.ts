/** Failures of an AI call, stripped of anything the model or the customer wrote: safe to log and to store. */

/** The model answered, but not with something that matches the schema, even after one corrective retry. */
export class AiOutputError extends Error {
  constructor(
    readonly purpose: string,
    /** Where it went wrong, e.g. `intent`, `missingFacts.0`. Never the offending value. */
    readonly issues: readonly string[],
  ) {
    super(`model output did not match the ${purpose} schema (${issues.join(', ') || 'unparseable'})`);
    this.name = 'AiOutputError';
  }
}

/** The provider call itself failed (network, timeout, rate limit, 5xx, auth). */
export class AiProviderError extends Error {
  constructor(
    message: string,
    /** True when trying again later may work (timeout, 429, 5xx, network). False for auth and malformed requests. */
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
