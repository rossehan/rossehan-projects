# TrendRadar Agent (@ax/product-agent)

AX Operations Hub의 Product Planning 모듈 에이전트입니다.
팟캐스트 인플루언서가 언급한 건강/서플리먼트 키워드를 수집하고,
Instagram + Facebook Ad Library + Google Trends 데이터를 교차 분석하여
신제품 진입 기회("골든타임")를 자동으로 탐지합니다.

## 분석 파이프라인

```
팟캐스트 에피소드 (Taddy API)
     ↓ 트랜스크립트 키워드 추출
키워드 기원 분석 ← 누가 최초/시장 형성자인지
     ↓
Instagram 해시태그 반응 측정
     ↓
Facebook Ad Library 광고 집행 현황
     ↓
Google Trends 교차 검증
     ↓
골든타임 계산 + Opportunity Score
     ↓
Hub Brain에 자동 보고
```

## 골든타임(Golden Time)이란?

**시장 형성자가 키워드를 언급한 날 ~ 첫 광고가 집행된 날** 사이의 구간입니다.

- "최초 언급자 ≠ 시장 형성자" — 작은 팟캐스트에서 먼저 나왔어도 Huberman이 언급할 때까지 시장 반응이 없을 수 있음
- 골든타임 진행 중 = 언급됐지만 아직 광고 없음 → **선점 기회**
- 골든타임 종료 = 광고주 진입 시작 → 경쟁 심화

## 환경 세팅

### 1. 환경변수 설정

```bash
cp .env.example .env
# .env 파일에 각 API 키 입력
```

| 환경변수 | 용도 | 발급 방법 |
|---|---|---|
| `SUPABASE_URL` | 데이터 저장 | AX Hub 공통 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 인증 | 유동현에게 받기 |
| `ANTHROPIC_API_KEY` | Claude API | 유동현에게 받기 |
| `TADDY_API_KEY` | 팟캐스트 데이터 | https://taddy.org/developers |
| `TADDY_USER_ID` | Taddy 인증 | Taddy 대시보드 |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram Graph API | Meta Business Suite |
| `INSTAGRAM_USER_ID` | Instagram 계정 ID | Meta Business Suite |
| `META_ACCESS_TOKEN` | Facebook Ad Library | Meta Business Suite |

### 2. Supabase 스키마 실행

Supabase Dashboard → SQL Editor에서 `src/db/schema.sql` 내용을 실행하세요.

생성되는 테이블:
- `podcast_keywords` — 팟캐스트 키워드 언급 기록
- `instagram_snapshots` — Instagram 해시태그 스냅샷
- `facebook_ads_snapshots` — Facebook 광고 현황
- `google_trends_snapshots` — Google Trends 스냅샷
- `opportunity_scores` — 기회 점수 기록
- `keyword_origins` — 키워드 기원 분석 결과

### 3. Taddy UUID 찾는 방법

**방법 1: taddy.org 웹사이트**
1. https://taddy.org 접속
2. 팟캐스트 이름 검색 (예: "Huberman Lab")
3. 팟캐스트 페이지 URL에서 UUID 복사

**방법 2: Taddy API 검색**
```graphql
{
  search(term: "Huberman Lab", filterForTypes: PODCASTSERIES) {
    podcastSeries {
      uuid
      name
    }
  }
}
```

찾은 UUID를 `src/capabilities/scan-podcast-keywords.ts`의 `INFLUENCERS` 설정에 입력하세요.

### 4. Instagram/Meta API 토큰 발급

1. [Meta for Developers](https://developers.facebook.com/) 접속
2. 앱 생성 → Instagram Graph API 추가
3. Business Account 연결
4. Graph API Explorer에서 토큰 발급
5. 필요한 권한: `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`
6. Ad Library API는 별도로 `ads_read` 권한 필요

## 실행

```bash
# 의존성 설치
pnpm install

# 개발 모드 (파일 변경 시 자동 재시작)
npm run dev

# 프로덕션 모드
npm start
```

## 자동 스케줄

| 시간 (KST) | 작업 |
|---|---|
| 매일 07:00 | `run-full-scan` — 팟캐스트 스캔 → 신호 측정 → 기회 분석 |
| 매일 09:00 | 골든타임 모니터링 — 종료 임박 키워드 경보 |

## Capabilities

| 이름 | 설명 | 신뢰 레벨 |
|---|---|---|
| `scan-podcast-keywords` | 인플루언서 팟캐스트 키워드 추출 | L2 (사후보고) |
| `measure-instagram-signal` | Instagram 해시태그 반응 측정 | L2 |
| `measure-facebook-ads-signal` | Facebook 광고 집행 현황 | L2 |
| `measure-google-trends-signal` | Google Trends 성장률 | L2 |
| `analyze-opportunity` | 종합 기회 점수 계산 | L2 |
| `run-full-scan` | 전체 파이프라인 실행 | L1 (승인 필요) |
| `keyword-origin-analysis` | 키워드 기원 역추적 + 골든타임 | L2 |

## 이벤트 보고

| 이벤트 | 조건 | 긴급도 |
|---|---|---|
| `trendradar.opportunity_found` | 기회 점수 80점 이상 | high |
| `trendradar.golden_time_detected` | 골든타임 진입 감지 | critical |
| `trendradar.golden_time_ending` | 골든타임 종료 7일 이내 | high |
