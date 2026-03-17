// [TrendRadar] measure-google-trends-signal capability

import type { CapabilityContext, GoogleTrendsSnapshot } from '../types/trendradar.js';
import { batchGetTrendsSnapshots } from '../services/google-trends.js';

interface MeasureGoogleTrendsParams {
  keywords: string[];
  compare_months?: number;
}

interface MeasureGoogleTrendsResult {
  snapshots: GoogleTrendsSnapshot[];
}

export async function measureGoogleTrendsSignal(
  params: MeasureGoogleTrendsParams,
  ctx: CapabilityContext,
): Promise<MeasureGoogleTrendsResult> {
  const today = new Date().toISOString().split('T')[0];

  ctx.reportProgress(`[google-trends] ${params.keywords.length}개 키워드 트렌드 조회 중...`);

  const results = await batchGetTrendsSnapshots(params.keywords, ctx.supabase);

  const snapshots: GoogleTrendsSnapshot[] = [];

  for (const result of results) {
    const snapshot: GoogleTrendsSnapshot = {
      ...result,
      snapshot_date: today,
    };

    snapshots.push(snapshot);

    // DB 저장
    await ctx.supabase.from('google_trends_snapshots').upsert(
      {
        keyword: result.keyword,
        current_3m_avg: result.current_3m_avg,
        prev_3m_avg: result.prev_3m_avg,
        growth_rate: result.growth_rate,
        trend_direction: result.trend_direction,
        snapshot_date: today,
      },
      { onConflict: 'keyword,snapshot_date' },
    );
  }

  ctx.reportProgress(`[google-trends] ${snapshots.length}개 스냅샷 저장 완료`);

  return { snapshots };
}
