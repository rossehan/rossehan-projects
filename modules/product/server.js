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

// ── 데모 데이터 (6개월 히스토리컬) ─────────────────────

// 날짜 헬퍼
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; }
function weeksAgo(n) { return daysAgo(n * 7); }

// 키워드별 히스토리컬 시뮬레이션 데이터
const KEYWORD_PROFILES = {
  shilajit:          { baseScore: 35, peakScore: 92, podcastDate: '2026-02-15', peakDate: '2026-03-10', igBase: 1200, igGrowthRate: 0.08, googleBase: 28, googlePeak: 78, fbAds: [2,3,3,5,6,8], influencer: 'huberman' },
  'urolithin a':     { baseScore: 20, peakScore: 88, podcastDate: '2026-02-20', peakDate: '2026-03-12', igBase: 400, igGrowthRate: 0.12, googleBase: 12, googlePeak: 65, fbAds: [0,1,1,2,3,5], influencer: 'attia' },
  'tongkat ali':     { baseScore: 45, peakScore: 85, podcastDate: '2025-11-10', peakDate: '2026-01-10', igBase: 3500, igGrowthRate: 0.06, googleBase: 35, googlePeak: 72, fbAds: [5,7,8,9,10,12], influencer: 'huberman' },
  spermidine:        { baseScore: 25, peakScore: 82, podcastDate: '2026-01-20', peakDate: '2026-03-08', igBase: 800, igGrowthRate: 0.07, googleBase: 18, googlePeak: 45, fbAds: [1,2,3,4,6,9], influencer: 'sinclair' },
  nmn:               { baseScore: 60, peakScore: 78, podcastDate: '2025-10-15', peakDate: '2025-12-01', igBase: 8000, igGrowthRate: 0.03, googleBase: 48, googlePeak: 68, fbAds: [22,25,28,30,33,35], influencer: 'sinclair' },
  apigenin:          { baseScore: 40, peakScore: 74, podcastDate: '2025-12-10', peakDate: '2026-02-20', igBase: 2200, igGrowthRate: 0.04, googleBase: 22, googlePeak: 35, fbAds: [10,12,14,16,19,22], influencer: 'huberman' },
  berberine:         { baseScore: 72, peakScore: 55, podcastDate: '2025-06-01', peakDate: '2025-09-01', igBase: 15000, igGrowthRate: 0.01, googleBase: 62, googlePeak: 52, fbAds: [55,62,68,75,82,89], influencer: 'attia' },
  turkesterone:      { baseScore: 65, peakScore: 48, podcastDate: '2025-04-01', peakDate: '2025-07-01', igBase: 9500, igGrowthRate: -0.01, googleBase: 45, googlePeak: 25, fbAds: [45,50,55,58,62,67], influencer: 'huberman' },
  'sea moss':        { baseScore: 50, peakScore: 63, podcastDate: '2025-11-20', peakDate: '2026-01-10', igBase: 12000, igGrowthRate: 0.02, googleBase: 48, googlePeak: 58, fbAds: [30,33,36,38,42,45], influencer: 'brecka' },
  'fadogia agrestis':{ baseScore: 55, peakScore: 71, podcastDate: '2025-10-05', peakDate: '2026-01-25', igBase: 1800, igGrowthRate: 0.03, googleBase: 20, googlePeak: 30, fbAds: [15,18,20,22,25,28], influencer: 'huberman' },
  'taurine':         { baseScore: 30, peakScore: 68, podcastDate: '2026-01-05', peakDate: '2026-02-15', igBase: 5500, igGrowthRate: 0.05, googleBase: 30, googlePeak: 48, fbAds: [8,10,12,14,16,18], influencer: 'sinclair' },
  'creatine':        { baseScore: 70, peakScore: 65, podcastDate: '2025-09-01', peakDate: '2025-11-01', igBase: 25000, igGrowthRate: 0.01, googleBase: 72, googlePeak: 75, fbAds: [80,82,85,88,90,92], influencer: 'attia' },
  'glutathione':     { baseScore: 35, peakScore: 72, podcastDate: '2026-02-01', peakDate: '2026-03-05', igBase: 3200, igGrowthRate: 0.06, googleBase: 25, googlePeak: 42, fbAds: [5,6,8,10,12,15], influencer: 'hyman' },
  'sulforaphane':    { baseScore: 28, peakScore: 76, podcastDate: '2026-01-15', peakDate: '2026-03-01', igBase: 1600, igGrowthRate: 0.09, googleBase: 15, googlePeak: 38, fbAds: [3,4,5,7,9,11], influencer: 'patrick' },
  'nac':             { baseScore: 45, peakScore: 70, podcastDate: '2025-11-01', peakDate: '2026-01-15', igBase: 4200, igGrowthRate: 0.03, googleBase: 32, googlePeak: 44, fbAds: [18,20,22,24,26,28], influencer: 'hyman' },
};

// 6개월 주간 히스토리컬 기회 점수 생성
function generateHistoricalOpportunityScores() {
  const scores = [];
  const weeks = 26; // 6개월
  for (const [keyword, profile] of Object.entries(KEYWORD_PROFILES)) {
    for (let w = weeks; w >= 0; w--) {
      const date = weeksAgo(w);
      const daysSincePodcast = (new Date(date) - new Date(profile.podcastDate)) / 86400000;
      let score;
      if (daysSincePodcast < 0) {
        score = profile.baseScore + Math.random() * 5 - 2.5;
      } else if (daysSincePodcast < 14) {
        const ramp = daysSincePodcast / 14;
        score = profile.baseScore + (profile.peakScore - profile.baseScore) * ramp * 0.6;
      } else if (daysSincePodcast < 60) {
        score = profile.peakScore - (daysSincePodcast - 14) * 0.1;
      } else {
        score = Math.max(profile.peakScore - (daysSincePodcast - 14) * 0.2, profile.baseScore);
      }
      score = Math.round(Math.max(10, Math.min(100, score + (Math.random() * 6 - 3))));
      const verdict = score >= 80 ? '🟢 지금 진입' : score >= 60 ? '🟡 6개월 내 검토' : '🔴 포화 시장';
      const igWeekIdx = Math.min(Math.floor((weeks - w) / 4), 5);
      scores.push({
        keyword, opportunity_score: score, verdict,
        score_breakdown: { podcast_recency: Math.min(30, Math.max(0, 30 - Math.floor(Math.max(0, daysSincePodcast) / 3))), instagram_growth: Math.floor(score * 0.25), google_trends_growth: Math.floor(score * 0.22), facebook_competition_inverse: Math.max(0, 20 - profile.fbAds[igWeekIdx]) },
        strategy_comment: '',
        podcast_mention_date: daysSincePodcast >= 0 ? profile.podcastDate : null,
        instagram_weekly_growth: daysSincePodcast > 0 ? Math.round((profile.igGrowthRate * 100 * (1 + daysSincePodcast / 60)) * 10) / 10 : Math.round((Math.random() * 4 - 1) * 10) / 10,
        google_growth_rate: daysSincePodcast > 0 ? Math.round(((profile.googlePeak - profile.googleBase) / profile.googleBase * 100) * (1 - w / weeks) * 10) / 10 : Math.round((Math.random() * 10 - 5) * 10) / 10,
        facebook_advertiser_count: profile.fbAds[igWeekIdx],
        snapshot_date: date,
      });
    }
  }
  return scores;
}

// 6개월 주간 히스토리컬 Google Trends 스냅샷 생성
function generateHistoricalGoogleTrends() {
  const snapshots = [];
  const weeks = 26;
  for (const [keyword, profile] of Object.entries(KEYWORD_PROFILES)) {
    for (let w = weeks; w >= 0; w--) {
      const date = weeksAgo(w);
      const progress = 1 - w / weeks;
      const daysSincePodcast = (new Date(date) - new Date(profile.podcastDate)) / 86400000;
      let currentAvg;
      if (daysSincePodcast < 0) {
        currentAvg = profile.googleBase + Math.random() * 5 - 2.5;
      } else {
        const ramp = Math.min(1, daysSincePodcast / 90);
        currentAvg = profile.googleBase + (profile.googlePeak - profile.googleBase) * ramp;
      }
      currentAvg = Math.round(Math.max(5, currentAvg + Math.random() * 6 - 3));
      const prevAvg = Math.round(Math.max(5, currentAvg * (0.7 + Math.random() * 0.2)));
      const growthRate = prevAvg > 0 ? Math.round(((currentAvg - prevAvg) / prevAvg * 100) * 10) / 10 : 0;
      const direction = growthRate > 10 ? 'rising' : growthRate < -10 ? 'falling' : 'stable';
      snapshots.push({ keyword, current_3m_avg: currentAvg, prev_3m_avg: prevAvg, growth_rate: growthRate, trend_direction: direction, snapshot_date: date });
    }
  }
  return snapshots;
}

// 6개월 히스토리컬 Instagram 스냅샷 생성
function generateHistoricalInstagramSnapshots() {
  const snapshots = [];
  const weeks = 26;
  for (const [keyword, profile] of Object.entries(KEYWORD_PROFILES)) {
    let postCount = profile.igBase;
    for (let w = weeks; w >= 0; w--) {
      const date = weeksAgo(w);
      const daysSincePodcast = (new Date(date) - new Date(profile.podcastDate)) / 86400000;
      let growth = profile.igGrowthRate * 0.3; // 베이스 성장
      if (daysSincePodcast > 0 && daysSincePodcast < 90) {
        growth = profile.igGrowthRate * (1 + daysSincePodcast / 30); // 팟캐스트 후 가속
      }
      postCount = Math.round(postCount * (1 + growth) + Math.random() * 50 - 25);
      const recentCount = Math.round(postCount * 0.15 + Math.random() * 20);
      snapshots.push({
        keyword, hashtag: `#${keyword.replace(/\s/g, '')}`, post_count: postCount, recent_post_count: recentCount, snapshot_date: date,
      });
    }
  }
  return snapshots;
}

// 6개월 히스토리컬 Facebook Ads 스냅샷 생성
function generateHistoricalFacebookAdsSnapshots() {
  const snapshots = [];
  const weeks = 26;
  for (const [keyword, profile] of Object.entries(KEYWORD_PROFILES)) {
    for (let w = weeks; w >= 0; w--) {
      const date = weeksAgo(w);
      const monthIdx = Math.min(Math.floor((weeks - w) / 4), 5);
      const advertisers = profile.fbAds[monthIdx] + Math.floor(Math.random() * 3 - 1);
      const totalAds = advertisers * (3 + Math.floor(Math.random() * 5));
      const newThisWeek = Math.max(0, Math.floor(Math.random() * 3));
      const level = totalAds < 15 ? 'low' : totalAds < 60 ? 'medium' : 'high';
      snapshots.push({
        keyword, total_ads: totalAds, unique_advertisers: Math.max(1, advertisers), new_advertisers_this_week: newThisWeek,
        oldest_ad_date: daysAgo(180), newest_ad_date: date, competition_level: level, snapshot_date: date,
      });
    }
  }
  return snapshots;
}

// 히스토리컬 팟캐스트 키워드 (다양한 시점)
const DEMO_PODCAST_KEYWORDS = [
  // ── 2026-03 (최신) ──
  { influencer: 'huberman', keyword: 'shilajit', mentioned_date: '2026-03-10', episode_title: 'Optimizing Testosterone & Vitality — New Protocols', mention_context: 'benefit_explanation', mention_quote: 'Shilajit at 250mg twice daily showed significant improvements in CoQ10 and mitochondrial output.' },
  { influencer: 'huberman', keyword: 'urolithin a', mentioned_date: '2026-03-12', episode_title: 'Mitochondria, Aging & Supplements', mention_context: 'benefit_explanation', mention_quote: 'Urolithin A triggers mitophagy — the selective removal of damaged mitochondria.' },
  { influencer: 'attia', keyword: 'urolithin a', mentioned_date: '2026-03-12', episode_title: '#298 — Longevity Toolkit Update', mention_context: 'personal_use', mention_quote: 'I have been taking Urolithin A for 6 months now and my muscle endurance markers improved.' },
  { influencer: 'attia', keyword: 'tongkat ali', mentioned_date: '2026-03-05', episode_title: '#295 — Testosterone Optimization', mention_context: 'benefit_explanation', mention_quote: 'The data on tongkat ali is actually quite compelling for free testosterone.' },
  { influencer: 'sinclair', keyword: 'spermidine', mentioned_date: '2026-03-08', episode_title: 'Reversing Aging — Latest Research', mention_context: 'benefit_explanation', mention_quote: 'Spermidine is fascinating because it mimics the autophagy benefits of caloric restriction.' },
  { influencer: 'patrick', keyword: 'sulforaphane', mentioned_date: '2026-03-01', episode_title: 'Cruciferous Vegetables & NRF2 Pathway', mention_context: 'benefit_explanation', mention_quote: 'Sulforaphane activates NRF2 which upregulates over 200 protective genes.' },
  { influencer: 'hyman', keyword: 'glutathione', mentioned_date: '2026-03-05', episode_title: 'Detox That Actually Works', mention_context: 'personal_use', mention_quote: 'Liposomal glutathione is the single most important antioxidant I recommend to my patients.' },
  // ── 2026-02 ──
  { influencer: 'sinclair', keyword: 'nmn', mentioned_date: '2026-02-28', episode_title: 'NAD+ Pathways & Anti-Aging', mention_context: 'personal_use', mention_quote: 'I continue to take NMN daily as part of my longevity protocol.' },
  { influencer: 'huberman', keyword: 'apigenin', mentioned_date: '2026-02-20', episode_title: 'Sleep Toolkit — 2026 Update', mention_context: 'personal_use', mention_quote: 'Apigenin at 50mg before bed has been part of my sleep stack for over two years now.' },
  { influencer: 'huberman', keyword: 'shilajit', mentioned_date: '2026-02-15', episode_title: 'Testosterone & Male Health', mention_context: 'benefit_explanation', mention_quote: 'Purified shilajit contains fulvic acid and dibenzo-alpha-pyrones that support mitochondrial function.' },
  { influencer: 'attia', keyword: 'urolithin a', mentioned_date: '2026-02-20', episode_title: '#290 — Mitochondrial Health', mention_context: 'benefit_explanation', mention_quote: 'Urolithin A is one of the most promising mitophagy activators we have seen in clinical trials.' },
  { influencer: 'sinclair', keyword: 'taurine', mentioned_date: '2026-02-10', episode_title: 'Taurine & Aging — New Data', mention_context: 'benefit_explanation', mention_quote: 'Taurine supplementation reversed biological age markers in multiple animal studies.' },
  { influencer: 'hyman', keyword: 'glutathione', mentioned_date: '2026-02-01', episode_title: 'The Master Antioxidant', mention_context: 'benefit_explanation', mention_quote: 'Glutathione depletion is at the root of almost every chronic disease I see.' },
  // ── 2026-01 ──
  { influencer: 'sinclair', keyword: 'spermidine', mentioned_date: '2026-01-20', episode_title: 'Autophagy & Cellular Renewal', mention_context: 'benefit_explanation', mention_quote: 'Spermidine activates autophagy pathways similar to fasting.' },
  { influencer: 'brecka', keyword: 'sea moss', mentioned_date: '2026-01-10', episode_title: 'Mineral Deficiency & Modern Diet', mention_context: 'benefit_explanation', mention_quote: 'Sea moss contains 92 of the 102 essential minerals your body needs.' },
  { influencer: 'huberman', keyword: 'fadogia agrestis', mentioned_date: '2026-01-25', episode_title: 'Hormonal Optimization Update', mention_context: 'benefit_explanation', mention_quote: 'Fadogia agrestis at 300-600mg may support luteinizing hormone.' },
  { influencer: 'patrick', keyword: 'sulforaphane', mentioned_date: '2026-01-15', episode_title: 'Broccoli Sprouts — The Evidence', mention_context: 'personal_use', mention_quote: 'I eat broccoli sprouts daily for the sulforaphane content.' },
  { influencer: 'sinclair', keyword: 'taurine', mentioned_date: '2026-01-05', episode_title: 'Longevity Molecule Update', mention_context: 'benefit_explanation', mention_quote: 'The taurine paper in Science was one of the most important findings of 2023 and the data keeps getting stronger.' },
  { influencer: 'hyman', keyword: 'nac', mentioned_date: '2026-01-15', episode_title: 'NAC & Respiratory Health', mention_context: 'benefit_explanation', mention_quote: 'NAC is a precursor to glutathione and one of the most versatile supplements available.' },
  // ── 2025-12 ──
  { influencer: 'huberman', keyword: 'apigenin', mentioned_date: '2025-12-10', episode_title: 'Sleep Protocols Deep Dive', mention_context: 'personal_use', mention_quote: 'I take apigenin, magnesium threonate, and theanine 30 minutes before sleep.' },
  { influencer: 'attia', keyword: 'berberine', mentioned_date: '2025-12-15', episode_title: '#282 — GLP-1 Alternatives', mention_context: 'benefit_explanation', mention_quote: 'Berberine has similar mechanisms to metformin but the evidence is less robust.' },
  { influencer: 'sinclair', keyword: 'nmn', mentioned_date: '2025-12-01', episode_title: 'NAD+ Year in Review', mention_context: 'personal_use', mention_quote: 'My NMN protocol remains 1000mg in the morning, sublingual.' },
  // ── 2025-11 ──
  { influencer: 'huberman', keyword: 'tongkat ali', mentioned_date: '2025-11-10', episode_title: 'Hormones & Supplements', mention_context: 'benefit_explanation', mention_quote: 'Tongkat ali at 400mg daily has solid evidence for free testosterone.' },
  { influencer: 'brecka', keyword: 'sea moss', mentioned_date: '2025-11-20', episode_title: 'Trace Minerals Your Body Craves', mention_context: 'benefit_explanation', mention_quote: 'Irish sea moss is nature\'s multivitamin.' },
  { influencer: 'hyman', keyword: 'nac', mentioned_date: '2025-11-01', episode_title: 'Immune System Reset', mention_context: 'personal_use', mention_quote: 'I take 600mg of NAC twice daily for glutathione support.' },
  // ── 2025-10 ──
  { influencer: 'sinclair', keyword: 'nmn', mentioned_date: '2025-10-15', episode_title: 'Anti-Aging Stack 2025', mention_context: 'personal_use', mention_quote: 'NMN remains the cornerstone of my longevity supplement stack.' },
  { influencer: 'huberman', keyword: 'fadogia agrestis', mentioned_date: '2025-10-05', episode_title: 'Testosterone Toolkit', mention_context: 'benefit_explanation', mention_quote: 'Fadogia plus tongkat ali is a popular stack but be cautious with dosing.' },
  { influencer: 'attia', keyword: 'creatine', mentioned_date: '2025-10-20', episode_title: '#275 — Creatine Beyond Muscle', mention_context: 'benefit_explanation', mention_quote: 'Creatine at 5g daily has cognitive benefits that are often overlooked.' },
  // ── 2025-09 이전 ──
  { influencer: 'attia', keyword: 'creatine', mentioned_date: '2025-09-01', episode_title: '#270 — Exercise & Supplements', mention_context: 'personal_use', mention_quote: 'I take 5g of creatine monohydrate every single day without exception.' },
  { influencer: 'attia', keyword: 'berberine', mentioned_date: '2025-08-15', episode_title: '#265 — Metabolic Health', mention_context: 'benefit_explanation', mention_quote: 'Berberine activates AMPK similar to exercise but I prefer metformin for most patients.' },
];

// 히스토리컬 골든타임 데이터 (더 많은 키워드 포함)
const DEMO_KEYWORD_ORIGINS = [
  { keyword: 'shilajit', first_podcast_date: '2026-02-15', first_podcast_influencer: 'huberman', first_podcast_episode_title: 'Testosterone & Male Health', first_podcast_quote: 'Purified shilajit contains fulvic acid and dibenzo-alpha-pyrones...', market_creator_influencer: 'huberman', market_creator_ig_growth: 156.3, golden_time_start: '2026-02-15', golden_time_end: null, golden_time_duration_days: null, analysis_report: '골든타임 진행 중. Huberman 언급 후 31일 경과, 아직 대형 광고주 미진입. 즉시 진입 권장.' },
  { keyword: 'urolithin a', first_podcast_date: '2026-02-20', first_podcast_influencer: 'attia', first_podcast_episode_title: 'Mitochondrial Health & Longevity', first_podcast_quote: 'Urolithin A is one of the most promising mitophagy activators...', market_creator_influencer: 'attia', market_creator_ig_growth: 203.7, golden_time_start: '2026-02-20', golden_time_end: null, golden_time_duration_days: null, analysis_report: '골든타임 진행 중. Attia + Huberman 동시 추천. 미토콘드리아 건강 카테고리 급성장.' },
  { keyword: 'tongkat ali', first_podcast_date: '2025-11-10', first_podcast_influencer: 'huberman', first_podcast_episode_title: 'Hormones & Supplements', first_podcast_quote: 'Tongkat ali at 400mg daily has solid evidence for free testosterone...', market_creator_influencer: 'huberman', market_creator_ig_growth: 89.2, golden_time_start: '2025-11-10', golden_time_end: '2026-01-15', golden_time_duration_days: 66, analysis_report: '골든타임 종료 (66일). Huberman 추천 후 2개월 내 12개 이상 광고주 진입. 현재 경쟁 중.' },
  { keyword: 'spermidine', first_podcast_date: '2026-01-20', first_podcast_influencer: 'sinclair', first_podcast_episode_title: 'Autophagy & Cellular Renewal', first_podcast_quote: 'Spermidine activates autophagy pathways similar to fasting...', market_creator_influencer: 'sinclair', market_creator_ig_growth: 134.5, golden_time_start: '2026-01-20', golden_time_end: null, golden_time_duration_days: null, analysis_report: '골든타임 진행 중 (57일째). Sinclair 추천 후 검색량 지속 증가. 광고주 아직 9개로 저경쟁.' },
  { keyword: 'sulforaphane', first_podcast_date: '2026-01-15', first_podcast_influencer: 'patrick', first_podcast_episode_title: 'Broccoli Sprouts — The Evidence', first_podcast_quote: 'I eat broccoli sprouts daily for the sulforaphane content.', market_creator_influencer: 'patrick', market_creator_ig_growth: 112.8, golden_time_start: '2026-01-15', golden_time_end: null, golden_time_duration_days: null, analysis_report: '골든타임 진행 중 (62일째). Rhonda Patrick 강력 추천. NRF2 경로 활성화 키워드로 차별화 가능.' },
  { keyword: 'taurine', first_podcast_date: '2026-01-05', first_podcast_influencer: 'sinclair', first_podcast_episode_title: 'Longevity Molecule Update', first_podcast_quote: 'The taurine paper in Science was one of the most important findings...', market_creator_influencer: 'sinclair', market_creator_ig_growth: 78.5, golden_time_start: '2026-01-05', golden_time_end: '2026-03-10', golden_time_duration_days: 64, analysis_report: '골든타임 종료 (64일). Sinclair 추천 후 타우린 시장 급성장. 현재 18개 광고주 진입.' },
  { keyword: 'glutathione', first_podcast_date: '2026-02-01', first_podcast_influencer: 'hyman', first_podcast_episode_title: 'The Master Antioxidant', first_podcast_quote: 'Glutathione depletion is at the root of almost every chronic disease I see.', market_creator_influencer: 'hyman', market_creator_ig_growth: 95.2, golden_time_start: '2026-02-01', golden_time_end: null, golden_time_duration_days: null, analysis_report: '골든타임 진행 중 (45일째). Hyman 추천 후 리포솜 글루타치온 검색량 급증. 경쟁 아직 낮음.' },
  { keyword: 'nmn', first_podcast_date: '2025-10-15', first_podcast_influencer: 'sinclair', first_podcast_episode_title: 'Anti-Aging Stack 2025', first_podcast_quote: 'NMN remains the cornerstone of my longevity supplement stack.', market_creator_influencer: 'sinclair', market_creator_ig_growth: 45.3, golden_time_start: '2025-10-15', golden_time_end: '2025-12-01', golden_time_duration_days: 47, analysis_report: '골든타임 종료 (47일). Sinclair 장기 추천 키워드. 이미 35개 이상 광고주 존재. 차별화 전략 필수.' },
  { keyword: 'berberine', first_podcast_date: '2025-06-01', first_podcast_influencer: 'attia', first_podcast_episode_title: 'Metabolic Health Deep Dive', first_podcast_quote: 'Berberine activates AMPK similar to exercise...', market_creator_influencer: 'attia', market_creator_ig_growth: 22.1, golden_time_start: '2025-06-01', golden_time_end: '2025-08-01', golden_time_duration_days: 61, analysis_report: '골든타임 종료 (61일). GLP-1 대안으로 2025년 초 급성장했으나 현재 89개 광고주로 포화.' },
];

// 최신 스냅샷만 반환 (대시보드 기본)
function getLatestOpportunityScores() {
  const all = generateHistoricalOpportunityScores();
  const latest = new Map();
  for (const s of all) {
    if (!latest.has(s.keyword) || s.snapshot_date > latest.get(s.keyword).snapshot_date) {
      latest.set(s.keyword, s);
    }
  }
  return Array.from(latest.values()).sort((a, b) => b.opportunity_score - a.opportunity_score);
}

function getLatestGoogleTrends() {
  const all = generateHistoricalGoogleTrends();
  const latest = new Map();
  for (const s of all) {
    if (!latest.has(s.keyword) || s.snapshot_date > latest.get(s.keyword).snapshot_date) {
      latest.set(s.keyword, s);
    }
  }
  return Array.from(latest.values());
}

const DEMO_OPPORTUNITY_SCORES = getLatestOpportunityScores();
const DEMO_GOOGLE_TRENDS = getLatestGoogleTrends();

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

// 히스토리컬 데이터 API (차트용)
app.get('/api/history/opportunities', (req, res) => {
  const keyword = req.query.keyword;
  const all = generateHistoricalOpportunityScores();
  const filtered = keyword ? all.filter(s => s.keyword === keyword) : all;
  res.json(filtered.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date)));
});

app.get('/api/history/trends', (req, res) => {
  const keyword = req.query.keyword;
  const all = generateHistoricalGoogleTrends();
  const filtered = keyword ? all.filter(s => s.keyword === keyword) : all;
  res.json(filtered.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date)));
});

app.get('/api/history/instagram', (req, res) => {
  const keyword = req.query.keyword;
  const all = generateHistoricalInstagramSnapshots();
  const filtered = keyword ? all.filter(s => s.keyword === keyword) : all;
  res.json(filtered.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date)));
});

app.get('/api/history/ads', (req, res) => {
  const keyword = req.query.keyword;
  const all = generateHistoricalFacebookAdsSnapshots();
  const filtered = keyword ? all.filter(s => s.keyword === keyword) : all;
  res.json(filtered.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date)));
});

// Supabase에 히스토리컬 시드 데이터 삽입
app.post('/api/seed', async (req, res) => {
  if (!isLive) return res.status(400).json({ error: 'LIVE 모드에서만 사용 가능' });

  const results = { podcast_keywords: 0, opportunity_scores: 0, google_trends: 0, instagram: 0, facebook_ads: 0, keyword_origins: 0, errors: [] };

  try {
    // 1. Podcast Keywords
    for (const pk of DEMO_PODCAST_KEYWORDS) {
      const { error } = await supabase.from('podcast_keywords').upsert(
        { influencer: pk.influencer, keyword: pk.keyword, mentioned_date: pk.mentioned_date, episode_title: pk.episode_title, mention_context: pk.mention_context, mention_quote: pk.mention_quote },
        { onConflict: 'influencer,keyword,mentioned_date' }
      );
      if (!error) results.podcast_keywords++;
      else results.errors.push(`podcast_keywords: ${error.message}`);
    }

    // 2. Opportunity Scores (히스토리컬)
    const oppScores = generateHistoricalOpportunityScores();
    for (const s of oppScores) {
      const { error } = await supabase.from('opportunity_scores').upsert(
        { keyword: s.keyword, opportunity_score: s.opportunity_score, verdict: s.verdict, score_breakdown: s.score_breakdown, strategy_comment: s.strategy_comment, podcast_mention_date: s.podcast_mention_date, instagram_weekly_growth: s.instagram_weekly_growth, google_growth_rate: s.google_growth_rate, facebook_advertiser_count: s.facebook_advertiser_count, snapshot_date: s.snapshot_date },
        { onConflict: 'keyword,snapshot_date' }
      );
      if (!error) results.opportunity_scores++;
      else if (!results.errors.includes(`opportunity_scores: ${error.message}`)) results.errors.push(`opportunity_scores: ${error.message}`);
    }

    // 3. Google Trends (히스토리컬)
    const trends = generateHistoricalGoogleTrends();
    for (const t of trends) {
      const { error } = await supabase.from('google_trends_snapshots').upsert(
        { keyword: t.keyword, current_3m_avg: t.current_3m_avg, prev_3m_avg: t.prev_3m_avg, growth_rate: t.growth_rate, trend_direction: t.trend_direction, snapshot_date: t.snapshot_date },
        { onConflict: 'keyword,snapshot_date' }
      );
      if (!error) results.google_trends++;
    }

    // 4. Instagram (히스토리컬)
    const igSnaps = generateHistoricalInstagramSnapshots();
    for (const s of igSnaps) {
      const { error } = await supabase.from('instagram_snapshots').upsert(
        { keyword: s.keyword, hashtag: s.hashtag, post_count: s.post_count, recent_post_count: s.recent_post_count, snapshot_date: s.snapshot_date },
        { onConflict: 'keyword,snapshot_date' }
      );
      if (!error) results.instagram++;
    }

    // 5. Facebook Ads (히스토리컬)
    const fbSnaps = generateHistoricalFacebookAdsSnapshots();
    for (const s of fbSnaps) {
      const { error } = await supabase.from('facebook_ads_snapshots').upsert(
        { keyword: s.keyword, total_ads: s.total_ads, unique_advertisers: s.unique_advertisers, new_advertisers_this_week: s.new_advertisers_this_week, oldest_ad_date: s.oldest_ad_date, newest_ad_date: s.newest_ad_date, competition_level: s.competition_level, snapshot_date: s.snapshot_date },
        { onConflict: 'keyword,snapshot_date' }
      );
      if (!error) results.facebook_ads++;
    }

    // 6. Keyword Origins
    for (const o of DEMO_KEYWORD_ORIGINS) {
      const { error } = await supabase.from('keyword_origins').upsert(
        { keyword: o.keyword, first_podcast_date: o.first_podcast_date, first_podcast_influencer: o.first_podcast_influencer, first_podcast_episode_title: o.first_podcast_episode_title, first_podcast_quote: o.first_podcast_quote, market_creator_influencer: o.market_creator_influencer, market_creator_ig_growth: o.market_creator_ig_growth, golden_time_start: o.golden_time_start, golden_time_end: o.golden_time_end, golden_time_duration_days: o.golden_time_duration_days, analysis_report: o.analysis_report, analyzed_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: 'keyword' }
      );
      if (!error) results.keyword_origins++;
    }

    res.json({ message: '시드 데이터 삽입 완료!', results });
  } catch (err) {
    res.status(500).json({ error: err.message, results });
  }
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
    `CREATE TABLE IF NOT EXISTS social_mentions (
      id SERIAL PRIMARY KEY, platform TEXT NOT NULL, influencer TEXT,
      keyword TEXT NOT NULL, post_date DATE NOT NULL, post_text TEXT,
      post_url TEXT, post_id TEXT, engagement_count INTEGER,
      created_at TIMESTAMP DEFAULT NOW(), UNIQUE(platform, keyword, post_id)
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
