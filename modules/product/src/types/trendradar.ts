// [TrendRadar] 타입 정의

export interface PodcastKeyword {
  influencer: string;
  keyword: string;
  mentioned_date: string;
  episode_title: string;
  episode_url: string;
  episode_id: string;
  mention_timestamp_seconds: number | null;
  mention_context: string;
  mention_quote: string | null;
  is_new?: boolean;
}

export interface InstagramSnapshot {
  keyword: string;
  hashtag: string;
  post_count: number;
  recent_post_count: number;
  snapshot_date: string;
  day_over_day_change?: number;
  week_over_week_change?: number;
}

export interface FacebookAdsSnapshot {
  keyword: string;
  total_ads: number;
  unique_advertisers: number;
  new_advertisers_this_week: number;
  oldest_ad_date: string | null;
  newest_ad_date: string | null;
  competition_level: 'low' | 'medium' | 'high' | 'unknown';
  snapshot_date: string;
}

export interface GoogleTrendsSnapshot {
  keyword: string;
  current_3m_avg: number;
  prev_3m_avg: number;
  growth_rate: number;
  trend_direction: 'rising' | 'stable' | 'falling';
  snapshot_date: string;
  from_cache?: boolean;
}

export interface OpportunityScore {
  keyword: string;
  opportunity_score: number;
  verdict: string;
  score_breakdown: {
    podcast_recency: number;
    instagram_growth: number;
    google_trends_growth: number;
    facebook_competition_inverse: number;
  };
  strategy_comment: string;
  podcast_mention_date: string | null;
  instagram_weekly_growth: number | null;
  google_growth_rate: number | null;
  facebook_advertiser_count: number | null;
  snapshot_date: string;
}

export interface InfluencerConfig {
  name: string;
  taddy_uuid: string;
  podcast_search_name: string;
  ig_handle: string;
  keywords_focus: string[];
}

export interface TaddyEpisode {
  uuid: string;
  name: string;
  datePublished: string;
  audioUrl: string | null;
  description: string | null;
  taddyTranscribeStatus: string | null;
  transcript: string | null;
  transcriptWithSpeakersAndTimecodes: TaddyTranscriptItem[] | null;
  podcastSeries: {
    uuid: string;
    name: string;
  };
}

export interface TaddyTranscriptItem {
  text: string;
  startTime: number;
  speaker?: string;
}

export interface KeywordOriginResult {
  keyword: string;
  first_podcast_mention: {
    date: string;
    influencer_name: string;
    podcast_name: string;
    episode_title: string;
    quote: string;
    timestamp_seconds: number;
  } | null;
  market_creator: {
    date: string;
    influencer_name: string;
    podcast_name: string;
    episode_title: string;
    quote: string;
    ig_growth_after_30days: number;
    google_growth_after_30days: number;
  } | null;
  mention_timeline: Array<{
    date: string;
    influencer_name: string;
    platform: 'podcast' | 'instagram' | 'facebook_ad';
    content_type: 'podcast_episode' | 'ig_post' | 'ad';
    description: string;
    impact_score: number;
  }>;
  spread_pattern: {
    podcast_first_date: string | null;
    instagram_influencer_post_date: string | null;
    hashtag_explosion_date: string | null;
    first_ad_date: string | null;
    google_trends_spike_date: string | null;
  };
  golden_time: {
    start_date: string | null;
    end_date: string | null;
    duration_days: number | null;
    is_currently_golden: boolean;
    days_remaining: number | null;
    avg_golden_time_days: number;
  };
  analysis_report: string;
  analyzed_at: string;
}

export interface CapabilityContext {
  supabase: import('@supabase/supabase-js').SupabaseClient;
  reportProgress: (message: string) => void;
}

export interface AgentEvent {
  event_type: string;
  summary: string;
  metrics: Record<string, unknown>;
  urgency: 'low' | 'medium' | 'high' | 'critical';
}
