// [TrendRadar] Taddy GraphQL API 서비스

import Anthropic from '@anthropic-ai/sdk';
import type { TaddyEpisode, TaddyTranscriptItem } from '../types/trendradar.js';

const TADDY_GRAPHQL_URL = 'https://api.taddy.org';
const REQUEST_DELAY_MS = 500; // rate limit: 100 req/hour

let lastRequestTime = 0;

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function taddyQuery(query: string, variables?: object): Promise<any> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < REQUEST_DELAY_MS) {
    await delay(REQUEST_DELAY_MS - timeSinceLastRequest);
  }
  lastRequestTime = Date.now();

  const response = await fetch(TADDY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': process.env.TADDY_API_KEY!,
      'X-USER-ID': process.env.TADDY_USER_ID!,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Taddy API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export async function getEpisodesWithTranscripts(
  podcastUuid: string,
  limit: number = 10,
): Promise<TaddyEpisode[]> {
  const query = `
    {
      getPodcastSeries(uuid: "${podcastUuid}") {
        episodes(limitPerPage: ${limit}) {
          uuid
          name
          datePublished
          audioUrl
          description
          taddyTranscribeStatus
          transcript
          transcriptWithSpeakersAndTimecodes {
            text
            startTime
          }
          podcastSeries {
            uuid
            name
          }
        }
      }
    }
  `;

  try {
    const result = await taddyQuery(query);
    return result?.data?.getPodcastSeries?.episodes ?? [];
  } catch (err) {
    console.error(`[TrendRadar] Taddy getEpisodes 실패 (${podcastUuid}):`, (err as Error).message);
    return [];
  }
}

export async function searchEpisodesByKeyword(
  keyword: string,
  options?: {
    sortBy?: 'DATE' | 'POPULARITY';
    filterForHasTranscript?: boolean;
    filterForPublishedAfter?: number;
    limit?: number;
  },
): Promise<TaddyEpisode[]> {
  const sortBy = options?.sortBy ?? 'DATE';
  const hasTranscript = options?.filterForHasTranscript ?? false;
  const limit = options?.limit ?? 50;

  let filterArgs = '';
  if (hasTranscript) {
    filterArgs += ', filterForHasTranscript: true';
  }
  if (options?.filterForPublishedAfter) {
    filterArgs += `, filterForPublishedAfter: ${options.filterForPublishedAfter}`;
  }

  const query = `
    {
      search(
        term: "${keyword}"
        filterForTypes: PODCASTEPISODE
        sortBy: ${sortBy}
        limitPerPage: ${limit}
        ${filterArgs ? filterArgs : ''}
      ) {
        podcastEpisodes {
          uuid
          name
          datePublished
          audioUrl
          description
          taddyTranscribeStatus
          transcript
          transcriptWithSpeakersAndTimecodes {
            text
            startTime
          }
          podcastSeries {
            uuid
            name
          }
        }
      }
    }
  `;

  try {
    const result = await taddyQuery(query);
    return result?.data?.search?.podcastEpisodes ?? [];
  } catch (err) {
    console.error(`[TrendRadar] Taddy search 실패 (${keyword}):`, (err as Error).message);
    return [];
  }
}

export function extractKeywordContext(
  transcript: TaddyTranscriptItem[],
  keyword: string,
  contextWords: number = 30,
): Array<{ quote: string; timestamp_seconds: number; speaker?: string }> {
  const results: Array<{ quote: string; timestamp_seconds: number; speaker?: string }> = [];
  const lowerKeyword = keyword.toLowerCase();

  for (const item of transcript) {
    if (item.text.toLowerCase().includes(lowerKeyword)) {
      const words = item.text.split(/\s+/);
      const keywordIndex = words.findIndex(w => w.toLowerCase().includes(lowerKeyword));

      if (keywordIndex >= 0) {
        const start = Math.max(0, keywordIndex - contextWords);
        const end = Math.min(words.length, keywordIndex + contextWords + 1);
        const quote = words.slice(start, end).join(' ');

        results.push({
          quote,
          timestamp_seconds: item.startTime,
          speaker: item.speaker,
        });
      }
    }
  }

  return results;
}

export async function extractSupplementKeywords(
  episodeTitle: string,
  transcript: string | null,
  description: string | null,
): Promise<Array<{ keyword: string; context: '개인 복용' | '효능 설명' | '브랜드 추천' | '기타'; quote: string | null }>> {
  const anthropic = new Anthropic();

  const content = transcript
    ? `에피소드 제목: ${episodeTitle}\n\n트랜스크립트:\n${transcript.slice(0, 8000)}`
    : `에피소드 제목: ${episodeTitle}\n\n설명:\n${description ?? '없음'}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `다음 팟캐스트 내용에서 건강 서플리먼트, 영양성분, 화합물, 허브 키워드만 추출해줘.
언급된 맥락(효능 설명/개인 복용/브랜드 추천/기타 중 무엇인지)도 함께 JSON 배열로 반환해줘.
가능하면 실제 발언도 quote로 포함해줘.

형식: [{"keyword": "...", "context": "효능 설명", "quote": "..."}]

${content}`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return [];
  } catch (err) {
    console.error('[TrendRadar] Claude 키워드 추출 실패:', (err as Error).message);
    return [];
  }
}
