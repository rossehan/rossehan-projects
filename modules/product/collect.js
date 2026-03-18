// [TrendRadar] 데이터 수집기 — 팟캐스트 + 소셜미디어 전체 히스토리 수집
// 실행: node collect.js [command]
// 명령어: all | podcasts | instagram | facebook | google | threads | seed | analyze

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

// ── 설정 ──
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const anthropic = new Anthropic();

const TADDY_GRAPHQL_URL = 'https://api.taddy.org';
const GRAPH_API_BASE = 'https://graph.facebook.com/v22.0';
const THREADS_API_BASE = 'https://graph.threads.net/v1.0';

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const toDateStr = (d) => {
  if (!d) return new Date().toISOString().split('T')[0];
  if (typeof d === 'string') return d.split('T')[0];
  if (typeof d === 'number') return new Date(d < 1e12 ? d * 1000 : d).toISOString().split('T')[0];
  return d.toISOString().split('T')[0];
};
const log = (tag, msg) => console.log(`[${new Date().toLocaleTimeString('ko-KR')}] [${tag}] ${msg}`);

// ── 인플루언서 목록 ──
const INFLUENCERS = {
  huberman:  { name: 'Andrew Huberman', searchName: 'Huberman Lab', uuid: null, igHandle: 'hubermanlab', threadsHandle: 'hubermanlab' },
  sinclair:  { name: 'David Sinclair', searchName: 'Lifespan David Sinclair', uuid: null, igHandle: 'davidsinclairphd', threadsHandle: 'davidsinclairphd' },
  attia:     { name: 'Peter Attia', searchName: 'The Drive Peter Attia', uuid: null, igHandle: 'peterattiamd', threadsHandle: 'peterattiamd' },
  brecka:    { name: 'Gary Brecka', searchName: 'Ultimate Human Gary Brecka', uuid: null, igHandle: 'garybrecka', threadsHandle: 'garybrecka' },
  hyman:     { name: 'Mark Hyman', searchName: 'Doctors Farmacy Mark Hyman', uuid: null, igHandle: 'drmarkhyman', threadsHandle: 'drmarkhyman' },
  patrick:   { name: 'Rhonda Patrick', searchName: 'FoundMyFitness Rhonda Patrick', uuid: null, igHandle: 'foundmyfitness', threadsHandle: 'foundmyfitness' },
};

// 알려진 서플리먼트 키워드 시드 목록
const SEED_KEYWORDS = [
  'shilajit', 'tongkat ali', 'nmn', 'urolithin a', 'spermidine', 'apigenin',
  'berberine', 'turkesterone', 'sea moss', 'fadogia agrestis', 'taurine',
  'creatine', 'glutathione', 'sulforaphane', 'nac', 'magnesium threonate',
  'ashwagandha', 'lion\'s mane', 'omega 3', 'vitamin d3', 'resveratrol',
  'fisetin', 'quercetin', 'coq10', 'curcumin', 'zinc', 'probiotics',
  'collagen', 'melatonin', 'alpha gpc', 'l-theanine', 'rhodiola',
  'maca', 'saw palmetto', 'boron', 'dhea', 'pregnenolone',
  'glycine', 'tryptophan', 'inositol', 'methyl folate', 'rapamycin',
];

// ═════════════════════════════════════════════════════════
// 1. PODCAST COLLECTOR (Taddy API)
// ═════════════════════════════════════════════════════════

async function taddyQuery(query) {
  const response = await fetch(TADDY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': process.env.TADDY_API_KEY,
      'X-USER-ID': String(process.env.TADDY_USER_ID || ''),
    },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Taddy ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json();
}

async function resolveAllUUIDs() {
  log('PODCAST', '인플루언서 팟캐스트 UUID 검색 시작...');
  for (const [key, inf] of Object.entries(INFLUENCERS)) {
    try {
      const safeName = inf.searchName.replace(/"/g, '\\"');
      const result = await taddyQuery(`{ search(term: "${safeName}", filterForTypes: PODCASTSERIES, limitPerPage: 3) { searchId podcastSeries { uuid name } } }`);
      const podcasts = result?.data?.search?.podcastSeries ?? [];
      if (podcasts.length > 0) {
        inf.uuid = podcasts[0].uuid;
        log('PODCAST', `✅ ${key}: ${podcasts[0].name} → ${podcasts[0].uuid}`);
      } else {
        log('PODCAST', `❌ ${key}: 검색 결과 없음`);
      }
      await delay(600);
    } catch (err) {
      log('PODCAST', `❌ ${key} UUID 검색 실패: ${err.message}`);
    }
  }
}

async function collectAllPodcastEpisodes() {
  log('PODCAST', '=== 팟캐스트 전체 히스토리 수집 시작 ===');
  await resolveAllUUIDs();

  let totalEpisodes = 0;
  let totalKeywords = 0;

  for (const [key, inf] of Object.entries(INFLUENCERS)) {
    if (!inf.uuid) continue;

    log('PODCAST', `${inf.name} 에피소드 수집 중...`);

    // 최대 100개 에피소드 수집 (Taddy 페이지네이션)
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 5) {
      try {
        const result = await taddyQuery(`{
          getPodcastSeries(uuid: "${inf.uuid}") {
            uuid
            episodes(limitPerPage: 25, page: ${page}) {
              uuid name datePublished audioUrl description
            }
          }
        }`);

        const episodes = result?.data?.getPodcastSeries?.episodes ?? [];
        if (episodes.length === 0) { hasMore = false; break; }

        for (const ep of episodes) {
          totalEpisodes++;

          // Claude로 서플리먼트 키워드 추출
          const keywords = await extractKeywordsFromEpisode(ep, key);
          totalKeywords += keywords.length;

          // DB 저장
          for (const kw of keywords) {
            await supabase.from('podcast_keywords').upsert(
              {
                influencer: key,
                keyword: kw.keyword.toLowerCase(),
                mentioned_date: toDateStr(ep.datePublished),
                episode_title: ep.name,
                episode_url: ep.audioUrl || '',
                episode_id: ep.uuid,
                mention_timestamp_seconds: kw.timestamp_seconds || null,
                mention_context: kw.context,
                mention_quote: kw.quote,
              },
              { onConflict: 'influencer,keyword,mentioned_date' }
            );
          }

          log('PODCAST', `  ${ep.name.slice(0, 50)}... → ${keywords.length}개 키워드`);
          await delay(500);
        }

        page++;
        await delay(1000);
      } catch (err) {
        log('PODCAST', `  페이지 ${page} 에러: ${err.message}`);
        hasMore = false;
      }
    }

    log('PODCAST', `${inf.name} 완료`);
  }

  log('PODCAST', `=== 팟캐스트 수집 완료: ${totalEpisodes}개 에피소드, ${totalKeywords}개 키워드 ===`);
  return { totalEpisodes, totalKeywords };
}

async function extractKeywordsFromEpisode(episode, influencerKey) {
  const content = episode.transcript
    ? `에피소드: ${episode.name}\n\n트랜스크립트:\n${episode.transcript.slice(0, 12000)}`
    : `에피소드: ${episode.name}\n\n설명:\n${episode.description || '없음'}`;

  if (!content || content.length < 50) return [];

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `다음 건강/웰니스 팟캐스트에서 서플리먼트, 영양소, 화합물, 허브 키워드를 모두 추출해줘.
각 키워드의 맥락(효능 설명/개인 복용/브랜드 추천/부작용 경고/기타)과 실제 발언(quote)을 포함해줘.

형식: [{"keyword": "...", "context": "효능 설명", "quote": "...", "timestamp_seconds": null}]

주의: 일반적인 단어(water, food, exercise 등)는 제외. 서플리먼트/성분명만 포함.

${content}`
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      // 트랜스크립트에서 타임스탬프 찾기
      if (episode.transcriptWithSpeakersAndTimecodes) {
        for (const kw of parsed) {
          const found = episode.transcriptWithSpeakersAndTimecodes.find(
            t => t.text.toLowerCase().includes(kw.keyword.toLowerCase())
          );
          if (found) kw.timestamp_seconds = found.startTime;
        }
      }
      return parsed;
    }
    return [];
  } catch (err) {
    log('PODCAST', `  키워드 추출 실패: ${err.message}`);
    return [];
  }
}

// ═════════════════════════════════════════════════════════
// 2. INSTAGRAM COLLECTOR (Graph API)
// ═════════════════════════════════════════════════════════

async function collectInstagramData() {
  log('INSTAGRAM', '=== Instagram 해시태그 스냅샷 수집 시작 ===');
  const today = toDateStr(new Date());
  let collected = 0;

  // DB에서 수집된 모든 키워드 가져오기
  const { data: keywords } = await supabase
    .from('podcast_keywords')
    .select('keyword')
    .order('mentioned_date', { ascending: false });

  const uniqueKeywords = [...new Set((keywords || []).map(k => k.keyword))];
  // 시드 키워드도 추가
  const allKeywords = [...new Set([...uniqueKeywords, ...SEED_KEYWORDS])];

  log('INSTAGRAM', `${allKeywords.length}개 키워드 해시태그 조회 (주간 30개 제한 주의)`);

  if (!process.env.INSTAGRAM_USER_ID) {
    log('INSTAGRAM', '⚠️ INSTAGRAM_USER_ID가 설정되지 않았습니다. Instagram Business 계정 ID가 필요합니다.');
    log('INSTAGRAM', '  설정 방법: Graph API Explorer에서 me/accounts?fields=instagram_business_account 조회');
    log('INSTAGRAM', '=== Instagram 수집 완료: 0개 키워드 ===');
    return { collected: 0 };
  }

  const maxPerRun = 25; // 주간 한도 고려
  const batch = allKeywords.slice(0, maxPerRun);

  for (const keyword of batch) {
    try {
      const hashtag = keyword.toLowerCase().replace(/[\s'-]/g, '');

      // 해시태그 ID 검색
      const searchUrl = `${GRAPH_API_BASE}/ig_hashtag_search?q=${encodeURIComponent(hashtag)}&user_id=${process.env.INSTAGRAM_USER_ID}&access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`;
      const searchRes = await fetch(searchUrl);
      if (!searchRes.ok) {
        log('INSTAGRAM', `  ${keyword}: 해시태그 검색 실패 (${searchRes.status})`);
        continue;
      }
      const searchData = await searchRes.json();
      const hashtagId = searchData?.data?.[0]?.id;
      if (!hashtagId) continue;

      // top_media + recent_media 카운트
      const [topRes, recentRes] = await Promise.all([
        fetch(`${GRAPH_API_BASE}/${hashtagId}/top_media?user_id=${process.env.INSTAGRAM_USER_ID}&fields=id&access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`),
        fetch(`${GRAPH_API_BASE}/${hashtagId}/recent_media?user_id=${process.env.INSTAGRAM_USER_ID}&fields=id&access_token=${process.env.INSTAGRAM_ACCESS_TOKEN}`),
      ]);

      const topData = topRes.ok ? await topRes.json() : { data: [] };
      const recentData = recentRes.ok ? await recentRes.json() : { data: [] };
      const postCount = (topData?.data?.length || 0) + (recentData?.data?.length || 0);
      const recentCount = recentData?.data?.length || 0;

      await supabase.from('instagram_snapshots').upsert(
        { keyword, hashtag: `#${hashtag}`, post_count: postCount, recent_post_count: recentCount, snapshot_date: today },
        { onConflict: 'keyword,snapshot_date' }
      );
      collected++;
      log('INSTAGRAM', `  ✅ #${hashtag}: ${postCount} posts (recent: ${recentCount})`);
      await delay(500);
    } catch (err) {
      log('INSTAGRAM', `  ❌ ${keyword}: ${err.message}`);
    }
  }

  log('INSTAGRAM', `=== Instagram 수집 완료: ${collected}개 키워드 ===`);
  return { collected };
}

// ═════════════════════════════════════════════════════════
// 3. THREADS COLLECTOR (Threads API)
// ═════════════════════════════════════════════════════════

async function collectThreadsData() {
  log('THREADS', '=== Threads 데이터 수집 시작 ===');
  const today = toDateStr(new Date());
  let collected = 0;

  const threadsToken = process.env.THREADS_ACCESS_TOKEN;
  if (!threadsToken) {
    log('THREADS', '⚠️ THREADS_ACCESS_TOKEN 미설정. Threads 키워드 검색으로 대체합니다.');
    // Threads 검색 API 사용 (키워드별)
    return await collectThreadsByKeywordSearch();
  }

  // 방법 1: 자체 계정의 Threads 미디어 + 언급 수집
  try {
    const mediaUrl = `${THREADS_API_BASE}/me/threads?fields=id,text,timestamp,media_type,permalink&limit=100&access_token=${threadsToken}`;
    const mediaRes = await fetch(mediaUrl);

    if (!mediaRes.ok) {
      const errorText = await mediaRes.text();
      log('THREADS', `자체 계정 API 실패 (${mediaRes.status}): ${errorText}`);
      return await collectThreadsByKeywordSearch();
    }

    const mediaData = await mediaRes.json();
    let posts = mediaData?.data ?? [];
    log('THREADS', `자체 계정 ${posts.length}개 포스트 조회`);

    // 페이지네이션 — 더 많은 포스트 가져오기
    let nextUrl = mediaData?.paging?.next;
    while (nextUrl && posts.length < 500) {
      try {
        const nextRes = await fetch(nextUrl);
        if (!nextRes.ok) break;
        const nextData = await nextRes.json();
        posts = posts.concat(nextData?.data ?? []);
        nextUrl = nextData?.paging?.next;
        await delay(300);
      } catch { break; }
    }

    for (const post of posts) {
      if (!post.text) continue;
      const foundKeywords = SEED_KEYWORDS.filter(kw =>
        post.text.toLowerCase().includes(kw.toLowerCase())
      );
      for (const kw of foundKeywords) {
        await supabase.from('social_mentions').upsert(
          { platform: 'threads', influencer: 'self', keyword: kw.toLowerCase(), post_date: toDateStr(post.timestamp), post_text: post.text.slice(0, 500), post_url: post.permalink || '', post_id: post.id },
          { onConflict: 'platform,keyword,post_id' }
        ).catch(() => {});
        collected++;
      }
    }
  } catch (err) {
    log('THREADS', `자체 계정 수집 실패: ${err.message}`);
  }

  log('THREADS', `=== Threads 수집 완료: ${collected}개 언급 ===`);
  return { collected };
}

// Threads 키워드 검색 (토큰 없을 때 대체)
async function collectThreadsByKeywordSearch() {
  log('THREADS', 'Threads 키워드 검색 모드 (제한적)');
  let collected = 0;

  // Threads 공개 API는 검색 기능이 제한적이므로
  // Instagram Graph API의 hashtag search를 Threads 대리 지표로 활용
  const { data: keywords } = await supabase
    .from('podcast_keywords')
    .select('keyword')
    .order('mentioned_date', { ascending: false });

  const uniqueKeywords = [...new Set((keywords || []).map(k => k.keyword))].slice(0, 20);

  for (const keyword of uniqueKeywords) {
    // Threads에서 해당 키워드가 언급된 포스트 수를 추정
    // (Threads API v1에서는 직접 검색이 제한적이므로 로그만 남김)
    log('THREADS', `  ${keyword}: Threads 검색 API 미지원 — 향후 업데이트 필요`);
  }

  log('THREADS', `Threads 키워드 검색 완료: ${collected}개`);
  return { collected };
}

// ═════════════════════════════════════════════════════════
// 4. FACEBOOK AD LIBRARY COLLECTOR
// ═════════════════════════════════════════════════════════

async function collectFacebookAdsData() {
  log('FACEBOOK', '=== Facebook Ad Library 수집 시작 ===');
  const today = toDateStr(new Date());
  let collected = 0;

  const { data: keywords } = await supabase
    .from('podcast_keywords')
    .select('keyword')
    .order('mentioned_date', { ascending: false });

  const uniqueKeywords = [...new Set((keywords || []).map(k => k.keyword))];
  const allKeywords = [...new Set([...uniqueKeywords, ...SEED_KEYWORDS])];

  for (const keyword of allKeywords) {
    try {
      const params = new URLSearchParams({
        search_terms: keyword,
        ad_reached_countries: JSON.stringify(['US']),
        ad_delivery_date_min: daysAgoStr(365),
        fields: 'id,ad_creation_time,page_name,page_id',
        limit: '500',
        access_token: process.env.META_ACCESS_TOKEN,
      });

      const response = await fetch(`${GRAPH_API_BASE}/ads_archive?${params}`);
      if (!response.ok) {
        if (response.status === 400 || response.status === 403) {
          log('FACEBOOK', `  ${keyword}: 접근 제한 (헬스 카테고리)`);
          await supabase.from('facebook_ads_snapshots').upsert(
            { keyword, total_ads: 0, unique_advertisers: 0, new_advertisers_this_week: 0, oldest_ad_date: null, newest_ad_date: null, competition_level: 'unknown', snapshot_date: today },
            { onConflict: 'keyword,snapshot_date' }
          );
          continue;
        }
        throw new Error(`Status ${response.status}`);
      }

      const data = await response.json();
      const ads = data?.data ?? [];

      const pageIds = new Set();
      const newPageIds = new Set();
      let oldestDate = null, newestDate = null;
      const oneWeekAgo = daysAgoStr(7);

      for (const ad of ads) {
        pageIds.add(ad.page_id);
        const adDate = ad.ad_creation_time?.split('T')[0];
        if (adDate) {
          if (!oldestDate || adDate < oldestDate) oldestDate = adDate;
          if (!newestDate || adDate > newestDate) newestDate = adDate;
          if (adDate >= oneWeekAgo) newPageIds.add(ad.page_id);
        }
      }

      const level = ads.length < 5 ? 'low' : ads.length <= 20 ? 'medium' : 'high';
      await supabase.from('facebook_ads_snapshots').upsert(
        { keyword, total_ads: ads.length, unique_advertisers: pageIds.size, new_advertisers_this_week: newPageIds.size, oldest_ad_date: oldestDate, newest_ad_date: newestDate, competition_level: level, snapshot_date: today },
        { onConflict: 'keyword,snapshot_date' }
      );
      collected++;
      log('FACEBOOK', `  ✅ ${keyword}: ${ads.length} ads, ${pageIds.size} advertisers, level=${level}`);
      await delay(300);
    } catch (err) {
      log('FACEBOOK', `  ❌ ${keyword}: ${err.message}`);
    }
  }

  log('FACEBOOK', `=== Facebook Ads 수집 완료: ${collected}개 키워드 ===`);
  return { collected };
}

// ═════════════════════════════════════════════════════════
// 5. GOOGLE TRENDS COLLECTOR
// ═════════════════════════════════════════════════════════

async function collectGoogleTrendsData() {
  log('GOOGLE', '=== Google Trends 수집 시작 ===');
  const today = toDateStr(new Date());
  let collected = 0;

  let googleTrends;
  try {
    googleTrends = (await import('google-trends-api')).default;
  } catch {
    log('GOOGLE', '❌ google-trends-api 패키지 없음. npm install google-trends-api 필요');
    return { collected: 0 };
  }

  const { data: keywords } = await supabase
    .from('podcast_keywords')
    .select('keyword')
    .order('mentioned_date', { ascending: false });

  const uniqueKeywords = [...new Set((keywords || []).map(k => k.keyword))];
  const allKeywords = [...new Set([...uniqueKeywords, ...SEED_KEYWORDS])];

  for (const keyword of allKeywords) {
    try {
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

      const result = await googleTrends.interestOverTime({
        keyword,
        startTime: sixMonthsAgo,
        geo: 'US',
      });

      const data = JSON.parse(result);
      const timeline = data?.default?.timelineData ?? [];

      if (timeline.length === 0) continue;

      const midIdx = Math.floor(timeline.length / 2);
      const recent = timeline.slice(midIdx);
      const prev = timeline.slice(0, midIdx);
      const recentAvg = recent.reduce((s, d) => s + (d.value?.[0] ?? 0), 0) / recent.length;
      const prevAvg = prev.reduce((s, d) => s + (d.value?.[0] ?? 0), 0) / prev.length;
      const growthRate = prevAvg > 0 ? ((recentAvg - prevAvg) / prevAvg * 100) : 0;
      const direction = growthRate > 10 ? 'rising' : growthRate < -10 ? 'falling' : 'stable';

      await supabase.from('google_trends_snapshots').upsert(
        { keyword, current_3m_avg: Math.round(recentAvg * 100) / 100, prev_3m_avg: Math.round(prevAvg * 100) / 100, growth_rate: Math.round(growthRate * 100) / 100, trend_direction: direction, snapshot_date: today },
        { onConflict: 'keyword,snapshot_date' }
      );
      collected++;
      log('GOOGLE', `  ✅ ${keyword}: avg=${Math.round(recentAvg)}, growth=${Math.round(growthRate)}%, ${direction}`);
      await delay(2000); // Google rate limit
    } catch (err) {
      log('GOOGLE', `  ❌ ${keyword}: ${err.message}`);
      await delay(3000);
    }
  }

  log('GOOGLE', `=== Google Trends 수집 완료: ${collected}개 키워드 ===`);
  return { collected };
}

// ═════════════════════════════════════════════════════════
// 6. KEYWORD ORIGIN ANALYZER
// ═════════════════════════════════════════════════════════

async function analyzeKeywordOrigins() {
  log('ANALYZE', '=== 키워드 기원 분석 시작 ===');

  // DB에서 모든 유니크 키워드 가져오기
  const { data: allKeywords } = await supabase
    .from('podcast_keywords')
    .select('keyword')
    .order('mentioned_date', { ascending: true });

  const uniqueKeywords = [...new Set((allKeywords || []).map(k => k.keyword))];
  log('ANALYZE', `${uniqueKeywords.length}개 키워드 분석 중...`);

  for (const keyword of uniqueKeywords) {
    try {
      // 1. 최초 팟캐스트 언급
      const { data: firstMention } = await supabase
        .from('podcast_keywords')
        .select('*')
        .eq('keyword', keyword)
        .order('mentioned_date', { ascending: true })
        .limit(1)
        .single();

      // 2. 모든 팟캐스트 언급 타임라인
      const { data: allMentions } = await supabase
        .from('podcast_keywords')
        .select('influencer, mentioned_date, episode_title, mention_quote')
        .eq('keyword', keyword)
        .order('mentioned_date', { ascending: true });

      // 3. Facebook 첫 광고 날짜
      const { data: fbData } = await supabase
        .from('facebook_ads_snapshots')
        .select('oldest_ad_date, unique_advertisers')
        .eq('keyword', keyword)
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .single();

      // 4. Instagram 성장률
      const { data: igData } = await supabase
        .from('instagram_snapshots')
        .select('post_count, snapshot_date')
        .eq('keyword', keyword)
        .order('snapshot_date', { ascending: true });

      let igGrowth = 0;
      if (igData && igData.length >= 2) {
        const first = igData[0].post_count || 1;
        const last = igData[igData.length - 1].post_count || 1;
        igGrowth = Math.round(((last - first) / first * 100) * 10) / 10;
      }

      // 5. Google Trends spike
      const { data: trendData } = await supabase
        .from('google_trends_snapshots')
        .select('growth_rate')
        .eq('keyword', keyword)
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .single();

      // 6. 골든타임 계산
      const goldenStart = firstMention?.mentioned_date;
      const goldenEnd = fbData?.oldest_ad_date;

      const durationDays = goldenStart && goldenEnd
        ? Math.floor((new Date(goldenEnd) - new Date(goldenStart)) / 86400000)
        : null;

      const isActive = goldenStart && (!goldenEnd || new Date(goldenEnd) >= new Date());

      // 7. Claude 분석 리포트
      let analysisReport = '';
      try {
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `이 서플리먼트 키워드의 시장 기원을 분석해줘. 한국어 3-5줄.

키워드: ${keyword}
최초 팟캐스트 언급: ${firstMention?.influencer || '없음'} (${firstMention?.mentioned_date || '없음'})
발언: "${firstMention?.mention_quote || '없음'}"
총 팟캐스트 언급 횟수: ${allMentions?.length || 0}회
인스타그램 총 성장률: ${igGrowth}%
Facebook 광고주: ${fbData?.unique_advertisers || 0}개
Google Trends 성장률: ${trendData?.growth_rate || 0}%
골든타임: ${isActive ? '진행 중' : durationDays ? `종료 (${durationDays}일)` : '데이터 부족'}

분석 관점: 누가 이 키워드를 시장에 처음 소개했는지, 어떤 맥락(효능/개인사용)으로 퍼졌는지, 현재 시장 포화도는 어떤지`
          }],
        });
        analysisReport = response.content[0].type === 'text' ? response.content[0].text : '';
      } catch (err) {
        log('ANALYZE', `  ${keyword}: AI 분석 실패: ${err.message}`);
      }

      // 8. DB 저장
      await supabase.from('keyword_origins').upsert(
        {
          keyword,
          first_podcast_date: firstMention?.mentioned_date,
          first_podcast_influencer: firstMention?.influencer,
          first_podcast_name: '',
          first_podcast_episode_title: firstMention?.episode_title,
          first_podcast_quote: firstMention?.mention_quote,
          market_creator_influencer: firstMention?.influencer,
          market_creator_ig_growth: igGrowth,
          market_creator_google_growth: trendData?.growth_rate || 0,
          mention_timeline: allMentions,
          golden_time_start: goldenStart,
          golden_time_end: goldenEnd,
          golden_time_duration_days: durationDays,
          analysis_report: analysisReport,
          analyzed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'keyword' }
      );

      log('ANALYZE', `  ✅ ${keyword}: ${allMentions?.length || 0}회 언급, IG +${igGrowth}%, 골든타임: ${isActive ? '진행 중' : durationDays ? `${durationDays}일` : '-'}`);
    } catch (err) {
      log('ANALYZE', `  ❌ ${keyword}: ${err.message}`);
    }
  }

  log('ANALYZE', '=== 키워드 기원 분석 완료 ===');
}

// ═════════════════════════════════════════════════════════
// 7. OPPORTUNITY SCORER
// ═════════════════════════════════════════════════════════

async function scoreOpportunities() {
  log('SCORE', '=== 기회 점수 계산 시작 ===');
  const today = toDateStr(new Date());

  const { data: keywords } = await supabase
    .from('podcast_keywords')
    .select('keyword')
    .order('mentioned_date', { ascending: false });

  const uniqueKeywords = [...new Set((keywords || []).map(k => k.keyword))];

  for (const keyword of uniqueKeywords) {
    const { data: podcast } = await supabase.from('podcast_keywords').select('mentioned_date').eq('keyword', keyword).order('mentioned_date', { ascending: false }).limit(1).single();
    const { data: ig } = await supabase.from('instagram_snapshots').select('*').eq('keyword', keyword).order('snapshot_date', { ascending: false }).limit(2);
    const { data: google } = await supabase.from('google_trends_snapshots').select('growth_rate').eq('keyword', keyword).order('snapshot_date', { ascending: false }).limit(1).single();
    const { data: fb } = await supabase.from('facebook_ads_snapshots').select('competition_level, unique_advertisers').eq('keyword', keyword).order('snapshot_date', { ascending: false }).limit(1).single();

    const podcastDate = podcast?.mentioned_date;
    const daysSince = podcastDate ? Math.floor((Date.now() - new Date(podcastDate).getTime()) / 86400000) : 999;

    let igGrowth = null;
    if (ig && ig.length >= 2 && ig[1].post_count > 0) {
      igGrowth = Math.round(((ig[0].post_count - ig[1].post_count) / ig[1].post_count * 100) * 10) / 10;
    }

    const podcastScore = daysSince <= 30 ? 30 : daysSince <= 60 ? 20 : daysSince <= 90 ? 10 : 5;
    const igScore = igGrowth >= 50 ? 25 : igGrowth >= 20 ? 18 : igGrowth >= 10 ? 12 : igGrowth >= 0 ? 6 : 0;
    const googleScore = (google?.growth_rate || 0) >= 100 ? 25 : (google?.growth_rate || 0) >= 50 ? 20 : (google?.growth_rate || 0) >= 20 ? 14 : (google?.growth_rate || 0) >= 0 ? 7 : 0;
    const fbLevel = fb?.competition_level || 'unknown';
    const fbScore = fbLevel === 'low' ? 20 : fbLevel === 'medium' ? 10 : fbLevel === 'unknown' ? 10 : 0;

    const total = podcastScore + igScore + googleScore + fbScore;
    const verdict = total >= 80 ? '🟢 지금 바로 진입하세요' : total >= 60 ? '🟡 6개월 내 진입 고려' : '🔴 이미 포화 or 수요 미확인';

    await supabase.from('opportunity_scores').upsert(
      {
        keyword, opportunity_score: total, verdict,
        score_breakdown: { podcast_recency: podcastScore, instagram_growth: igScore, google_trends_growth: googleScore, facebook_competition_inverse: fbScore },
        strategy_comment: '',
        podcast_mention_date: podcastDate, instagram_weekly_growth: igGrowth,
        google_growth_rate: google?.growth_rate || null,
        facebook_advertiser_count: fb?.unique_advertisers || null,
        snapshot_date: today,
      },
      { onConflict: 'keyword,snapshot_date' }
    );
  }

  log('SCORE', `=== 기회 점수 계산 완료: ${uniqueKeywords.length}개 키워드 ===`);
}

// ═════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════

function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ═════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════

const command = process.argv[2] || 'all';

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   TrendRadar 데이터 수집기 v1.0             ║');
  console.log(`║   명령: ${command.padEnd(37)}║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  const startTime = Date.now();

  try {
    switch (command) {
      case 'all':
        await collectAllPodcastEpisodes();
        await collectInstagramData();
        await collectFacebookAdsData();
        await collectGoogleTrendsData();
        await collectThreadsData();
        await scoreOpportunities();
        await analyzeKeywordOrigins();
        break;
      case 'podcasts':
        await collectAllPodcastEpisodes();
        break;
      case 'instagram':
        await collectInstagramData();
        break;
      case 'facebook':
        await collectFacebookAdsData();
        break;
      case 'google':
        await collectGoogleTrendsData();
        break;
      case 'threads':
        await collectThreadsData();
        break;
      case 'analyze':
        await analyzeKeywordOrigins();
        break;
      case 'score':
        await scoreOpportunities();
        break;
      case 'seed':
        // 시드 키워드로 모든 소셜 데이터 수집
        await collectInstagramData();
        await collectFacebookAdsData();
        await collectGoogleTrendsData();
        await scoreOpportunities();
        break;
      default:
        console.log('사용법: node collect.js [all|podcasts|instagram|facebook|google|threads|analyze|score|seed]');
    }
  } catch (err) {
    console.error('수집 실패:', err.message);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('');
  console.log(`✅ 완료 (${elapsed}초 소요)`);
}

main();
