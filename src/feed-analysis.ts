import type { ParsedPost, ProfileContext, RelevanceScore, FeedPostAnalysis } from './storage-schema';
import { tagText } from './topic-tagger';

const TECHNICAL_TERMS = [
  'ai',
  'agent',
  'agents',
  'machine learning',
  'ml',
  'llm',
  'model',
  'models',
  'infrastructure',
  'security',
  'systems',
  'data',
  'api',
  'cloud',
  'distributed',
  'privacy',
  'startup',
  'founder',
];

const MARKETING_TERMS = [
  'promoted',
  'certification',
  'webinar',
  'register',
  'limited time',
  'game changer',
  'transformative',
  'best-in-class',
];

function sentence(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function containsAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function profileSignals(profile: ProfileContext, postText: string): string[] {
  const lower = postText.toLowerCase();
  const matches = [...profile.topSkills, ...profile.recentPostThemes]
    .filter((signal) => signal && lower.includes(signal.toLowerCase()))
    .slice(0, 5);

  return matches.length > 0
    ? matches
    : [...profile.topSkills, ...profile.recentPostThemes].filter(Boolean).slice(0, 5);
}

function recommendationFor(relevance: RelevanceScore): string {
  if (relevance.category === 'engage_now') {
    return 'Definitely highlight. This is a high-signal post for the current profile.';
  }
  if (relevance.category === 'consider') {
    return 'Worth skimming. It has some useful signal, but it is not a top-priority post.';
  }
  return 'Deprioritize. It is unlikely to be worth attention for this profile.';
}

export function buildFeedPostAnalysis(input: {
  post: ParsedPost;
  profile: ProfileContext;
  relevance: RelevanceScore;
  generatedAt?: number;
}): FeedPostAnalysis {
  const { post, profile, relevance } = input;
  const generatedAt = input.generatedAt ?? Date.now();
  const score = Math.round(relevance.score) / 10;
  const tags = unique([...tagText(post.text, 5), ...profileSignals(profile, post.text).slice(0, 2)]).slice(
    0,
    6
  );
  const highlight = relevance.category === 'engage_now';
  const hasTechnicalSignal = containsAny(post.text, TECHNICAL_TERMS);
  const hasMarketingSignal = containsAny(post.text, MARKETING_TERMS);

  const strongPoints = unique([
    ...relevance.reasons.map(sentence),
    hasTechnicalSignal ? 'Contains technical or industry-specific signal.' : '',
    post.likeCount + post.commentCount > 0 ? 'Has visible engagement from the network.' : '',
    post.followerTier === '10k_100k' || post.followerTier === 'gt_100k'
      ? 'Comes from a high-reach author or organization.'
      : '',
  ]);

  const weaknesses = unique([
    relevance.reasons.length === 0 ? 'Few strong ranking signals were detected.' : '',
    hasMarketingSignal ? 'Some language looks promotional or broad-market.' : '',
    !hasTechnicalSignal ? 'Limited technical depth detected from the extracted text.' : '',
    post.text.length < 240 ? 'Short post body limits confidence in the analysis.' : '',
  ]);

  return {
    apiVersion: 'linkmate.feed.analysis.v1',
    generatedAt,
    post: {
      id: post.id,
      authorName: post.authorName,
      authorTitle: post.authorTitle,
      authorUrn: post.authorUrn,
      text: post.text,
      postedAt: post.postedAt,
      engagement: {
        likes: post.likeCount,
        comments: post.commentCount,
      },
      relationship: post.degree,
      followerTier: post.followerTier,
      isOwn: post.isOwn,
    },
    score: {
      value: Math.round(score * 10) / 10,
      raw: relevance.score,
      scale: '0-10',
      category: relevance.category,
    },
    highlight,
    sections: {
      whyItRanks: sentence(
        highlight
          ? 'It ranks high because it matches the profile and has enough supporting quality signals'
          : relevance.category === 'consider'
            ? 'It ranks moderately because it has partial relevance but lacks enough signal to be a top highlight'
            : 'It ranks low because the current signals suggest limited relevance or prior suppression'
      ),
      strongPoints,
      especiallyRelevantBecause: profileSignals(profile, post.text).map((signal) =>
        sentence(`Relevant to ${signal}`)
      ),
      whatThisProvides: unique([
        hasTechnicalSignal ? 'Technical or industry context.' : '',
        tags.length > 0 ? `Signals around ${tags.slice(0, 3).join(', ')}.` : '',
        post.commentCount > 0 ? 'A conversation already forming in the comments.' : '',
      ]),
      weaknesses,
      tags,
      recommendation: recommendationFor(relevance),
    },
  };
}

interface AiRankedItem {
  id?: unknown;
  score?: unknown;
  highlight?: unknown;
  whyItRanks?: unknown;
  strongPoints?: unknown;
  especiallyRelevantBecause?: unknown;
  whatThisProvides?: unknown;
  weaknesses?: unknown;
  tags?: unknown;
  recommendation?: unknown;
}

interface AiRankedResponse {
  items?: unknown;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, 500) : fallback;
}

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.slice(0, 240))
    .slice(0, max);
}

function categoryFromScore(score: number): RelevanceScore['category'] {
  if (score >= 7) return 'engage_now';
  if (score >= 4) return 'consider';
  return 'skip';
}

function parseJsonObject(raw: string): AiRankedResponse | null {
  try {
    return JSON.parse(raw) as AiRankedResponse;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as AiRankedResponse;
    } catch {
      return null;
    }
  }
}

export function parseAiFeedAnalysis(input: {
  raw: string;
  posts: ParsedPost[];
  generatedAt?: number;
}): FeedPostAnalysis[] | null {
  const parsed = parseJsonObject(input.raw);
  if (!parsed || !Array.isArray(parsed.items)) return null;

  const byPostId = new Map(input.posts.map((post) => [post.id, post]));
  const generatedAt = input.generatedAt ?? Date.now();
  const out: FeedPostAnalysis[] = [];

  for (const rawItem of parsed.items as AiRankedItem[]) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const id = asString(rawItem.id);
    const post = byPostId.get(id);
    if (!post) continue;

    const numericScore = typeof rawItem.score === 'number' ? rawItem.score : Number(rawItem.score);
    const score = Number.isFinite(numericScore) ? Math.max(0, Math.min(10, numericScore)) : 0;
    const category = categoryFromScore(score);

    out.push({
      apiVersion: 'linkmate.feed.analysis.v1',
      generatedAt,
      post: {
        id: post.id,
        authorName: post.authorName,
        authorTitle: post.authorTitle,
        authorUrn: post.authorUrn,
        text: post.text,
        postedAt: post.postedAt,
        engagement: {
          likes: post.likeCount,
          comments: post.commentCount,
        },
        relationship: post.degree,
        followerTier: post.followerTier,
        isOwn: post.isOwn,
      },
      score: {
        value: Math.round(score * 10) / 10,
        raw: Math.round(score * 100) / 10,
        scale: '0-10',
        category,
      },
      highlight: typeof rawItem.highlight === 'boolean' ? rawItem.highlight : category === 'engage_now',
      sections: {
        whyItRanks: asString(rawItem.whyItRanks, 'The model did not provide a ranking reason.'),
        strongPoints: asStringArray(rawItem.strongPoints, 5),
        especiallyRelevantBecause: asStringArray(rawItem.especiallyRelevantBecause, 4),
        whatThisProvides: asStringArray(rawItem.whatThisProvides, 4),
        weaknesses: asStringArray(rawItem.weaknesses, 3),
        tags: asStringArray(rawItem.tags, 6),
        recommendation: asString(rawItem.recommendation, 'No recommendation returned.'),
      },
    });
  }

  return out.length === input.posts.length ? out : null;
}
