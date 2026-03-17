// [TrendRadar] Facebook Ad Library API 서비스

import type { FacebookAdsSnapshot } from '../types/trendradar.js';

const GRAPH_API_BASE = 'https://graph.facebook.com/v22.0';

function getDateNDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
}

function getCompetitionLevel(totalAds: number): 'low' | 'medium' | 'high' {
  if (totalAds < 5) return 'low';
  if (totalAds <= 20) return 'medium';
  return 'high';
}

export async function getAdLibrarySnapshot(
  keyword: string,
  options?: { country?: string; days_back?: number },
): Promise<Omit<FacebookAdsSnapshot, 'snapshot_date'> | null> {
  const country = options?.country ?? 'US';
  const daysBack = options?.days_back ?? 90;
  const minDate = getDateNDaysAgo(daysBack);
  const today = new Date().toISOString().split('T')[0];
  const oneWeekAgo = getDateNDaysAgo(7);

  try {
    const params = new URLSearchParams({
      search_terms: keyword,
      ad_reached_countries: JSON.stringify([country]),
      ad_delivery_date_min: minDate,
      fields: 'id,ad_creation_time,page_name,page_id',
      limit: '500',
      access_token: process.env.META_ACCESS_TOKEN!,
    });

    const response = await fetch(`${GRAPH_API_BASE}/ads_archive?${params}`);

    if (!response.ok) {
      const errorText = await response.text();
      // 헬스 카테고리 제한 에러 시 로그만 남기고 unknown 반환
      if (response.status === 400 || response.status === 403) {
        console.warn(`[TrendRadar] Facebook Ad Library 제한 (${keyword}): ${errorText}`);
        return {
          keyword,
          total_ads: 0,
          unique_advertisers: 0,
          new_advertisers_this_week: 0,
          oldest_ad_date: null,
          newest_ad_date: null,
          competition_level: 'unknown',
        };
      }
      throw new Error(`Facebook Ad Library API error: ${response.status}`);
    }

    const data = await response.json() as {
      data?: Array<{
        id: string;
        ad_creation_time: string;
        page_name: string;
        page_id: string;
      }>;
    };

    const ads = data?.data ?? [];

    if (ads.length === 0) {
      return {
        keyword,
        total_ads: 0,
        unique_advertisers: 0,
        new_advertisers_this_week: 0,
        oldest_ad_date: null,
        newest_ad_date: null,
        competition_level: 'low',
      };
    }

    const pageIds = new Set<string>();
    const newPageIds = new Set<string>();
    let oldestDate: string | null = null;
    let newestDate: string | null = null;

    for (const ad of ads) {
      pageIds.add(ad.page_id);
      const adDate = ad.ad_creation_time?.split('T')[0] ?? null;

      if (adDate) {
        if (!oldestDate || adDate < oldestDate) oldestDate = adDate;
        if (!newestDate || adDate > newestDate) newestDate = adDate;
        if (adDate >= oneWeekAgo) {
          newPageIds.add(ad.page_id);
        }
      }
    }

    return {
      keyword,
      total_ads: ads.length,
      unique_advertisers: pageIds.size,
      new_advertisers_this_week: newPageIds.size,
      oldest_ad_date: oldestDate,
      newest_ad_date: newestDate,
      competition_level: getCompetitionLevel(ads.length),
    };
  } catch (err) {
    console.error(`[TrendRadar] Facebook Ad Library 실패 (${keyword}):`, (err as Error).message);
    return null;
  }
}
