-- [TrendRadar] Supabase 테이블 생성 SQL
-- 실행: Supabase Dashboard → SQL Editor에서 이 파일 전체를 실행

-- 팟캐스트 키워드 언급 기록 (Taddy 트랜스크립트 기반)
CREATE TABLE IF NOT EXISTS podcast_keywords (
  id SERIAL PRIMARY KEY,
  influencer TEXT NOT NULL,
  keyword TEXT NOT NULL,
  mentioned_date DATE NOT NULL,
  episode_title TEXT,
  episode_url TEXT,
  episode_id TEXT,
  mention_timestamp_seconds INTEGER,
  mention_context TEXT,
  mention_quote TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(influencer, keyword, mentioned_date)
);
ALTER TABLE podcast_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE podcast_keywords FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON podcast_keywords FOR ALL USING (true) WITH CHECK (true);

-- Instagram 해시태그 스냅샷 (매일 저장)
CREATE TABLE IF NOT EXISTS instagram_snapshots (
  id SERIAL PRIMARY KEY,
  keyword TEXT NOT NULL,
  hashtag TEXT NOT NULL,
  post_count INTEGER,
  recent_post_count INTEGER,
  snapshot_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(keyword, snapshot_date)
);
ALTER TABLE instagram_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE instagram_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON instagram_snapshots FOR ALL USING (true) WITH CHECK (true);

-- Facebook Ad Library 스냅샷
CREATE TABLE IF NOT EXISTS facebook_ads_snapshots (
  id SERIAL PRIMARY KEY,
  keyword TEXT NOT NULL,
  total_ads INTEGER,
  unique_advertisers INTEGER,
  new_advertisers_this_week INTEGER,
  oldest_ad_date DATE,
  newest_ad_date DATE,
  competition_level TEXT,
  snapshot_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(keyword, snapshot_date)
);
ALTER TABLE facebook_ads_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE facebook_ads_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON facebook_ads_snapshots FOR ALL USING (true) WITH CHECK (true);

-- Google Trends 스냅샷
CREATE TABLE IF NOT EXISTS google_trends_snapshots (
  id SERIAL PRIMARY KEY,
  keyword TEXT NOT NULL,
  current_3m_avg REAL,
  prev_3m_avg REAL,
  growth_rate REAL,
  trend_direction TEXT,
  snapshot_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(keyword, snapshot_date)
);
ALTER TABLE google_trends_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_trends_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON google_trends_snapshots FOR ALL USING (true) WITH CHECK (true);

-- 기회 점수 기록
CREATE TABLE IF NOT EXISTS opportunity_scores (
  id SERIAL PRIMARY KEY,
  keyword TEXT NOT NULL,
  opportunity_score REAL,
  verdict TEXT,
  score_breakdown JSONB,
  strategy_comment TEXT,
  podcast_mention_date DATE,
  instagram_weekly_growth REAL,
  google_growth_rate REAL,
  facebook_advertiser_count INTEGER,
  snapshot_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(keyword, snapshot_date)
);
ALTER TABLE opportunity_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_scores FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON opportunity_scores FOR ALL USING (true) WITH CHECK (true);

-- 키워드 기원 분석 결과 (keyword-origin-analysis 결과 저장)
CREATE TABLE IF NOT EXISTS keyword_origins (
  id SERIAL PRIMARY KEY,
  keyword TEXT NOT NULL UNIQUE,
  first_podcast_date DATE,
  first_podcast_influencer TEXT,
  first_podcast_name TEXT,
  first_podcast_episode_title TEXT,
  first_podcast_quote TEXT,
  first_podcast_timestamp_seconds INTEGER,
  market_creator_date DATE,
  market_creator_influencer TEXT,
  market_creator_podcast_name TEXT,
  market_creator_episode_title TEXT,
  market_creator_quote TEXT,
  market_creator_ig_growth REAL,
  market_creator_google_growth REAL,
  mention_timeline JSONB,
  spread_pattern JSONB,
  golden_time_start DATE,
  golden_time_end DATE,
  golden_time_duration_days INTEGER,
  avg_golden_time_days INTEGER,
  analysis_report TEXT,
  analyzed_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE keyword_origins ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_origins FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON keyword_origins FOR ALL USING (true) WITH CHECK (true);
