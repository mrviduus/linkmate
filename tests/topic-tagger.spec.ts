import { tagText, knownTopics } from '../src/topic-tagger';

describe('topic-tagger.tagText', () => {
  it('returns empty array for short or empty input', () => {
    expect(tagText('')).toEqual([]);
    expect(tagText('hi')).toEqual([]);
    expect(tagText('  ')).toEqual([]);
  });

  it('tags an AI post', () => {
    const tags = tagText("We're building an LLM-powered RAG agent with embeddings on top of GPT-4.");
    expect(tags).toContain('AI');
  });

  it('tags a hiring post', () => {
    const tags = tagText("We're hiring senior engineers — open role on the platform team, apply via the link.");
    expect(tags).toContain('Hiring');
  });

  it('tags multi-topic posts', () => {
    const tags = tagText(
      'As a startup founder I just raised a Series A and we are hiring senior product managers in Toronto.',
    );
    expect(tags).toContain('Startup');
    expect(tags).toContain('Hiring');
    expect(tags).toContain('Product');
  });

  it('caps at max=3 by default, sorted by hit count', () => {
    // Stuff a paragraph that hits many topics — should still cap at 3.
    const text =
      'AI LLM GPT MLOps. Leadership coaching mentor 1:1. Hiring recruit interview. Startup founder seed Series A YC. ' +
      'Web3 crypto blockchain NFT. Product PMF roadmap PM.';
    const tags = tagText(text);
    expect(tags.length).toBe(3);
  });

  it('honors custom max', () => {
    const text = 'AI LLM. Hiring. Startup. Web3. Product PM.';
    expect(tagText(text, 1).length).toBe(1);
    expect(tagText(text, 5).length).toBeLessThanOrEqual(5);
  });

  it('returns empty when no keywords match', () => {
    expect(tagText('Just got back from a walk in the park, lovely weather today.')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(tagText('LEADERSHIP IS HARD')).toContain('Leadership');
    expect(tagText('leadership is hard')).toContain('Leadership');
  });
});

describe('topic-tagger.knownTopics', () => {
  it('includes expected core topics', () => {
    const topics = knownTopics();
    expect(topics).toEqual(
      expect.arrayContaining(['AI', 'Leadership', 'Hiring', 'Startup', 'Product']),
    );
  });
});
