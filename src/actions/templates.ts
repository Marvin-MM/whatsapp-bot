'use server';

import { z } from 'zod';
import { ActionRefusal, type ActionResult } from '@/lib/actions/owner-action-core';
import { type TemplateSummary } from '@/lib/whatsapp/templates';
import { TemplatesUnavailableError, loadTemplates } from '@/lib/whatsapp/templates-client';
import { ownerQuery } from './owner-action';

export interface TemplateListView {
  templates: TemplateSummary[];
  fetchedAt: string;
  stale: boolean;
}

const list = ownerQuery({
  name: 'templates.list',
  schema: z.object({ refresh: z.boolean().optional() }),
  handler: async ({ input }): Promise<TemplateListView> => {
    try {
      const result = await loadTemplates({ force: input.refresh === true });
      return { templates: result.templates, fetchedAt: result.fetchedAt.toISOString(), stale: result.stale };
    } catch (error) {
      if (error instanceof TemplatesUnavailableError) throw new ActionRefusal('templates_unavailable', `${error.message} Check the access token in Settings.`);
      throw error;
    }
  },
});

/** The account's templates for the picker (cached for five minutes; `refresh` forces a fetch). Read-only. */
export async function listTemplates(input: unknown): Promise<ActionResult<TemplateListView>> {
  return list(input);
}
