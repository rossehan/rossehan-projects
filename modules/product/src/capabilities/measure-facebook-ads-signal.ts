// [TrendRadar] measure-facebook-ads-signal capability

import type { CapabilityContext, FacebookAdsSnapshot } from '../types/trendradar.js';
import { getAdLibrarySnapshot } from '../services/facebook-ad-library.js';

interface MeasureFacebookParams {
  keywords: string[];
  country?: string;
  days_back?: number;
}

interface MeasureFacebookResult {
  snapshots: FacebookAdsSnapshot[];
}

export async function measureFacebookAdsSignal(
  params: MeasureFacebookParams,
  ctx: CapabilityContext,
): Promise<MeasureFacebookResult> {
  const today = new Date().toISOString().split('T')[0];

  ctx.reportProgress(`[facebook-ads] ${params.keywords.length}개 키워드 광고 현황 조회 중...`);

  const snapshots: FacebookAdsSnapshot[] = [];

  for (const keyword of params.keywords) {
    try {
      const result = await getAdLibrarySnapshot(keyword, {
        country: params.country,
        days_back: params.days_back,
      });

      if (!result) continue;

      const snapshot: FacebookAdsSnapshot = {
        ...result,
        snapshot_date: today,
      };

      snapshots.push(snapshot);

      // DB 저장
      await ctx.supabase.from('facebook_ads_snapshots').upsert(
        {
          keyword: result.keyword,
          total_ads: result.total_ads,
          unique_advertisers: result.unique_advertisers,
          new_advertisers_this_week: result.new_advertisers_this_week,
          oldest_ad_date: result.oldest_ad_date,
          newest_ad_date: result.newest_ad_date,
          competition_level: result.competition_level,
          snapshot_date: today,
        },
        { onConflict: 'keyword,snapshot_date' },
      );
    } catch (err) {
      console.error(`[TrendRadar] Facebook ads 스킵 (${keyword}):`, (err as Error).message);
      continue;
    }
  }

  ctx.reportProgress(`[facebook-ads] ${snapshots.length}개 스냅샷 저장 완료`);

  return { snapshots };
}
