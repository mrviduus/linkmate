/**
 * Heuristic topic tagger — keyword lists per topic.
 *
 * Pure: no IO, no AI. Returns 0-3 tags sorted by hit count (most-matched first).
 * Used at action-log append time to attribute each action to a topic, then
 * surfaced in popup as a Top-N distribution chip row.
 *
 * v2 (later): swap to a single cached AI call per postId. The signature stays
 * the same — callers don't change.
 */

const TOPICS: Record<string, RegExp[]> = {
  AI: [
    /\b(ai|llm|gpt|chatgpt|claude|gemini|anthropic|openai|mlops?|rag|agents?)\b/i,
    /\b(machine learning|deep learning|neural net|transformer|embedding)\b/i,
  ],
  Leadership: [
    /\b(leadership|manager|management|leading|leader|culture|coaching|mentor)\b/i,
    /\b(decision[-\s]?making|delegation|1[-:\s]?on[-\s]?1)\b/i,
  ],
  Hiring: [
    /\b(hiring|recruit(ing|ers?)?|interview|candidate|job\s*search|laid\s*off|layoffs?)\b/i,
    /\b(we['']?re hiring|open\s+role|join\s+us|career\s+opportunity)\b/i,
  ],
  Web3: [
    /\b(web3|crypto|blockchain|nft|defi|dao|token|ethereum|bitcoin|smart\s+contract)\b/i,
  ],
  Career: [
    /\b(career|promotion|pivot|transition|growth|raise|salary|negotiation)\b/i,
    /\b(side[-\s]?project|portfolio|imposter syndrome)\b/i,
  ],
  Startup: [
    /\b(startup|founder|seed|series\s*[a-d]|venture|vc|funding|pitch|runway|burn)\b/i,
    /\b(yc|y[-\s]?combinator|angel|pre[-\s]?seed)\b/i,
  ],
  DevTools: [
    /\b(devtool|developer\s+experience|dx|cli|api|sdk|framework|library)\b/i,
    /\b(typescript|javascript|rust|python|golang|kubernetes|docker|terraform)\b/i,
  ],
  Product: [
    /\b(product\s+(management|managers?|design|strategy)|pm|roadmap|user\s+research)\b/i,
    /\b(mvp|product[-\s]?market[-\s]?fit|pmf)\b/i,
  ],
  Marketing: [
    /\b(marketing|seo|sem|content\s+marketing|brand|copywriting|ads?|campaign)\b/i,
    /\b(linkedin\s+algorithm|engagement|reach|impressions)\b/i,
  ],
  Sales: [
    /\b(sales|prospecting|outbound|cold\s*(email|outreach)|crm|pipeline|quota|sdr|bdr)\b/i,
  ],
  Design: [
    /\b(design(er)?|ux|ui|figma|prototype|wireframe|user\s+interface)\b/i,
  ],
  Remote: [
    /\b(remote\s+(work|team|first)|wfh|work\s+from\s+home|async\s+work|distributed)\b/i,
  ],
  Productivity: [
    /\b(productivity|focus|deep\s+work|time\s+management|gtd|inbox\s+zero)\b/i,
  ],
};

/**
 * Tag text with up to `max` topics. Empty array if no keyword hit.
 * Multiple matches inside one topic only count once toward selection;
 * sorted by total regex hit count across all patterns for that topic.
 */
export function tagText(text: string, max = 3): string[] {
  if (!text || text.length < 5) return [];
  const scores: Array<{ topic: string; hits: number }> = [];
  for (const [topic, patterns] of Object.entries(TOPICS)) {
    let hits = 0;
    for (const re of patterns) {
      const m = text.match(re);
      if (m) hits += 1;
    }
    if (hits > 0) scores.push({ topic, hits });
  }
  scores.sort((a, b) => b.hits - a.hits || a.topic.localeCompare(b.topic));
  return scores.slice(0, max).map((s) => s.topic);
}

/** All known topic names — used in tests + UI legend if needed. */
export function knownTopics(): string[] {
  return Object.keys(TOPICS);
}
