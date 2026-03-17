// [TrendRadar] keyword-origin-analysis capability

import Anthropic from '@anthropic-ai/sdk';
import type { CapabilityContext, AgentEvent, KeywordOriginResult } from '../types/trendradar.js';
import { searchEpisodesByKeyword, extractKeywordContext } from '../services/taddy.js';
import { getAdLibrarySnapshot } from '../services/facebook-ad-library.js';
import { getInterestOverTime, findTrendsSpikeDate } from '../services/google-trends.js';
import { INFLUENCERS } from './scan-podcast-keywords.js';

interface OriginAnalysisParams {
  keyword: string;
  search_all_podcasts?: boolean;
}

function daysBetween(a: Date | string, b: Date | string): number {
  const dateA = typeof a === 'string' ? new Date(a) : a;
  const dateB = typeof b === 'string' ? new Date(b) : b;
  return Math.floor(Math.abs(dateB.getTime() - dateA.getTime()) / (24 * 60 * 60 * 1000));
}

function daysSince(dateStr: string): number {
  return daysBetween(new Date(), dateStr);
}

function toDateStr(date: Date | string): string {
  if (typeof date === 'string') return date.split('T')[0];
  return date.toISOString().split('T')[0];
}

const MONITORED_PODCAST_UUIDS = Object.values(INFLUENCERS).map(i => i.taddy_uuid);

export async function keywordOriginAnalysis(
  params: OriginAnalysisParams,
  ctx: CapabilityContext,
  reportEvent?: (event: AgentEvent) => Promise<void>,
): Promise<KeywordOriginResult> {
  const { keyword } = params;
  const today = toDateStr(new Date());

  ctx.reportProgress(`[origin] Step 1/8: "${keyword}" 전체 팟캐스트 언급 검색 중...`);

  // STEP 1: Taddy에서 전체 팟캐스트 키워드 검색 (날짜 오름차순)
  const allMentions = await searchEpisodesByKeyword(keyword, {
    sortBy: 'DATE',
    filterForHasTranscript: true,
    limit: 50,
  });

  // 최초 언급 후보
  const firstMention = allMentions.length > 0 ? allMentions[0] : null;

  ctx.reportProgress(`[origin] Step 2/8: 인플루언서별 언급 시점 필터링...`);

  // STEP 2: 모니터링 인플루언서별 언급 시점 필터링
  const influencerMentions = allMentions.filter(ep =>
    MONITORED_PODCAST_UUIDS.includes(ep.podcastSeries.uuid),
  );

  // 인플루언서 이름 매핑
  function getInfluencerName(podcastUuid: string): string {
    for (const [, config] of Object.entries(INFLUENCERS)) {
      if (config.taddy_uuid === podcastUuid) return config.name;
    }
    return 'Unknown';
  }

  ctx.reportProgress(`[origin] Step 3/8: 인플루언서별 Instagram 반응 분석 중...`);

  // STEP 3: 각 인플루언서 언급 후 30일 Instagram 해시태그 변화 계산
  let marketCreator: KeywordOriginResult['market_creator'] = null;
  let bestIgGrowth = -Infinity;

  for (const mention of influencerMentions) {
    const mentionDate = toDateStr(mention.datePublished);
    const after30Date = new Date(mention.datePublished);
    after30Date.setDate(after30Date.getDate() + 30);

    // DB에서 해당 날짜 전후 스냅샷 조회
    const { data: beforeSnap } = await ctx.supabase
      .from('instagram_snapshots')
      .select('post_count')
      .eq('keyword', keyword)
      .lte('snapshot_date', mentionDate)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .single();

    const { data: afterSnap } = await ctx.supabase
      .from('instagram_snapshots')
      .select('post_count')
      .eq('keyword', keyword)
      .lte('snapshot_date', toDateStr(after30Date))
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .single();

    const beforeCount = beforeSnap?.post_count ?? 0;
    const afterCount = afterSnap?.post_count ?? 0;
    const igGrowth = beforeCount > 0
      ? Math.round(((afterCount - beforeCount) / beforeCount) * 10000) / 100
      : 0;

    if (igGrowth > bestIgGrowth) {
      bestIgGrowth = igGrowth;

      let quote = '';
      if (mention.transcriptWithSpeakersAndTimecodes) {
        const contexts = extractKeywordContext(mention.transcriptWithSpeakersAndTimecodes, keyword);
        if (contexts.length > 0) quote = contexts[0].quote;
      }

      marketCreator = {
        date: mentionDate,
        influencer_name: getInfluencerName(mention.podcastSeries.uuid),
        podcast_name: mention.podcastSeries.name,
        episode_title: mention.name,
        quote,
        ig_growth_after_30days: igGrowth,
        google_growth_after_30days: 0, // Step 5에서 업데이트
      };
    }
  }

  ctx.reportProgress(`[origin] Step 4/8: Facebook Ad Library 첫 광고 집행일 조회...`);

  // STEP 4: Meta Ad Library에서 해당 키워드 oldest_ad_date 조회
  let firstAdDate: string | null = null;
  try {
    const fbSnapshot = await getAdLibrarySnapshot(keyword, { days_back: 365 });
    firstAdDate = fbSnapshot?.oldest_ad_date ?? null;
  } catch (err) {
    console.error(`[TrendRadar] Ad Library 조회 실패 (${keyword}):`, (err as Error).message);
  }

  ctx.reportProgress(`[origin] Step 5/8: Google Trends 급등 시점 분석...`);

  // STEP 5: Google Trends에서 급등 시점 계산
  let googleSpikeDate: string | null = null;
  try {
    const trendsData = await getInterestOverTime(keyword);
    if (trendsData?.timelineData) {
      googleSpikeDate = findTrendsSpikeDate(trendsData.timelineData);
    }
  } catch (err) {
    console.error(`[TrendRadar] Google Trends 조회 실패 (${keyword}):`, (err as Error).message);
  }

  ctx.reportProgress(`[origin] Step 6/8: 골든타임 계산...`);

  // STEP 6: 골든타임 계산
  const goldenTimeStart = marketCreator?.date ?? null;
  const goldenTimeEnd = firstAdDate;
  const durationDays = goldenTimeStart && goldenTimeEnd
    ? daysBetween(goldenTimeStart, goldenTimeEnd)
    : null;

  const isCurrentlyGolden = goldenTimeStart && !goldenTimeEnd
    ? true // 언급됐지만 아직 광고 없음 = 골든타임 진행 중
    : !!(goldenTimeStart && goldenTimeEnd
      && new Date() >= new Date(goldenTimeStart)
      && new Date() <= new Date(goldenTimeEnd));

  const daysRemaining = isCurrentlyGolden && goldenTimeEnd
    ? daysBetween(new Date(), goldenTimeEnd)
    : isCurrentlyGolden && !goldenTimeEnd
      ? null // 종료일 미정 (아직 광고 없음)
      : 0;

  // 과거 키워드 평균 골든타임 조회
  const { data: avgData } = await ctx.supabase
    .from('keyword_origins')
    .select('golden_time_duration_days')
    .not('golden_time_duration_days', 'is', null);

  const avgGoldenTime = avgData && avgData.length > 0
    ? Math.round(avgData.reduce((sum, r) => sum + (r.golden_time_duration_days ?? 0), 0) / avgData.length)
    : 45; // 기본값

  ctx.reportProgress(`[origin] Step 7/8: 골든타임 이벤트 보고...`);

  // STEP 7: 골든타임 이벤트 보고
  if (isCurrentlyGolden && reportEvent) {
    try {
      await reportEvent({
        event_type: 'trendradar.golden_time_detected',
        summary: `🚨 골든타임 진행 중: ${keyword} — ${marketCreator?.influencer_name} 언급 후 아직 광고 없음`,
        metrics: {
          keyword,
          golden_time_start: goldenTimeStart,
          days_since_mention: goldenTimeStart ? daysSince(goldenTimeStart) : null,
          market_creator: marketCreator?.influencer_name,
        },
        urgency: 'critical',
      });
    } catch (err) {
      console.error('[TrendRadar] 골든타임 이벤트 보고 실패:', (err as Error).message);
    }
  }

  ctx.reportProgress(`[origin] Step 8/8: AI 분석 리포트 생성...`);

  // STEP 8: Claude API 분석 리포트 생성
  let analysisReport = '';
  try {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `아래 키워드 기원 데이터를 보고 신제품 진입 전략을 한국어로 분석해줘.
골든타임이 남아있는지, 누구의 영향력이 가장 컸는지, 어떤 메시지로 시장이 열렸는지 중심으로 3-5줄로.

키워드: ${keyword}
최초 팟캐스트 언급: ${firstMention ? `${toDateStr(firstMention.datePublished)} — ${firstMention.podcastSeries.name}` : '없음'}
시장 형성자: ${marketCreator ? `${marketCreator.influencer_name} (${marketCreator.date})` : '없음'}
시장 형성자 발언: "${marketCreator?.quote ?? '없음'}"
인스타 성장률: ${marketCreator?.ig_growth_after_30days ?? 0}%
첫 광고 집행일: ${firstAdDate ?? '아직 없음'}
골든타임 상태: ${isCurrentlyGolden ? '진행 중' : '종료'}`,
      }],
    });
    analysisReport = response.content[0].type === 'text' ? response.content[0].text : '';
  } catch (err) {
    console.error('[TrendRadar] AI 분석 리포트 생성 실패:', (err as Error).message);
  }

  // 타임라인 구성
  const mentionTimeline: KeywordOriginResult['mention_timeline'] = allMentions.map(ep => ({
    date: toDateStr(ep.datePublished),
    influencer_name: getInfluencerName(ep.podcastSeries.uuid),
    platform: 'podcast' as const,
    content_type: 'podcast_episode' as const,
    description: ep.name,
    impact_score: MONITORED_PODCAST_UUIDS.includes(ep.podcastSeries.uuid) ? 70 : 30,
  }));

  // 확산 경로
  const spreadPattern: KeywordOriginResult['spread_pattern'] = {
    podcast_first_date: firstMention ? toDateStr(firstMention.datePublished) : null,
    instagram_influencer_post_date: null, // Instagram Graph API 인플루언서 포스팅 추적 필요
    hashtag_explosion_date: null,
    first_ad_date: firstAdDate,
    google_trends_spike_date: googleSpikeDate,
  };

  // 첫 언급 정보
  let firstPodcastMention: KeywordOriginResult['first_podcast_mention'] = null;
  if (firstMention) {
    let quote = '';
    let timestampSeconds = 0;
    if (firstMention.transcriptWithSpeakersAndTimecodes) {
      const contexts = extractKeywordContext(firstMention.transcriptWithSpeakersAndTimecodes, keyword);
      if (contexts.length > 0) {
        quote = contexts[0].quote;
        timestampSeconds = contexts[0].timestamp_seconds;
      }
    }

    firstPodcastMention = {
      date: toDateStr(firstMention.datePublished),
      influencer_name: getInfluencerName(firstMention.podcastSeries.uuid),
      podcast_name: firstMention.podcastSeries.name,
      episode_title: firstMention.name,
      quote,
      timestamp_seconds: timestampSeconds,
    };
  }

  const result: KeywordOriginResult = {
    keyword,
    first_podcast_mention: firstPodcastMention,
    market_creator: marketCreator,
    mention_timeline: mentionTimeline,
    spread_pattern: spreadPattern,
    golden_time: {
      start_date: goldenTimeStart,
      end_date: goldenTimeEnd,
      duration_days: durationDays,
      is_currently_golden: isCurrentlyGolden,
      days_remaining: daysRemaining,
      avg_golden_time_days: avgGoldenTime,
    },
    analysis_report: analysisReport,
    analyzed_at: new Date().toISOString(),
  };

  // DB upsert
  await ctx.supabase.from('keyword_origins').upsert(
    {
      keyword,
      first_podcast_date: firstPodcastMention?.date,
      first_podcast_influencer: firstPodcastMention?.influencer_name,
      first_podcast_name: firstPodcastMention?.podcast_name,
      first_podcast_episode_title: firstPodcastMention?.episode_title,
      first_podcast_quote: firstPodcastMention?.quote,
      first_podcast_timestamp_seconds: firstPodcastMention?.timestamp_seconds,
      market_creator_date: marketCreator?.date,
      market_creator_influencer: marketCreator?.influencer_name,
      market_creator_podcast_name: marketCreator?.podcast_name,
      market_creator_episode_title: marketCreator?.episode_title,
      market_creator_quote: marketCreator?.quote,
      market_creator_ig_growth: marketCreator?.ig_growth_after_30days,
      market_creator_google_growth: marketCreator?.google_growth_after_30days,
      mention_timeline: mentionTimeline,
      spread_pattern: spreadPattern,
      golden_time_start: goldenTimeStart,
      golden_time_end: goldenTimeEnd,
      golden_time_duration_days: durationDays,
      avg_golden_time_days: avgGoldenTime,
      analysis_report: analysisReport,
      analyzed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'keyword' },
  );

  ctx.reportProgress(`[origin] "${keyword}" 기원 분석 완료 — 골든타임: ${isCurrentlyGolden ? '진행 중' : '종료'}`);

  return result;
}
