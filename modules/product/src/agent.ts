// [TrendRadar] 메인 에이전트

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import cron from 'node-cron';
import type { CapabilityContext, AgentEvent } from './types/trendradar.js';
import { scanPodcastKeywords } from './capabilities/scan-podcast-keywords.js';
import { measureInstagramSignal } from './capabilities/measure-instagram-signal.js';
import { measureFacebookAdsSignal } from './capabilities/measure-facebook-ads-signal.js';
import { measureGoogleTrendsSignal } from './capabilities/measure-google-trends-signal.js';
import { analyzeOpportunity } from './capabilities/analyze-opportunity.js';
import { runFullScan } from './capabilities/run-full-scan.js';
import { keywordOriginAnalysis } from './capabilities/keyword-origin-analysis.js';

// 환경변수 검증
const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ANTHROPIC_API_KEY',
  'TADDY_API_KEY',
  'TADDY_USER_ID',
];

for (const envVar of REQUIRED_ENV_VARS) {
  if (!process.env[envVar]) {
    console.error(`[TrendRadar] 필수 환경변수 누락: ${envVar}`);
    process.exit(1);
  }
}

// Supabase 클라이언트
const supabase: SupabaseClient = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Capability 컨텍스트 생성
function createContext(): CapabilityContext {
  return {
    supabase,
    reportProgress: (message: string) => {
      console.log(message);
    },
  };
}

// 이벤트 보고 (Hub Brain에 전달)
async function reportEvent(event: AgentEvent): Promise<void> {
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
    // agent_events 테이블이 없으면 로그만 남김
    console.warn('[TrendRadar] 이벤트 DB 저장 실패 (테이블 미생성?):', (err as Error).message);
  }
}

// Capabilities 레지스트리
type CapabilityHandler = (params: any, ctx: CapabilityContext, reportEventFn?: typeof reportEvent) => Promise<any>;

const capabilities: Record<string, CapabilityHandler> = {
  'scan-podcast-keywords': scanPodcastKeywords,
  'measure-instagram-signal': measureInstagramSignal,
  'measure-facebook-ads-signal': measureFacebookAdsSignal,
  'measure-google-trends-signal': measureGoogleTrendsSignal,
  'analyze-opportunity': analyzeOpportunity,
  'run-full-scan': (params, ctx) => runFullScan(params, ctx, reportEvent),
  'keyword-origin-analysis': (params, ctx) => keywordOriginAnalysis(params, ctx, reportEvent),
};

// Directive 폴링 (Hub에서 지시 수신)
let isRunning = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function pollDirectives(): Promise<void> {
  try {
    const { data: directives } = await supabase
      .from('agent_directives')
      .select('*')
      .eq('agent_id', 'trendradar-agent')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);

    if (!directives || directives.length === 0) return;

    const directive = directives[0];
    const capabilityName = directive.capability;
    const handler = capabilities[capabilityName];

    if (!handler) {
      console.error(`[TrendRadar] 알 수 없는 capability: ${capabilityName}`);
      await supabase
        .from('agent_directives')
        .update({ status: 'failed', error: `Unknown capability: ${capabilityName}` })
        .eq('id', directive.id);
      return;
    }

    // 상태 업데이트: processing
    await supabase
      .from('agent_directives')
      .update({ status: 'processing', started_at: new Date().toISOString() })
      .eq('id', directive.id);

    try {
      const ctx = createContext();
      const result = await handler(directive.params ?? {}, ctx);

      await supabase
        .from('agent_directives')
        .update({
          status: 'completed',
          result,
          completed_at: new Date().toISOString(),
        })
        .eq('id', directive.id);
    } catch (err) {
      console.error(`[TrendRadar] Directive 실행 실패 (${directive.id}):`, (err as Error).message);
      await supabase
        .from('agent_directives')
        .update({
          status: 'failed',
          error: (err as Error).message,
          completed_at: new Date().toISOString(),
        })
        .eq('id', directive.id);
    }
  } catch (err) {
    // 폴링 자체 실패는 무시 (agent_directives 테이블 미생성 등)
  }
}

// 에이전트 시작
async function start(): Promise<void> {
  console.log('[TrendRadar] 에이전트 시작');
  isRunning = true;

  // Directive 폴링 (10초 간격)
  pollTimer = setInterval(pollDirectives, 10000);

  // 매일 오전 7시 KST (UTC 22:00) — 전체 스캔
  cron.schedule('0 22 * * *', async () => {
    console.log('[TrendRadar] [cron] 일일 전체 스캔 시작');
    try {
      const ctx = createContext();
      await runFullScan(
        { influencers: ['huberman', 'sinclair', 'attia', 'brecka'], days_back: 30 },
        ctx,
        reportEvent,
      );
    } catch (err) {
      console.error('[TrendRadar] [cron] 전체 스캔 실패:', (err as Error).message);
    }
  }, { timezone: 'Asia/Seoul' });

  // 매일 오전 9시 KST (UTC 00:00) — 골든타임 모니터링
  cron.schedule('0 0 * * *', async () => {
    console.log('[TrendRadar] [cron] 골든타임 모니터링 시작');
    try {
      const { data: activeKeywords } = await supabase
        .from('keyword_origins')
        .select('keyword, golden_time_start, golden_time_end')
        .not('golden_time_start', 'is', null);

      if (!activeKeywords) return;

      for (const kw of activeKeywords) {
        const isActive = kw.golden_time_start && (
          !kw.golden_time_end || new Date(kw.golden_time_end) >= new Date()
        );

        if (!isActive) continue;

        if (kw.golden_time_end) {
          const daysRemaining = Math.floor(
            (new Date(kw.golden_time_end).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
          );

          if (daysRemaining <= 7 && daysRemaining >= 0) {
            await reportEvent({
              event_type: 'trendradar.golden_time_ending',
              summary: `⚡ 골든타임 종료 임박: ${kw.keyword} — ${daysRemaining}일 남음`,
              metrics: { keyword: kw.keyword, days_remaining: daysRemaining },
              urgency: 'high',
            });
          }
        }
      }
    } catch (err) {
      console.error('[TrendRadar] [cron] 골든타임 모니터링 실패:', (err as Error).message);
    }
  }, { timezone: 'Asia/Seoul' });

  console.log('[TrendRadar] 스케줄 등록 완료 — 매일 07:00 KST 전체 스캔, 09:00 KST 골든타임 모니터링');
}

// 에이전트 중지
async function stop(): Promise<void> {
  console.log('[TrendRadar] 에이전트 종료 중...');
  isRunning = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.log('[TrendRadar] 에이전트 종료 완료');
}

// 시작
start().catch(err => {
  console.error('[TrendRadar] 에이전트 시작 실패:', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await stop();
  process.exit(0);
});
