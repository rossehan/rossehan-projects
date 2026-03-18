// [TrendRadar] scan-podcast-keywords capability

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CapabilityContext, InfluencerConfig, PodcastKeyword } from '../types/trendradar.js';
import {
  getEpisodesWithTranscripts,
  extractKeywordContext,
  extractSupplementKeywords,
  searchPodcastSeries,
} from '../services/taddy.js';

export const INFLUENCERS: Record<string, InfluencerConfig> = {
  huberman: {
    name: 'Andrew Huberman',
    taddy_uuid: '',
    podcast_search_name: 'Huberman Lab',
    ig_handle: 'hubermanlab',
    keywords_focus: ['nmn', 'tongkat ali', 'apigenin', 'magnesium', 'alpha-gpc', 'fadogia'],
  },
  sinclair: {
    name: 'David Sinclair',
    taddy_uuid: '',
    podcast_search_name: 'Lifespan David Sinclair',
    ig_handle: 'davidsinclairphd',
    keywords_focus: ['nmn', 'resveratrol', 'spermidine', 'fisetin', 'berberine', 'taurine'],
  },
  attia: {
    name: 'Peter Attia',
    taddy_uuid: '',
    podcast_search_name: 'The Drive Peter Attia',
    ig_handle: 'peterattiamd',
    keywords_focus: ['omega3', 'rapamycin', 'berberine', 'glycine', 'ashwagandha', 'creatine'],
  },
  brecka: {
    name: 'Gary Brecka',
    taddy_uuid: '',
    podcast_search_name: 'Ultimate Human Gary Brecka',
    ig_handle: 'garybrecka',
    keywords_focus: ['methyl folate', 'spermidine', 'mthfr', 'methylated b12', 'methylation'],
  },
  hyman: {
    name: 'Mark Hyman',
    taddy_uuid: '',
    podcast_search_name: 'The Doctor\'s Farmacy Mark Hyman',
    ig_handle: 'drmarkhyman',
    keywords_focus: ['probiotics', 'glutathione', 'coq10', 'nac', 'curcumin', 'digestive enzymes'],
  },
  patrick: {
    name: 'Rhonda Patrick',
    taddy_uuid: '',
    podcast_search_name: 'FoundMyFitness Rhonda Patrick',
    ig_handle: 'foundmyfitness',
    keywords_focus: ['sulforaphane', 'omega3', 'vitamin d', "lion's mane", 'magnesium', 'sauna'],
  },
};

// Taddy에서 팟캐스트 UUID 자동 검색 & 캐싱
export async function resolveInfluencerUUIDs(
  reportProgress?: (msg: string) => void,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [key, config] of Object.entries(INFLUENCERS)) {
    if (config.taddy_uuid) {
      resolved[key] = config.taddy_uuid;
      continue;
    }

    reportProgress?.(`[resolve-uuid] ${config.name} 팟캐스트 검색 중: "${config.podcast_search_name}"`);

    const results = await searchPodcastSeries(config.podcast_search_name, 3);
    if (results.length > 0) {
      config.taddy_uuid = results[0].uuid;
      resolved[key] = results[0].uuid;
      reportProgress?.(`[resolve-uuid] ✅ ${config.name} → ${results[0].name} (${results[0].uuid})`);
    } else {
      reportProgress?.(`[resolve-uuid] ❌ ${config.name} — 검색 결과 없음`);
    }
  }

  return resolved;
}

interface ScanParams {
  influencer: string;
  days_back?: number;
  use_transcript?: boolean;
}

interface ScanResult {
  influencer: string;
  episodes_scanned: number;
  new_keywords_found: number;
  keywords: PodcastKeyword[];
}

function isWithinDays(dateStr: string, days: number): boolean {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  return diffMs <= days * 24 * 60 * 60 * 1000;
}

export async function scanPodcastKeywords(
  params: ScanParams,
  ctx: CapabilityContext,
): Promise<ScanResult> {
  const config = INFLUENCERS[params.influencer];
  if (!config) {
    throw new Error(`알 수 없는 인플루언서: ${params.influencer}`);
  }

  const daysBack = params.days_back ?? 30;
  const useTranscript = params.use_transcript ?? true;

  // UUID 미설정 시 자동 검색
  if (!config.taddy_uuid) {
    ctx.reportProgress(`[scan-podcast] ${config.name} UUID 미설정 → 자동 검색 중...`);
    const results = await searchPodcastSeries(config.podcast_search_name, 3);
    if (results.length > 0) {
      config.taddy_uuid = results[0].uuid;
      ctx.reportProgress(`[scan-podcast] ✅ ${config.name} → ${results[0].name} (${results[0].uuid})`);
    } else {
      throw new Error(`${config.name} 팟캐스트를 Taddy에서 찾을 수 없습니다.`);
    }
  }

  ctx.reportProgress(`[scan-podcast] ${config.name} 최근 에피소드 조회 중...`);

  const episodes = await getEpisodesWithTranscripts(config.taddy_uuid, 10);
  const recentEpisodes = episodes.filter(ep => isWithinDays(ep.datePublished, daysBack));

  ctx.reportProgress(`[scan-podcast] ${recentEpisodes.length}개 에피소드 분석 중...`);

  const allKeywords: PodcastKeyword[] = [];

  for (const episode of recentEpisodes) {
    const hasTranscript = useTranscript && episode.transcript;
    const extracted = await extractSupplementKeywords(
      episode.name,
      hasTranscript ? episode.transcript : null,
      episode.description,
    );

    for (const item of extracted) {
      let timestampSeconds: number | null = null;
      let quote: string | null = item.quote;

      // 트랜스크립트에서 타임스탬프와 문맥 추출
      if (episode.transcriptWithSpeakersAndTimecodes) {
        const contexts = extractKeywordContext(
          episode.transcriptWithSpeakersAndTimecodes,
          item.keyword,
        );
        if (contexts.length > 0) {
          timestampSeconds = contexts[0].timestamp_seconds;
          quote = contexts[0].quote;
        }
      }

      allKeywords.push({
        influencer: params.influencer,
        keyword: item.keyword.toLowerCase(),
        mentioned_date: episode.datePublished.split('T')[0],
        episode_title: episode.name,
        episode_url: episode.audioUrl ?? '',
        episode_id: episode.uuid,
        mention_timestamp_seconds: timestampSeconds,
        mention_context: item.context,
        mention_quote: quote,
      });
    }
  }

  // Supabase upsert
  let newCount = 0;
  for (const kw of allKeywords) {
    const { data: existing } = await ctx.supabase
      .from('podcast_keywords')
      .select('id')
      .eq('influencer', kw.influencer)
      .eq('keyword', kw.keyword)
      .eq('mentioned_date', kw.mentioned_date)
      .single();

    if (!existing) {
      kw.is_new = true;
      newCount++;
    }

    await ctx.supabase.from('podcast_keywords').upsert(
      {
        influencer: kw.influencer,
        keyword: kw.keyword,
        mentioned_date: kw.mentioned_date,
        episode_title: kw.episode_title,
        episode_url: kw.episode_url,
        episode_id: kw.episode_id,
        mention_timestamp_seconds: kw.mention_timestamp_seconds,
        mention_context: kw.mention_context,
        mention_quote: kw.mention_quote,
      },
      { onConflict: 'influencer,keyword,mentioned_date' },
    );
  }

  ctx.reportProgress(`[scan-podcast] ${config.name}: ${allKeywords.length}개 키워드 (신규 ${newCount}개)`);

  return {
    influencer: params.influencer,
    episodes_scanned: recentEpisodes.length,
    new_keywords_found: newCount,
    keywords: allKeywords,
  };
}
