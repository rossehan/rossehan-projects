// [TrendRadar] Instagram Graph API 서비스

const GRAPH_API_BASE = 'https://graph.facebook.com/v22.0';
const WEEKLY_HASHTAG_LIMIT = 30;
const REQUEST_DELAY_MS = 500;

const hashtagIdCache = new Map<string, string>();
let weeklyHashtagCount = 0;
let weeklyResetTime = Date.now() + 7 * 24 * 60 * 60 * 1000;

function resetWeeklyCountIfNeeded(): void {
  if (Date.now() > weeklyResetTime) {
    weeklyHashtagCount = 0;
    weeklyResetTime = Date.now() + 7 * 24 * 60 * 60 * 1000;
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeHashtag(keyword: string): string {
  return keyword.toLowerCase().replace(/[\s'-]/g, '');
}

async function getHashtagId(keyword: string): Promise<string | null> {
  const hashtag = sanitizeHashtag(keyword);

  if (hashtagIdCache.has(hashtag)) {
    return hashtagIdCache.get(hashtag)!;
  }

  resetWeeklyCountIfNeeded();
  if (weeklyHashtagCount >= WEEKLY_HASHTAG_LIMIT) {
    console.warn(`[TrendRadar] Instagram 주간 해시태그 한도 도달 (${WEEKLY_HASHTAG_LIMIT}개)`);
    return null;
  }

  try {
    const url = `${GRAPH_API_BASE}/ig_hashtag_search?q=${encodeURIComponent(hashtag)}&user_id=${process.env.INSTAGRAM_USER_ID}&access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`[TrendRadar] Instagram 해시태그 검색 실패: ${response.status}`);
      return null;
    }

    const data = await response.json() as { data?: Array<{ id: string }> };
    const id = data?.data?.[0]?.id ?? null;

    if (id) {
      hashtagIdCache.set(hashtag, id);
      weeklyHashtagCount++;
    }

    return id;
  } catch (err) {
    console.error(`[TrendRadar] Instagram 해시태그 ID 조회 실패 (${keyword}):`, (err as Error).message);
    return null;
  }
}

export interface InstagramMediaCount {
  keyword: string;
  hashtag: string;
  post_count: number;
  recent_post_count: number;
}

export async function getHashtagMediaCount(keyword: string): Promise<InstagramMediaCount | null> {
  const hashtagId = await getHashtagId(keyword);
  if (!hashtagId) return null;

  const hashtag = `#${sanitizeHashtag(keyword)}`;

  try {
    const [topResponse, recentResponse] = await Promise.all([
      fetch(`${GRAPH_API_BASE}/${hashtagId}/top_media?user_id=${process.env.INSTAGRAM_USER_ID}&fields=id&access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`),
      fetch(`${GRAPH_API_BASE}/${hashtagId}/recent_media?user_id=${process.env.INSTAGRAM_USER_ID}&fields=id&access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`),
    ]);

    let topCount = 0;
    let recentCount = 0;

    if (topResponse.ok) {
      const topData = await topResponse.json() as { data?: Array<unknown> };
      topCount = topData?.data?.length ?? 0;
    }

    if (recentResponse.ok) {
      const recentData = await recentResponse.json() as { data?: Array<unknown> };
      recentCount = recentData?.data?.length ?? 0;
    }

    return {
      keyword,
      hashtag,
      post_count: topCount + recentCount,
      recent_post_count: recentCount,
    };
  } catch (err) {
    console.error(`[TrendRadar] Instagram 미디어 수 조회 실패 (${keyword}):`, (err as Error).message);
    return null;
  }
}

export async function batchGetHashtagMediaCounts(
  keywords: string[],
): Promise<InstagramMediaCount[]> {
  const results: InstagramMediaCount[] = [];
  const maxBatch = Math.min(keywords.length, 25); // 배치당 최대 25개

  for (let i = 0; i < maxBatch; i++) {
    const result = await getHashtagMediaCount(keywords[i]);
    if (result) {
      results.push(result);
    }
    if (i < maxBatch - 1) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  return results;
}
