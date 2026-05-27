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
