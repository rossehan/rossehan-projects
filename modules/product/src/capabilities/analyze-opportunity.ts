// [TrendRadar] analyze-opportunity capability

import Anthropic from '@anthropic-ai/sdk';
import type { CapabilityContext, OpportunityScore } from '../types/trendradar.js';

interface AnalyzeParams {
  keywords: string[];
  refresh_data?: boolean;
}

interface AnalyzeResult {
  opportunities: OpportunityScore[];
}

// 전략 코멘트 캐시 (TTL 6시간)
const commentCache = new Map<string, { comment: string; cachedAt: number }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function daysSince(dateStr: string): number {
  const date = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000));
}

function podcastRecencyScore(mentionDate: string | null): number {
  if (!mentionDate) return 0;
  const days = daysSince(mentionDate);
  if (days <= 30) return 30;
  if (days <= 60) return 20;
  if (days <= 90) return 10;
  return 5;
}

function instagramGrowthScore(weeklyGrowth: number | null): number {
  if (weeklyGrowth === null) return 0;
  if (weeklyGrowth >= 50) return 25;
  if (weeklyGrowth >= 20) return 18;
  if (weeklyGrowth >= 10) return 12;
  if (weeklyGrowth >= 0) return 6;
  return 0;
}

function googleTrendsScore(growthRate: number | null): number {
  if (growthRate === null) return 0;
  if (growthRate >= 100) return 25;
  if (growthRate >= 50) return 20;
  if (growthRate >= 20) return 14;
  if (growthRate >= 0) return 7;
  return 0;
}

function facebookCompetitionScore(level: string | null): number {
  if (!level || level === 'unknown') return 10;
  if (level === 'low') return 20;
  if (level === 'medium') return 10;
  return 0;
}

function getVerdict(score: number): string {
  if (score >= 80) return '🟢 지금 바로 진입하세요';
  if (score >= 60) return '🟡 6개월 내 진입 고려';
  return '🔴 이미 포화 or 수요 미확인';
}

async function generateStrategyComment(
  keyword: string,
  score: number,
  podcastDate: string | null,
  igGrowth: number | null,
  googleGrowth: number | null,
  fbLevel: string | null,
): Promise<string> {
  const cacheKey = `${keyword}-${score}`;
  const cached = commentCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.comment;
  }

  try {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `아래 데이터를 보고 미국 아마존 서플리먼트 시장에서 이 성분의 신제품 진입 전략을 한국어로 2-3줄로 간결하게 알려줘.
성분: ${keyword}, 기회 점수: ${score}/100,
팟캐스트 언급: ${podcastDate ?? '없음'}, 인스타 주간 성장: ${igGrowth ?? 0}%,
구글 트렌드 성장: ${googleGrowth ?? 0}%, 페이스북 광고 경쟁도: ${fbLevel ?? 'unknown'}`,
      }],
    });

    const comment = response.content[0].type === 'text' ? response.content[0].text : '';
    commentCache.set(cacheKey, { comment, cachedAt: Date.now() });
    return comment;
  } catch (err) {
    console.error('[TrendRadar] 전략 코멘트 생성 실패:', (err as Error).message);
    return '';
  }
}

export async function analyzeOpportunity(
  params: AnalyzeParams,
  ctx: CapabilityContext,
): Promise<AnalyzeResult> {
  const today = new Date().toISOString().split('T')[0];
  const opportunities: OpportunityScore[] = [];

  ctx.reportProgress(`[analyze] ${params.keywords.length}개 키워드 기회 분석 중...`);

  for (const keyword of params.keywords) {
    // DB에서 최신 데이터 조회
    const { data: podcastData } = await ctx.supabase
      .from('podcast_keywords')
      .select('mentioned_date')
      .eq('keyword', keyword)
      .order('mentioned_date', { ascending: false })
      .limit(1)
      .single();

    const { data: igData } = await ctx.supabase
      .from('instagram_snapshots')
      .select('*')
      .eq('keyword', keyword)
      .order('snapshot_date', { ascending: false })
      .limit(2);

    const { data: googleData } = await ctx.supabase
      .from('google_trends_snapshots')
      .select('growth_rate')
      .eq('keyword', keyword)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .single();

    const { data: fbData } = await ctx.supabase
      .from('facebook_ads_snapshots')
      .select('competition_level, unique_advertisers')
      .eq('keyword', keyword)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .single();

    // 인스타 주간 성장률 계산
    let igWeeklyGrowth: number | null = null;
    if (igData && igData.length >= 2) {
      const current = igData[0].post_count ?? 0;
      const prev = igData[1].post_count ?? 0;
      if (prev > 0) {
        igWeeklyGrowth = Math.round(((current - prev) / prev) * 10000) / 100;
      }
    }

    const podcastMentionDate = podcastData?.mentioned_date ?? null;
    const googleGrowthRate = googleData?.growth_rate ?? null;
    const fbLevel = fbData?.competition_level ?? null;

    // 점수 계산
    const breakdown = {
      podcast_recency: podcastRecencyScore(podcastMentionDate),
      instagram_growth: instagramGrowthScore(igWeeklyGrowth),
      google_trends_growth: googleTrendsScore(googleGrowthRate),
      facebook_competition_inverse: facebookCompetitionScore(fbLevel),
    };

    const totalScore = breakdown.podcast_recency
      + breakdown.instagram_growth
      + breakdown.google_trends_growth
      + breakdown.facebook_competition_inverse;

    const verdict = getVerdict(totalScore);

    // 전략 코멘트 생성
    const strategyComment = await generateStrategyComment(
      keyword, totalScore, podcastMentionDate, igWeeklyGrowth, googleGrowthRate, fbLevel,
    );

    const opportunity: OpportunityScore = {
      keyword,
      opportunity_score: totalScore,
      verdict,
      score_breakdown: breakdown,
      strategy_comment: strategyComment,
      podcast_mention_date: podcastMentionDate,
      instagram_weekly_growth: igWeeklyGrowth,
      google_growth_rate: googleGrowthRate,
      facebook_advertiser_count: fbData?.unique_advertisers ?? null,
      snapshot_date: today,
    };

    opportunities.push(opportunity);

    // DB 저장
    await ctx.supabase.from('opportunity_scores').upsert(
      {
        keyword,
        opportunity_score: totalScore,
        verdict,
        score_breakdown: breakdown,
        strategy_comment: strategyComment,
        podcast_mention_date: podcastMentionDate,
        instagram_weekly_growth: igWeeklyGrowth,
        google_growth_rate: googleGrowthRate,
        facebook_advertiser_count: fbData?.unique_advertisers ?? null,
        snapshot_date: today,
      },
      { onConflict: 'keyword,snapshot_date' },
    );
  }

  ctx.reportProgress(`[analyze] 분석 완료 — ${opportunities.filter(o => o.opportunity_score >= 80).length}개 고기회 발견`);

  return { opportunities };
}
