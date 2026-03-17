// [TrendRadar] run-full-scan capability

import type { CapabilityContext, AgentEvent } from '../types/trendradar.js';
import { scanPodcastKeywords, INFLUENCERS } from './scan-podcast-keywords.js';
import { measureInstagramSignal } from './measure-instagram-signal.js';
import { measureFacebookAdsSignal } from './measure-facebook-ads-signal.js';
import { measureGoogleTrendsSignal } from './measure-google-trends-signal.js';
import { analyzeOpportunity } from './analyze-opportunity.js';

interface FullScanParams {
  influencers?: string[];
  days_back?: number;
}

interface FullScanResult {
  total_keywords: number;
  new_keywords: number;
  high_opportunity_keywords: Array<{ keyword: string; score: number; verdict: string }>;
  events_reported: number;
}

export async function runFullScan(
  params: FullScanParams,
  ctx: CapabilityContext,
  reportEvent?: (event: AgentEvent) => Promise<void>,
): Promise<FullScanResult> {
  const influencerKeys = params.influencers ?? ['huberman', 'sinclair', 'attia', 'brecka'];
  const daysBack = params.days_back ?? 30;

  ctx.reportProgress('[full-scan] Step 1/5: 팟캐스트 키워드 스캔 시작');

  // Step 1: 팟캐스트 키워드 스캔
  const allKeywords = new Set<string>();
  let totalNew = 0;

  for (const key of influencerKeys) {
    if (!INFLUENCERS[key]) {
      console.warn(`[TrendRadar] 알 수 없는 인플루언서 스킵: ${key}`);
      continue;
    }

    try {
      const result = await scanPodcastKeywords(
        { influencer: key, days_back: daysBack },
        ctx,
      );
      for (const kw of result.keywords) {
        allKeywords.add(kw.keyword);
      }
      totalNew += result.new_keywords_found;
    } catch (err) {
      console.error(`[TrendRadar] 팟캐스트 스캔 실패 (${key}):`, (err as Error).message);
    }
  }

  const keywordList = Array.from(allKeywords);

  if (keywordList.length === 0) {
    ctx.reportProgress('[full-scan] 새 키워드 없음 — 스캔 종료');
    return { total_keywords: 0, new_keywords: 0, high_opportunity_keywords: [], events_reported: 0 };
  }

  // Step 2: Instagram 신호 측정
  ctx.reportProgress(`[full-scan] Step 2/5: Instagram 해시태그 측정 (${keywordList.length}개)`);
  try {
    await measureInstagramSignal({ keywords: keywordList }, ctx);
  } catch (err) {
    console.error('[TrendRadar] Instagram 측정 실패:', (err as Error).message);
  }

  // Step 3: Facebook Ads 신호 측정
  ctx.reportProgress(`[full-scan] Step 3/5: Facebook Ad Library 조회 (${keywordList.length}개)`);
  try {
    await measureFacebookAdsSignal({ keywords: keywordList }, ctx);
  } catch (err) {
    console.error('[TrendRadar] Facebook Ads 측정 실패:', (err as Error).message);
  }

  // Step 4: Google Trends 신호 측정
  ctx.reportProgress(`[full-scan] Step 4/5: Google Trends 조회 (${keywordList.length}개)`);
  try {
    await measureGoogleTrendsSignal({ keywords: keywordList }, ctx);
  } catch (err) {
    console.error('[TrendRadar] Google Trends 측정 실패:', (err as Error).message);
  }

  // Step 5: 기회 분석
  ctx.reportProgress('[full-scan] Step 5/5: 기회 점수 분석');
  let analysisResult;
  try {
    analysisResult = await analyzeOpportunity({ keywords: keywordList }, ctx);
  } catch (err) {
    console.error('[TrendRadar] 기회 분석 실패:', (err as Error).message);
    return { total_keywords: keywordList.length, new_keywords: totalNew, high_opportunity_keywords: [], events_reported: 0 };
  }

  // 80점 이상 키워드 이벤트 보고
  const highOpportunities = analysisResult.opportunities.filter(o => o.opportunity_score >= 80);
  let eventsReported = 0;

  for (const opp of highOpportunities) {
    if (reportEvent) {
      try {
        await reportEvent({
          event_type: 'trendradar.opportunity_found',
          summary: `신제품 기회 발견: ${opp.keyword} (${opp.opportunity_score}점) — ${opp.verdict}`,
          metrics: {
            keyword: opp.keyword,
            opportunity_score: opp.opportunity_score,
            podcast_mention_date: opp.podcast_mention_date,
            instagram_growth: opp.instagram_weekly_growth,
            facebook_competition: opp.facebook_advertiser_count,
          },
          urgency: 'high',
        });
        eventsReported++;
      } catch (err) {
        console.error('[TrendRadar] 이벤트 보고 실패:', (err as Error).message);
      }
    }
  }

  ctx.reportProgress(`[full-scan] 완료 — ${keywordList.length}개 키워드, ${highOpportunities.length}개 고기회`);

  return {
    total_keywords: keywordList.length,
    new_keywords: totalNew,
    high_opportunity_keywords: highOpportunities.map(o => ({
      keyword: o.keyword,
      score: o.opportunity_score,
      verdict: o.verdict,
    })),
    events_reported: eventsReported,
  };
}
