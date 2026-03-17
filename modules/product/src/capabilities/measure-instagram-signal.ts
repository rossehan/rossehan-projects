// [TrendRadar] measure-instagram-signal capability

import type { CapabilityContext, InstagramSnapshot } from '../types/trendradar.js';
import { batchGetHashtagMediaCounts } from '../services/instagram-graph.js';

interface MeasureInstagramParams {
  keywords: string[];
  save_snapshot?: boolean;
}

interface MeasureInstagramResult {
  snapshots: InstagramSnapshot[];
}

function toDateStr(date: Date): string {
  return date.toISOString().split('T')[0];
}

export async function measureInstagramSignal(
  params: MeasureInstagramParams,
  ctx: CapabilityContext,
): Promise<MeasureInstagramResult> {
  const saveSnapshot = params.save_snapshot ?? true;
  const today = toDateStr(new Date());

  ctx.reportProgress(`[instagram] ${params.keywords.length}개 키워드 해시태그 측정 중...`);

  const mediaCounts = await batchGetHashtagMediaCounts(params.keywords);

  const snapshots: InstagramSnapshot[] = [];

  for (const mc of mediaCounts) {
    let dayOverDayChange: number | undefined;
    let weekOverWeekChange: number | undefined;

    // 전일 스냅샷 조회
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const { data: prevDay } = await ctx.supabase
      .from('instagram_snapshots')
      .select('post_count')
      .eq('keyword', mc.keyword)
      .eq('snapshot_date', toDateStr(yesterday))
      .single();

    if (prevDay?.post_count && prevDay.post_count > 0) {
      dayOverDayChange = Math.round(
        ((mc.post_count - prevDay.post_count) / prevDay.post_count) * 10000,
      ) / 100;
    }

    // 전주 스냅샷 조회
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    const { data: prevWeek } = await ctx.supabase
      .from('instagram_snapshots')
      .select('post_count')
      .eq('keyword', mc.keyword)
      .eq('snapshot_date', toDateStr(lastWeek))
      .single();

    if (prevWeek?.post_count && prevWeek.post_count > 0) {
      weekOverWeekChange = Math.round(
        ((mc.post_count - prevWeek.post_count) / prevWeek.post_count) * 10000,
      ) / 100;
    }

    const snapshot: InstagramSnapshot = {
      keyword: mc.keyword,
      hashtag: mc.hashtag,
      post_count: mc.post_count,
      recent_post_count: mc.recent_post_count,
      snapshot_date: today,
      day_over_day_change: dayOverDayChange,
      week_over_week_change: weekOverWeekChange,
    };

    snapshots.push(snapshot);

    // DB 저장
    if (saveSnapshot) {
      await ctx.supabase.from('instagram_snapshots').upsert(
        {
          keyword: mc.keyword,
          hashtag: mc.hashtag,
          post_count: mc.post_count,
          recent_post_count: mc.recent_post_count,
          snapshot_date: today,
        },
        { onConflict: 'keyword,snapshot_date' },
      );
    }
  }

  ctx.reportProgress(`[instagram] ${snapshots.length}개 스냅샷 저장 완료`);

  return { snapshots };
}
