import OpenAI from 'openai';
import { getSettings } from './storage';

const SYSTEM_PROMPT = `You write short, natural LinkedIn comments that add value.
Rules:
- Each draft is one or two sentences, max ~240 chars.
- Vary tone across drafts: one supportive, one question, one contrarian-but-respectful.
- No hashtags, no emojis, no "Great post!" filler, no self-promotion.
- Refer concretely to the post's idea; do not invent facts about the author.
Return JSON only: { "drafts": ["...", "...", "..."] }.`;

export type DraftResult = { drafts: string[]; error?: string };

export async function draftComments(postAuthor: string, postBody: string): Promise<DraftResult> {
  const settings = await getSettings();
  if (!settings.openaiApiKey) {
    return { drafts: [], error: 'OpenAI API key not set. Add it in LinkMate → Settings.' };
  }
  const client = new OpenAI({
    apiKey: settings.openaiApiKey,
    dangerouslyAllowBrowser: true,
  });
  const user = `Post author: ${postAuthor || '(unknown)'}\nPost:\n${postBody.slice(0, 2000)}`;
  try {
    const resp = await client.chat.completions.create({
      model: settings.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.8,
      max_tokens: 400,
    });
    const txt = resp.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(txt) as { drafts?: unknown };
    const drafts = Array.isArray(parsed.drafts)
      ? parsed.drafts.filter((d): d is string => typeof d === 'string').slice(0, 3)
      : [];
    if (drafts.length === 0) return { drafts: [], error: 'No drafts returned.' };
    return { drafts };
  } catch (err) {
    return { drafts: [], error: err instanceof Error ? err.message : String(err) };
  }
}
