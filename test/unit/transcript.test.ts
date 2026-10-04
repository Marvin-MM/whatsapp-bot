import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_LABEL, UNRELIABLE_LABEL, assessTranscript, segmentStatsOf, transcriptContent } from '@/lib/ai/transcribe';

const ok = { language: 'en', durationInSeconds: 6 };

describe('assessTranscript: only plausible English is trusted', () => {
  it('accepts a normal English transcript', () => {
    expect(assessTranscript({ text: 'Hi, I would like to order the blue dress in size medium please.', ...ok })).toEqual({ status: 'done' });
  });

  it('accepts the language spelled out and any casing', () => {
    expect(assessTranscript({ text: 'please send the price list today', language: 'English', durationInSeconds: 4 }).status).toBe('done');
    expect(assessTranscript({ text: 'please send the price list today', language: 'EN', durationInSeconds: 4 }).status).toBe('done');
  });

  it('distrusts any other detected language: Whisper mislabels Luganda as Swahili or English and invents text', () => {
    const result = assessTranscript({ text: 'Nkulamusizza nnyo, mwebale okutuyamba leero', language: 'sw', durationInSeconds: 5 });
    expect(result).toEqual({ status: 'low_confidence', reasons: ['language_not_english'] });
  });

  it('distrusts a transcript with no language at all', () => {
    expect(assessTranscript({ text: 'some words here that look fine', language: undefined, durationInSeconds: 5 })).toMatchObject({ status: 'low_confidence', reasons: ['language_unknown'] });
  });

  it('flags silence / empty output', () => {
    expect(assessTranscript({ text: '   ', ...ok })).toMatchObject({ status: 'low_confidence', reasons: expect.arrayContaining(['no_speech']) });
    expect(assessTranscript({ text: '...', ...ok })).toMatchObject({ status: 'low_confidence', reasons: expect.arrayContaining(['no_speech']) });
  });

  it('catches a hallucination loop ("thank you thank you thank you ...")', () => {
    const loop = assessTranscript({ text: 'thank you thank you thank you thank you thank you', language: 'en', durationInSeconds: 10 });
    expect(loop).toMatchObject({ status: 'low_confidence' });
    expect(loop.status === 'low_confidence' && loop.reasons).toContain('repetition_loop');
  });

  it('catches a single repeated word too, and a longer repeated phrase', () => {
    const word = assessTranscript({ text: 'okay okay okay okay okay okay', language: 'en', durationInSeconds: 6 });
    expect(word.status === 'low_confidence' && word.reasons).toContain('repetition_loop');
    const phrase = assessTranscript({ text: 'see you at the shop see you at the shop see you at the shop see you at the shop', language: 'en', durationInSeconds: 12 });
    expect(phrase.status === 'low_confidence' && phrase.reasons).toContain('repetition_loop');
  });

  it('does not mistake ordinary repetition for a loop', () => {
    expect(assessTranscript({ text: 'no no I said the blue one not the red one', language: 'en', durationInSeconds: 6 })).toEqual({ status: 'done' });
    expect(assessTranscript({ text: 'thank you so much thank you again', language: 'en', durationInSeconds: 4 })).toEqual({ status: 'done' });
  });

  it('catches a low-variety transcript that is not a strict loop', () => {
    const words = 'yes no yes no yes no yes no yes no yes no yes no yes no';
    const result = assessTranscript({ text: words, language: 'en', durationInSeconds: 10 });
    expect(result.status === 'low_confidence' && result.reasons).toContain('low_vocabulary_variety');
  });

  it('flags an implausible speech rate in either direction', () => {
    const slow = assessTranscript({ text: 'ok', language: 'en', durationInSeconds: 30 });
    expect(slow.status === 'low_confidence' && slow.reasons).toContain('implausible_speech_rate');
    const fast = assessTranscript({ text: Array.from({ length: 80 }, (_, i) => `word${i}`).join(' '), language: 'en', durationInSeconds: 5 });
    expect(fast.status === 'low_confidence' && fast.reasons).toContain('implausible_speech_rate');
  });

  it('does not judge the rate of a very short clip (a single "yes" is normal)', () => {
    expect(assessTranscript({ text: 'yes', language: 'en', durationInSeconds: 1.5 })).toEqual({ status: 'done' });
  });

  it('reports every reason it found, and never the text', () => {
    const result = assessTranscript({ text: 'la la la la la la', language: 'sw', durationInSeconds: 8 });
    expect(result.status).toBe('low_confidence');
    if (result.status === 'low_confidence') {
      expect(result.reasons).toEqual(expect.arrayContaining(['language_not_english', 'repetition_loop']));
      expect(JSON.stringify(result.reasons)).not.toContain('la la');
    }
  });
});

describe('transcriptContent: always labelled machine-made; unreliable text is dropped entirely', () => {
  it('labels a trusted transcript', () => {
    expect(transcriptContent({ status: 'done' }, '  Hello there  ')).toBe(`${TRANSCRIPT_LABEL} Hello there`);
  });

  it('replaces an unreliable transcript with a notice that carries NONE of its text', () => {
    const content = transcriptContent({ status: 'low_confidence', reasons: ['language_not_english'] }, 'secret invented words');
    expect(content).toBe(UNRELIABLE_LABEL);
    expect(content).not.toContain('invented');
  });

  it('caps an absurdly long transcript', () => {
    expect(transcriptContent({ status: 'done' }, 'a '.repeat(10_000)).length).toBeLessThanOrEqual(TRANSCRIPT_LABEL.length + 1 + 4000);
  });
});

describe('Whisper confidence signals', () => {
  const text = 'Hi, I would like to order the blue dress in size medium please.';
  const facts = { text, language: 'en', durationInSeconds: 6 };
  const reasonsOf = (stats: Parameters<typeof assessTranscript>[0]['stats']) => {
    const result = assessTranscript({ ...facts, stats });
    return result.status === 'low_confidence' ? result.reasons : [];
  };

  it('trusts a clean, confident recording', () => {
    expect(assessTranscript({ ...facts, stats: { avgLogprob: -0.2, maxCompressionRatio: 1.4, maxNoSpeechProb: 0.02 } })).toEqual({ status: 'done' });
  });

  it('distrusts a transcript the model itself was unsure about (avg_logprob < -1.0)', () => {
    expect(reasonsOf({ avgLogprob: -1.3 })).toEqual(['low_model_confidence']);
    expect(reasonsOf({ avgLogprob: -1.0 })).toEqual([]); // the boundary is Whisper's own: strictly below
  });

  it('distrusts repetitive output (compression ratio > 2.4)', () => {
    expect(reasonsOf({ maxCompressionRatio: 2.9 })).toEqual(['repetitive_text']);
    expect(reasonsOf({ maxCompressionRatio: 2.4 })).toEqual([]);
  });

  it('distrusts a segment that is probably not speech (no_speech_prob > 0.6)', () => {
    expect(reasonsOf({ maxNoSpeechProb: 0.8 })).toEqual(['probably_not_speech']);
    expect(reasonsOf({ maxNoSpeechProb: 0.6 })).toEqual([]);
  });

  it('works without any stats (the text heuristics still apply)', () => {
    expect(assessTranscript({ ...facts, stats: undefined })).toEqual({ status: 'done' });
    expect(assessTranscript({ ...facts, stats: {} })).toEqual({ status: 'done' });
  });
});

describe('segmentStatsOf: reads Whisper’s numbers from the raw provider body', () => {
  it('weights the mean log-probability by segment length and takes the worst ratio and silence probability', () => {
    const stats = segmentStatsOf({
      segments: [
        { start: 0, end: 9, avg_logprob: -0.2, compression_ratio: 1.2, no_speech_prob: 0.01 },
        { start: 9, end: 10, avg_logprob: -2.0, compression_ratio: 3.1, no_speech_prob: 0.7 },
      ],
    });
    expect(stats.avgLogprob).toBeCloseTo((-0.2 * 9 + -2.0 * 1) / 10, 6);
    expect(stats.maxCompressionRatio).toBe(3.1);
    expect(stats.maxNoSpeechProb).toBe(0.7);
  });

  it('never throws on a body that is not what we expect', () => {
    for (const body of [undefined, null, 'text', 42, [], {}, { segments: 'no' }, { segments: [null, 5, 'x'] }]) {
      expect(() => segmentStatsOf(body)).not.toThrow();
    }
    expect(segmentStatsOf(undefined)).toEqual({ avgLogprob: undefined, maxCompressionRatio: undefined, maxNoSpeechProb: undefined });
  });

  it('copes with segments that lack timing (counted equally)', () => {
    expect(segmentStatsOf({ segments: [{ avg_logprob: -0.4 }, { avg_logprob: -0.6 }] }).avgLogprob).toBeCloseTo(-0.5, 6);
  });
});
