import { z } from 'zod';

/** Output of style extraction (spec §9.6). Stored as JSONB in `style_guides.content`. */
export const styleGuideContentSchema = z.object({
  tone: z.string(),
  sentenceLength: z.string(),
  punctuationAndCase: z.string(),
  emojiUsage: z.string(),
  languageMixing: z.string(),
  greetingsAndSignoffs: z.array(z.string()),
  vocabulary: z.array(z.string()).max(40),
  commonPhrases: z.array(z.string()).max(40),
  structuralPatterns: z.array(z.string()).max(20),
  forbiddenPatterns: z.array(z.string()).max(30),
});

export type StyleGuideContent = z.infer<typeof styleGuideContentSchema>;
