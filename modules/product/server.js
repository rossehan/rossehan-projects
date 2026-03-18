// [TrendRadar] Dashboard Server
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3002;

// Supabase 연결 (없으면 데모 모드)
let supabase = null;
let isLive = false;

if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  isLive = true;
  console.log('[TrendRadar] Supabase 연결됨 — LIVE 모드');
} else {
  console.log('[TrendRadar] Supabase 미설정 — DEMO 모드');
}

// ── 데모 데이터 ──────────────────────────────────────────
const DEMO_OPPORTUNITY_SCORES = [
  { keyword: 'shilajit', opportunity_score: 92, verdict: '🟢 지금 진입', score_breakdown: { podcast: 28, instagram: 23, google: 22, facebook: 19 }, strategy_comment: 'Huberman 최근 언급 후 검색량 급증. 경쟁사 아직 적음. 즉시 진입 권장.', podcast_mention_date: '2026-03-10', instagram_weekly_growth: 34.5, google_growth_rate: 67.2, facebook_advertiser_count: 8, snapshot_date: '2026-03-17' },
  { keyword: 'tongkat ali', opportunity_score: 85, verdict: '🟢 지금 진입', score_breakdown: { podcast: 25, instagram: 20, google: 22, facebook: 18 }, strategy_comment: 'Attia 팟캐스트에서 테스토스테론 관련 언급. Instagram 해시태그 주간 28% 성장.', podcast_mention_date: '2026-03-05', instagram_weekly_growth: 28.1, google_growth_rate: 45.3, facebook_advertiser_count: 12, snapshot_date: '2026-03-17' },
  { keyword: 'nmn', opportunity_score: 78, verdict: '🟡 6개월 내 검토', score_breakdown: { podcast: 22, instagram: 18, google: 20, facebook: 18 }, strategy_comment: 'Sinclair 꾸준히 언급 중이나 경쟁 심화. 차별화 전략 필요.', podcast_mention_date: '2026-02-28', instagram_weekly_growth: 15.2, google_growth_rate: 22.8, facebook_advertiser_count: 35, snapshot_date: '2026-03-17' },
  { keyword: 'urolithin a', opportunity_score: 88, verdict: '🟢 지금 진입', score_breakdown: { podcast: 27, instagram: 22, google: 21, facebook: 18 }, strategy_comment: 'Huberman & Attia 동시 언급. 미토콘드리아 건강 키워드 급성장. 골든타임 진행 중.', podcast_mention_date: '2026-03-12', instagram_weekly_growth: 41.3, google_growth_rate: 78.9, facebook_advertiser_count: 5, snapshot_date: '2026-03-17' },
  { keyword: 'spermidine', opportunity_score: 82, verdict: '🟢 지금 진입', score_breakdown: { podcast: 24, instagram: 21, google: 19, facebook: 18 }, strategy_comment: 'Sinclair 오토파지 관련 강력 추천. 검색 성장률 높고 광고주 아직 적음.', podcast_mention_date: '2026-03-08', instagram_weekly_growth: 25.7, google_growth_rate: 52.1, facebook_advertiser_count: 9, snapshot_date: '2026-03-17' },
  { keyword: 'apigenin', opportunity_score: 74, verdict: '🟡 6개월 내 검토', score_breakdown: { podcast: 20, instagram: 19, google: 18, facebook: 17 }, strategy_comment: 'Huberman 수면 프로토콜에서 언급. 이미 일부 경쟁 존재하나 성장 여지 있음.', podcast_mention_date: '2026-02-20', instagram_weekly_growth: 12.4, google_growth_rate: 18.5, facebook_advertiser_count: 22, snapshot_date: '2026-03-17' },
  { keyword: 'berberine', opportunity_score: 55, verdict: '🔴 포화 시장', score_breakdown: { podcast: 15, instagram: 12, google: 14, facebook: 14 }, strategy_comment: 'GLP-1 대안으로 이미 대중화. 경쟁 매우 치열. 차별화 어려움.', podcast_mention_date: '2025-12-15', instagram_weekly_growth: 3.1, google_growth_rate: -5.2, facebook_advertiser_count: 89, snapshot_date: '2026-03-17' },
  { keyword: 'turkesterone', opportunity_score: 48, verdict: '🔴 포화 시장', score_breakdown: { podcast: 10, instagram: 11, google: 12, facebook: 15 }, strategy_comment: '한때 유행했으나 관심 감소 중. 신규 진입 비추천.', podcast_mention_date: '2025-10-01', instagram_weekly_growth: -2.3, google_growth_rate: -15.8, facebook_advertiser_count: 67, snapshot_date: '2026-03-17' },
  { keyword: 'sea moss', opportunity_score: 63, verdict: '🟡 6개월 내 검토', score_breakdown: { podcast: 16, instagram: 17, google: 15, facebook: 15 }, strategy_comment: '소셜미디어 주도 트렌드. 팟캐스트 언급 적으나 꾸준한 수요.', podcast_mention_date: '2026-01-10', instagram_weekly_growth: 8.7, google_growth_rate: 10.2, facebook_advertiser_count: 45, snapshot_date: '2026-03-17' },
  { keyword: 'fadogia agrestis', opportunity_score: 71, verdict: '🟡 6개월 내 검토', score_breakdown: { podcast: 22, instagram: 16, google: 17, facebook: 16 }, strategy_comment: 'Huberman 초기 추천 효과 지속. 안전성 논란으로 성장 둔화.', podcast_mention_date: '2026-01-25', instagram_weekly_growth: 9.8, google_growth_rate: 14.3, facebook_advertiser_count: 28, snapshot_date: '2026-03-17' },
];

const DEMO_KEYWORD_ORIGINS = [
  { keyword: 'shilajit', first_podcast_date: '2026-02-15', first_podcast_influencer: 'huberman', first_podcast_episode_title: 'Optimizing Testosterone & Vitality', first_podcast_quote: 'Shilajit has shown remarkable effects on mitochondrial function...', market_creator_influencer: 'huberman', market_creator_ig_growth: 156.3, golden_time_start: '2026-02-15', golden_time_end: null, golden_time_duration_days: null, analysis_report: '골든타임 진행 중. Huberman 언급 후 30일 경과, 아직 대형 광고주 미진입.' },
  { keyword: 'urolithin a', first_podcast_date: '2026-02-20', first_podcast_influencer: 'attia', first_podcast_episode_title: 'Mitochondrial Health & Longevity', first_podcast_quote: 'Urolithin A is one of the most promising mitophagy activators...', market_creator_influencer: 'attia', market_creator_ig_growth: 203.7, golden_time_start: '2026-02-20', golden_time_end: null, golden_time_duration_days: null, analysis_report: '골든타임 진행 중. Attia + Huberman 동시 추천으로 강력한 시그널.' },
  { keyword: 'tongkat ali', first_podcast_date: '2025-11-10', first_podcast_influencer: 'huberman', first_podcast_episode_title: 'Hormones & Supplements', first_podcast_quote: 'Tongkat ali at 400mg daily has solid evidence for free testosterone...', market_creator_influencer: 'huberman', market_creator_ig_growth: 89.2, golden_time_start: '2025-11-10', golden_time_end: '2026-01-15', golden_time_duration_days: 66, analysis_report: '골든타임 종료. 66일간 진행 후 대형 광고주 진입.' },
  { keyword: 'spermidine', first_podcast_date: '2026-01-20', first_podcast_influencer: 'sinclair', first_podcast_episode_title: 'Autophagy & Cellular Renewal', first_podcast_quote: 'Spermidine activates autophagy pathways similar to fasting...', market_creator_influencer: 'sinclair', market_creator_ig_growth: 134.5, golden_time_start: '2026-01-20', golden_time_end: null, golden_time_duration_days: null, analysis_report: '골든타임 진행 중. Sinclair 추천 후 검색량 지속 증가.' },
];

const DEMO_PODCAST_KEYWORDS = [
  { influencer: 'huberman', keyword: 'shilajit', mentioned_date: '2026-03-10', episode_title: 'Optimizing Testosterone & Vitality — New Protocols', mention_context: 'benefit_explanation', mention_quote: 'Shilajit at 250mg twice daily showed significant improvements in CoQ10 and mitochondrial output.' },
  { influencer: 'huberman', keyword: 'urolithin a', mentioned_date: '2026-03-12', episode_title: 'Mitochondria, Aging & Supplements', mention_context: 'benefit_explanation', mention_quote: 'Urolithin A triggers mitophagy — the selective removal of damaged mitochondria.' },
  { influencer: 'attia', keyword: 'urolithin a', mentioned_date: '2026-03-12', episode_title: '#298 — Longevity Toolkit Update', mention_context: 'personal_use', mention_quote: 'I have been taking Urolithin A for 6 months now and my muscle endurance markers improved.' },
  { influencer: 'attia', keyword: 'tongkat ali', mentioned_date: '2026-03-05', episode_title: '#295 — Testosterone Optimization', mention_context: 'benefit_explanation', mention_quote: 'The data on tongkat ali is actually quite compelling for free testosterone.' },
  { influencer: 'sinclair', keyword: 'spermidine', mentioned_date: '2026-03-08', episode_title: 'Reversing Aging — Latest Research', mention_context: 'benefit_explanation', mention_quote: 'Spermidine is fascinating because it mimics the autophagy benefits of caloric restriction.' },
  { influencer: 'sinclair', keyword: 'nmn', mentioned_date: '2026-02-28', episode_title: 'NAD+ Pathways & Anti-Aging', mention_context: 'personal_use', mention_quote: 'I continue to take NMN daily as part of my longevity protocol.' },
  { influencer: 'huberman', keyword: 'apigenin', mentioned_date: '2026-02-20', episode_title: 'Sleep Toolkit — 2026 Update', mention_context: 'personal_use', mention_quote: 'Apigenin at 50mg before bed has been part of my sleep stack for over two years now.' },
  { influencer: 'brecka', keyword: 'sea moss', mentioned_date: '2026-01-10', episode_title: 'Mineral Deficiency & Modern Diet', mention_context: 'benefit_explanation', mention_quote: 'Sea moss contains 92 of the 102 essential minerals your body needs.' },
];

const DEMO_GOOGLE_TRENDS = [
  { keyword: 'shilajit', current_3m_avg: 78, prev_3m_avg: 42, growth_rate: 85.7, trend_direction: 'rising', snapshot_date: '2026-03-17' },
  { keyword: 'urolithin a', current_3m_avg: 65, prev_3m_avg: 31, growth_rate: 109.7, trend_direction: 'rising', snapshot_date: '2026-03-17' },
  { keyword: 'tongkat ali', current_3m_avg: 72, prev_3m_avg: 48, growth_rate: 50.0, trend_direction: 'rising', snapshot_date: '2026-03-17' },
  { keyword: 'spermidine', current_3m_avg: 45, prev_3m_avg: 28, growth_rate: 60.7, trend_direction: 'rising', snapshot_date: '2026-03-17' },
  { keyword: 'nmn', current_3m_avg: 68, prev_3m_avg: 55, growth_rate: 23.6, trend_direction: 'rising', snapshot_date: '2026-03-17' },
  { keyword: 'berberine', current_3m_avg: 52, prev_3m_avg: 58, growth_rate: -10.3, trend_direction: 'falling', snapshot_date: '2026-03-17' },
  { keyword: 'turkesterone', current_3m_avg: 25, prev_3m_avg: 38, growth_rate: -34.2, trend_direction: 'falling', snapshot_date: '2026-03-17' },
  { keyword: 'apigenin', current_3m_avg: 35, prev_3m_avg: 28, growth_rate: 25.0, trend_direction: 'rising', snapshot_date: '2026-03-17' },
  { keyword: 'sea moss', current_3m_avg: 58, prev_3m_avg: 52, growth_rate: 11.5, trend_direction: 'stable', snapshot_date: '2026-03-17' },
  { keyword: 'fadogia agrestis', current_3m_avg: 30, prev_3m_avg: 25, growth_rate: 20.0, trend_direction: 'rising', snapshot_date: '2026-03-17' },
];

// ── API 엔드포인트 ──────────────────────────────────────

// 대시보드 서빙
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'dashboard.html'));
});

// 상태 확인
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mode: isLive ? 'live' : 'demo', timestamp: new Date().toISOString() });
});

// Opportunity Scores
app.get('/api/opportunities', async (req, res) => {
  if (isLive) {
    try {
      const { data, error } = await supabase
        .from('opportunity_scores')
        .select('*')
        .order('opportunity_score', { ascending: false })
        .limit(50);
      if (error) {
        console.error('[API] opportunities Supabase error:', error.message);
      } else if (data && data.length > 0) {
        return res.json(data);
      } else {
        console.log('[API] opportunities: Supabase 비어있음 → 데모 데이터 사용');
      }
    } catch (err) {
      console.error('[API] opportunities catch error:', err.message);
    }
  }
  return res.json(DEMO_OPPORTUNITY_SCORES);
});

// Keyword Origins (골든타임)
app.get('/api/origins', async (req, res) => {
  if (isLive) {
    try {
      const { data, error } = await supabase
        .from('keyword_origins')
        .select('*')
        .order('analyzed_at', { ascending: false })
        .limit(30);
      if (error) {
        console.error('[API] origins Supabase error:', error.message);
      } else if (data && data.length > 0) {
        return res.json(data);
      }
    } catch (err) {
      console.error('[API] origins catch error:', err.message);
    }
  }
  return res.json(DEMO_KEYWORD_ORIGINS);
});

// Podcast Keywords
app.get('/api/podcasts', async (req, res) => {
  if (isLive) {
    try {
      const { data, error } = await supabase
        .from('podcast_keywords')
        .select('*')
        .order('mentioned_date', { ascending: false })
        .limit(100);
      if (error) {
        console.error('[API] podcasts Supabase error:', error.message);
      } else if (data && data.length > 0) {
        return res.json(data);
      }
    } catch (err) {
      console.error('[API] podcasts catch error:', err.message);
    }
  }
  return res.json(DEMO_PODCAST_KEYWORDS);
});

// Google Trends
app.get('/api/trends', async (req, res) => {
  if (isLive) {
    try {
      const { data, error } = await supabase
        .from('google_trends_snapshots')
        .select('*')
        .order('snapshot_date', { ascending: false })
        .limit(50);
      if (error) {
        console.error('[API] trends Supabase error:', error.message);
      } else if (data && data.length > 0) {
        return res.json(data);
      }
    } catch (err) {
      console.error('[API] trends catch error:', err.message);
    }
  }
  return res.json(DEMO_GOOGLE_TRENDS);
});

// Facebook Ads
app.get('/api/ads', async (req, res) => {
  if (isLive) {
    try {
      const { data, error } = await supabase
        .from('facebook_ads_snapshots')
        .select('*')
        .order('snapshot_date', { ascending: false })
        .limit(50);
      if (error) {
        console.error('[API] ads Supabase error:', error.message);
      } else if (data && data.length > 0) {
        return res.json(data);
      }
    } catch (err) {
      console.error('[API] ads catch error:', err.message);
    }
  }
  return res.json([]);
});

// ── 에이전트 기능 (LIVE 모드 전용) ─────────────────────

// 스캔 상태 추적
let scanStatus = { running: false, step: '', progress: [], startedAt: null, completedAt: null, result: null, error: null };

// DB 테이블 자동 생성
app.post('/api/setup-db', async (req, res) => {
  if (!isLive) return res.status(400).json({ error: 'LIVE 모드에서만 사용 가능' });

  const tables = [
    `CREATE TABLE IF NOT EXISTS podcast_keywords (
      id SERIAL PRIMARY KEY, influencer TEXT NOT NULL, keyword TEXT NOT NULL,
      mentioned_date DATE NOT NULL, episode_title TEXT, episode_url TEXT, episode_id TEXT,
      mention_timestamp_seconds INTEGER, mention_context TEXT, mention_quote TEXT,
      created_at TIMESTAMP DEFAULT NOW(), UNIQUE(influencer, keyword, mentioned_date)
    )`,
    `CREATE TABLE IF NOT EXISTS instagram_snapshots (
      id SERIAL PRIMARY KEY, keyword TEXT NOT NULL, hashtag TEXT NOT NULL,
      post_count INTEGER, recent_post_count INTEGER, snapshot_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(), UNIQUE(keyword, snapshot_date)
    )`,
    `CREATE TABLE IF NOT EXISTS facebook_ads_snapshots (
      id SERIAL PRIMARY KEY, keyword TEXT NOT NULL, total_ads INTEGER,
      unique_advertisers INTEGER, new_advertisers_this_week INTEGER,
      oldest_ad_date DATE, newest_ad_date DATE, competition_level TEXT,
      snapshot_date DATE NOT NULL, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(keyword, snapshot_date)
    )`,
    `CREATE TABLE IF NOT EXISTS google_trends_snapshots (
      id SERIAL PRIMARY KEY, keyword TEXT NOT NULL, current_3m_avg REAL, prev_3m_avg REAL,
      growth_rate REAL, trend_direction TEXT, snapshot_date DATE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(), UNIQUE(keyword, snapshot_date)
    )`,
    `CREATE TABLE IF NOT EXISTS opportunity_scores (
      id SERIAL PRIMARY KEY, keyword TEXT NOT NULL, opportunity_score REAL, verdict TEXT,
      score_breakdown JSONB, strategy_comment TEXT, podcast_mention_date DATE,
      instagram_weekly_growth REAL, google_growth_rate REAL, facebook_advertiser_count INTEGER,
      snapshot_date DATE NOT NULL, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(keyword, snapshot_date)
    )`,
    `CREATE TABLE IF NOT EXISTS keyword_origins (
      id SERIAL PRIMARY KEY, keyword TEXT NOT NULL UNIQUE,
      first_podcast_date DATE, first_podcast_influencer TEXT, first_podcast_name TEXT,
      first_podcast_episode_title TEXT, first_podcast_quote TEXT, first_podcast_timestamp_seconds INTEGER,
      market_creator_date DATE, market_creator_influencer TEXT, market_creator_podcast_name TEXT,
      market_creator_episode_title TEXT, market_creator_quote TEXT,
      market_creator_ig_growth REAL, market_creator_google_growth REAL,
      mention_timeline JSONB, spread_pattern JSONB,
      golden_time_start DATE, golden_time_end DATE, golden_time_duration_days INTEGER,
      avg_golden_time_days INTEGER, analysis_report TEXT,
      analyzed_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    )`,
  ];

  const results = [];
  for (const sql of tables) {
    try {
      const { error } = await supabase.rpc('exec_sql', { sql_query: sql }).catch(() => ({ error: null }));
      // rpc가 없으면 직접 REST로 테이블 존재 확인
      const tableName = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
      const { error: checkError } = await supabase.from(tableName).select('id').limit(1);
      results.push({ table: tableName, status: checkError ? 'needs_manual_creation' : 'ok' });
    } catch (err) {
      results.push({ table: 'unknown', status: 'error', message: err.message });
    }
  }

  res.json({ results, message: '테이블 상태 확인 완료. needs_manual_creation인 테이블은 Supabase SQL Editor에서 schema.sql을 실행해주세요.' });
});

// Taddy UUID 자동 검색
app.post('/api/resolve-uuids', async (req, res) => {
  if (!process.env.TADDY_API_KEY) {
    return res.status(400).json({ error: 'TADDY_API_KEY 미설정' });
  }

  try {
    const TADDY_GRAPHQL_URL = 'https://api.taddy.org';
    const influencers = {
      huberman: 'Huberman Lab',
      sinclair: 'Lifespan David Sinclair',
      attia: 'The Drive Peter Attia',
      brecka: 'Ultimate Human Gary Brecka',
      hyman: 'The Doctor\'s Farmacy Mark Hyman',
      patrick: 'FoundMyFitness Rhonda Patrick',
    };

    const results = {};
    for (const [key, searchName] of Object.entries(influencers)) {
      try {
        const query = `{ search(term: "${searchName}", filterForTypes: PODCASTSERIES, limitPerPage: 3) { podcastSeries { uuid name description } } }`;
        const response = await fetch(TADDY_GRAPHQL_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': process.env.TADDY_API_KEY,
            'X-USER-ID': process.env.TADDY_USER_ID || '',
          },
          body: JSON.stringify({ query }),
        });
        const data = await response.json();
        const podcasts = data?.data?.search?.podcastSeries ?? [];
        results[key] = podcasts.map(p => ({ uuid: p.uuid, name: p.name }));
      } catch (err) {
        results[key] = { error: err.message };
      }
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Google Trends 단일 키워드 조회 (실시간)
app.get('/api/trends-live/:keyword', async (req, res) => {
  try {
    const googleTrends = await import('google-trends-api');
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const result = await googleTrends.default.interestOverTime({
      keyword: req.params.keyword,
      startTime: sixMonthsAgo,
      geo: 'US',
    });
    const data = JSON.parse(result);

    // 3개월 성장률 계산
    const timeline = data?.default?.timelineData ?? [];
    const midIdx = Math.floor(timeline.length / 2);
    const recent = timeline.slice(midIdx);
    const prev = timeline.slice(0, midIdx);
    const recentAvg = recent.length > 0 ? recent.reduce((s, d) => s + (d.value?.[0] ?? 0), 0) / recent.length : 0;
    const prevAvg = prev.length > 0 ? prev.reduce((s, d) => s + (d.value?.[0] ?? 0), 0) / prev.length : 0;
    const growthRate = prevAvg > 0 ? ((recentAvg - prevAvg) / prevAvg * 100) : 0;

    res.json({
      keyword: req.params.keyword,
      current_3m_avg: Math.round(recentAvg * 100) / 100,
      prev_3m_avg: Math.round(prevAvg * 100) / 100,
      growth_rate: Math.round(growthRate * 100) / 100,
      trend_direction: growthRate > 10 ? 'rising' : growthRate < -10 ? 'falling' : 'stable',
      timeline: timeline.map(d => ({ date: d.formattedTime, value: d.value?.[0] ?? 0 })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 전체 스캔 실행 (수동 트리거)
app.post('/api/scan', async (req, res) => {
  if (scanStatus.running) {
    return res.status(409).json({ error: '스캔이 이미 진행 중입니다', status: scanStatus });
  }

  if (!isLive) {
    return res.status(400).json({ error: 'LIVE 모드에서만 스캔 가능 (SUPABASE 연결 필요)' });
  }

  // 필요한 API 키 확인
  const missingKeys = [];
  if (!process.env.TADDY_API_KEY) missingKeys.push('TADDY_API_KEY');
  if (!process.env.ANTHROPIC_API_KEY) missingKeys.push('ANTHROPIC_API_KEY');
  if (missingKeys.length > 0) {
    return res.status(400).json({ error: `필수 API 키 누락: ${missingKeys.join(', ')}` });
  }

  const { influencers = ['huberman', 'sinclair', 'attia', 'brecka'], days_back = 30 } = req.body || {};

  scanStatus = { running: true, step: '초기화', progress: [], startedAt: new Date().toISOString(), completedAt: null, result: null, error: null };

  // 비동기로 스캔 실행 (응답은 즉시 반환)
  res.json({ message: '스캔 시작됨', status: scanStatus });

  // 백그라운드에서 스캔 실행
  (async () => {
    try {
      // Dynamic import for ESM TypeScript modules
      const { runFullScan } = await import('./src/capabilities/run-full-scan.js');

      const ctx = {
        supabase,
        reportProgress: (msg) => {
          scanStatus.step = msg;
          scanStatus.progress.push({ time: new Date().toISOString(), message: msg });
          console.log(msg);
        },
      };

      const reportEvent = async (event) => {
        console.log(`[TrendRadar] 이벤트: [${event.urgency}] ${event.event_type} — ${event.summary}`);
        try {
          await supabase.from('agent_events').insert({
            agent_id: 'trendradar-agent',
            module: 'product',
            event_type: event.event_type,
            summary: event.summary,
            metrics: event.metrics,
            urgency: event.urgency,
            created_at: new Date().toISOString(),
          });
        } catch (err) {
          // agent_events 테이블 없으면 무시
        }
      };

      scanStatus.step = '전체 스캔 실행 중';
      const result = await runFullScan({ influencers, days_back }, ctx, reportEvent);

      scanStatus.running = false;
      scanStatus.completedAt = new Date().toISOString();
      scanStatus.result = result;
      scanStatus.step = '완료';
      console.log('[TrendRadar] 수동 스캔 완료:', JSON.stringify(result));
    } catch (err) {
      scanStatus.running = false;
      scanStatus.completedAt = new Date().toISOString();
      scanStatus.error = err.message;
      scanStatus.step = '실패';
      console.error('[TrendRadar] 수동 스캔 실패:', err.message);
    }
  })();
});

// 스캔 상태 확인
app.get('/api/scan/status', (req, res) => {
  res.json(scanStatus);
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`[TrendRadar] 대시보드: http://localhost:${PORT}`);
  console.log(`[TrendRadar] 모드: ${isLive ? 'LIVE (Supabase)' : 'DEMO'}`);
});
