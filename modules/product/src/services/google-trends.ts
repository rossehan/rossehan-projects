// [TrendRadar] Google Trends 서비스

import googleTrends from 'google-trends-api';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { GoogleTrendsSnapshot } from '../types/trendradar.js';

const REQUEST_DELAY_MS = 2000; // 키워드 간 2초 딜레이

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getDateMonthsAgo(months: number): Date {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date;
}

export async function getInterestOverTime(
  keyword: string,
): Promise<{ timelineData: Array<{ date: string; value: number[] }> } | null> {
  try {
    const result = await googleTrends.interestOverTime({
      keyword,
      startTime: getDateMonthsAgo(6),
      geo: 'US',
    });
    return JSON.parse(result);
  } catch (err) {
    console.error(`[TrendRadar] Google Trends 실패 (${keyword}):`, (err as Error).message);
    return null;
  }
}

export function calculateGrowthRate(
  timelineData: Array<{ date: string; value: number[] }>,
  compareMonths: number = 3,
): Omit<GoogleTrendsSnapshot, 'keyword' | 'snapshot_date'> {
  const now = new Date();
  const midpoint = getDateMonthsAgo(compareMonths);

  const recent: number[] = [];
  const previous: number[] = [];

  for (const point of timelineData) {
    const pointDate = new Date(point.date);
    const value = point.value[0] ?? 0;

    if (pointDate >= midpoint) {
      recent.push(value);
    } else {
      previous.push(value);
    }
  }

  const currentAvg = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const prevAvg = previous.length > 0 ? previous.reduce((a, b) => a + b, 0) / previous.length : 0;

  const growthRate = prevAvg > 0 ? ((currentAvg - prevAvg) / prevAvg) * 100 : 0;

  let trendDirection: 'rising' | 'stable' | 'falling';
  if (growthRate > 10) trendDirection = 'rising';
  else if (growthRate < -10) trendDirection = 'falling';
  else trendDirection = 'stable';

  return {
    current_3m_avg: Math.round(currentAvg * 100) / 100,
    prev_3m_avg: Math.round(prevAvg * 100) / 100,
    growth_rate: Math.round(growthRate * 100) / 100,
    trend_direction: trendDirection,
  };
}

export async function getTrendsSnapshot(
  keyword: string,
  supabase?: SupabaseClient,
): Promise<Omit<GoogleTrendsSnapshot, 'snapshot_date'> | null> {
  const data = await getInterestOverTime(keyword);

  if (data?.timelineData) {
    const stats = calculateGrowthRate(data.timelineData);
    return { keyword, ...stats };
  }

  // API 실패 시 Supabase fallback
  if (supabase) {
    try {
      const { data: cached } = await supabase
        .from('google_trends_snapshots')
        .select('*')
        .eq('keyword', keyword)
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .single();

      if (cached) {
        console.log(`[TrendRadar] Google Trends fallback (${keyword}): DB 캐시 사용`);
        return {
          keyword,
          current_3m_avg: cached.current_3m_avg,
          prev_3m_avg: cached.prev_3m_avg,
          growth_rate: cached.growth_rate,
          trend_direction: cached.trend_direction,
          from_cache: true,
        };
      }
    } catch {
      // DB fallback도 실패하면 null
    }
  }

  return null;
}

export async function batchGetTrendsSnapshots(
  keywords: string[],
  supabase?: SupabaseClient,
): Promise<Array<Omit<GoogleTrendsSnapshot, 'snapshot_date'>>> {
  const results: Array<Omit<GoogleTrendsSnapshot, 'snapshot_date'>> = [];

  for (let i = 0; i < keywords.length; i++) {
    const result = await getTrendsSnapshot(keywords[i], supabase);
    if (result) {
      results.push(result);
    }
    if (i < keywords.length - 1) {
      await delay(REQUEST_DELAY_MS);
    }
  }

  return results;
}

export function findTrendsSpikeDate(
  timelineData: Array<{ date: string; value: number[] }>,
): string | null {
  for (let i = 1; i < timelineData.length; i++) {
    const prevValue = timelineData[i - 1].value[0] ?? 0;
    const currValue = timelineData[i].value[0] ?? 0;

    if (prevValue > 0 && ((currValue - prevValue) / prevValue) >= 0.5) {
      return timelineData[i].date;
    }
  }
  return null;
}
