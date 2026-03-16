# VitaView - Project Memory

## SP-API Configuration
- Credentials stored in local .env file (NOT in git)
- Marketplace: ATVPDKIKX0DER (US)
- .env keys: SP_API_CLIENT_ID, SP_API_CLIENT_SECRET, SP_API_REFRESH_TOKEN, MARKETPLACE_ID

## Local Setup (User's PC)
- Path: C:\Users\admin\Desktop\claude
- Files: server.js, dashboard.html, .env, package.json, node_modules/
- Run: `node server.js` -> http://localhost:3001
- NOT a git repo locally; files downloaded via `iwr` from GitHub raw
- Browser: Ctrl+Shift+R for hard refresh after file updates

## File Structure (in repo)
- `/vitaview/server.js` - Express backend, SP-API integration
- `/vitaview/dashboard.html` - Single-page React app (Babel standalone)
- `/vitaview/package.json` - Dependencies (express, cors, dotenv)
- `/vitaview/.env` - SP-API credentials (gitignored)

## Completed Features

### Phase 1: Core Dashboard
1. Dashboard with 2 tabs: Dashboard, Browse & Search (merged)
2. 100 supplement categories with real SP-API data (expanded from 50)
3. Top 100 Products by Sales Rank (clickable -> detail modal)
4. Product images (64px thumbnail) in Top 100 list
5. Amazon link button (orange arrow) on each product row
6. ProductModal with price, rank, ASIN, bullet points, Amazon link, form type
7. 30-minute auto-refresh with countdown timer (Next Refresh card)
8. Status badge shows LIVE/DEMO + last update time in header
9. .env file with SP-API credentials (local only)
10. .gitignore protects .env from being pushed
11. 3-Section dashboard structure: Section A (Market Overview), Section B (Product Deep-dive), Section C (Opportunity Finder)
12. Top 100 has scrollable container (600px max, no page scroll needed)
13. Estimated daily sales based on BSR rank shown in Top 100 (blue badge ~X sales/day)
14. Refresh button moved to header next to LIVE badge
15. Larger product images (64px) and text (15px title, 13px brand) in Top 100
16. Demo mode fallback when SP-API unavailable
17. Debug endpoint at /api/debug
18. All graph visualizations replaced with ranked number tables
19. Revenue = price * dailySales * 30 (monthly)
20. Browse & Search tabs merged into one combined tab
21. Market Intelligence BI section: Category Revenue Ranking, Competition Analysis (HHI), Market Opportunity Score
22. BI metrics computed from SP-API data: estimatedMonthlyRevenue, avgDailySales, brandCount, HHI, topBrand, topBrandShare, priceSpread
23. Market Opportunity Score = demand(30%) + competition(25%) + priceRoom(20%) + revenue(25%)
24. HHI (Herfindahl-Hirschman Index): <1500=Low competition, 1500-2500=Mid, >2500=High (hard to enter)
25. White/light theme UI (changed from dark theme)
26. Trend hashtag rolling banner under Opportunity Score
27. Competition Analysis with expandable product list (click to see top products per category)
28. Form Analysis (Dosage Type) section: Gummy, Capsule, Softgel, Tablet, Powder, Liquid, etc.
29. Form extraction from product title using regex patterns
30. Ingredient extraction from product title using regex patterns
31. Keyword filtering in dashboard (filter categories by keyword like "Peptide", "Gummy", etc.)
32. New categories added (100 total)

### Phase 2: AI Market Domination
33. AI Market Domination Analysis tab - separate tab with full domination scoring algorithm
34. Domination Score = Fragmentation(30%) + Weak Leader(20%) + Supply-Demand Gap(20%) + Revenue(15%) + Price Gap(15%)
35. Top 1 Spotlight card with WHY DOMINATE, ENTRY STRATEGY, MARKET DATA
36. Full ranking table with all factor scores and difficulty levels
37. Top 10 detailed cards with score breakdown, entry strategy, competitor landscape, top products
38. AI Recommendation Summary (dark theme) with immediate entry targets and high revenue targets
39. Methodology explainer section
40. Keyword Intelligence sub-tab
41. Trend Analysis sub-tab
42. Domination Score enhanced: 6th factor "Trend Momentum" (15%)

### Phase 3: Market Intelligence & Modules
43. Market Intelligence Hub tab (Overview, YouTube, Reddit, FDA Safety, Google Trends)
44. Google Trends, YouTube Data API v3, Reddit API, OpenFDA API integrations
45. Module 1: Amazon Long-tail Keyword Extractor (removed in v2 - replaced by Search Demand)
46. Module 2: Competitor Pain Point Analyzer - Reddit search + NLP
47. Module 3: Entry Barrier & Legal Risk Checker - HHI + brand concentration + patent links
48. Module 4: 1/3 Rule Margin Calculator - COGS/Fees/Profit breakdown

### Phase 4: AI Supplement Formulator
49. AI Supplement Formulator tab - Gemini 2.0 Flash integration
50. 12 health concern categories: sleep, immunity, gut, energy, beauty, weight, joints, mens, womens, longevity, stress, muscle
51. /api/ai-formulator/context: 5-API data aggregation
52. /api/ai-formulator/generate: Gemini LLM product formulation
53. /api/ai-formulator/auto-recommend: 사용자 맞춤형 3개 제품 자동 추천

### Phase 5: Opportunity Score System
54. Opportunity Score = BSR변동폭(25%) + 경쟁(HHI)(25%) + 가격차이(20%) + 수요(15%) + 트렌드(15%)
55. HHI 반전 로직: HHI 낮을수록(경쟁 분산) = 기회 점수 높음
56. BSR 변동폭: top 10 제품의 BSR 표준편차 기반 시장 불안정성 측정
57. Opportunity Score 배지: result banner, product cards, detail view, Score Breakdown 카드
58. Category Opportunity Score 테이블 (데이터 섹션)

### Phase 6: VitaView v2 (2026-03-16)
**Backend (db.js + server.js)**
59. SQLite DB (better-sqlite3, WAL mode) - 6개 테이블 + 헬퍼 함수 (db.js 신규 파일)
    - trend_snapshots, category_rankings, emerging_keywords, competitor_products, fda_signals, search_demand_snapshots
    - DB 경로: /vitaview/data/vitaview.db (Render.com 대비 고정 경로)
60. Google Trends API (google-trends-api npm) + DB fallback 안정화
61. 키워드 비교 API: /api/compare?keywords=x,y,z, /api/compare/history?days=30
62. Data Confidence 점수 시스템 - 5개 신호원 가중 점수 (googleTrends 0.25, reddit 0.25, youtube 0.20, amazonBSR 0.20, patents 0.10)
63. Emerging Keywords 감지 - Reddit + Google Suggestions 기반, /api/emerging
64. Competitor Product ASIN 추적 + BSR 히스토리 append, /api/new-products?category=x&days=90
65. Gemini AI 전략 분석 6시간 캐시 (getGeminiStrategyAnalysis)
66. OpenFDA 부작용 트렌드 분석 + DB 캐싱 (analyzeFDASignals)
67. node-cron 자동화: 매일 6AM UTC 키워드 스냅샷 + 6시간 주기 emerging keyword 감지
68. 히스토리/대시보드 API: /api/history?keyword=x&days=30, /api/dashboard
69. /api/opportunity-score 응답에 dataConfidence, aiStrategy 필드 추가
70. /api/ai-formulator/auto-recommend 응답에 dataConfidence, aiDisclaimer 필드 추가

**Frontend (dashboard.html)**
71. Legal Barrier 탭 UI 전면 교체: 진입난이도 배지(LOW/MEDIUM/HIGH/VERY_HIGH) + HHI 표시 + 특허검색 버튼(USPTO/Google Patents) + Top Brands 점유율
72. Longtail Keywords 탭 제거 (코드 + state + useEffect 모두 삭제)
73. Search Demand Intelligence 탭 (Hashtag Discovery 대체): 4섹션
    - 아마존 인기성분 ([Amazon] 배지, # 없음)
    - Google 트렌딩 검색어 ([Google Trends] 배지)
    - 제형 트렌드 (수평 바 차트, [Amazon] 배지)
    - 소비자 관심 키워드 (다중 소스 라벨 [Amazon], [Google], [Reddit])
74. ROI/매출 수치에 'AI 추정값' 노란 라벨 배지 추가 (월매출, 월순이익, 1년ROI, 연간매출, 연간순이익, 우리예상매출)
75. AI Domination 서브탭: Domination Score, Keyword Intelligence, Trend Analysis, Search Demand, Legal Barrier, Margin Calculator (6개)

## External API Keys
- YOUTUBE_API_KEY: Optional, in .env file. Demo mode works without it.
- Reddit: No key needed (public JSON endpoints)
- OpenFDA: No key needed (completely free)
- Google Trends: No key needed (scraping approach)
- GEMINI_API_KEY: Required for AI Formulator. Free at https://aistudio.google.com/apikey (15 RPM)
- Amazon Autocomplete: No key needed (public endpoint completion.amazon.com)
- USPTO/Google Patents: No key needed (search links generated, no API calls)

## SP-API Data Structure (CRITICAL - DO NOT FORGET)
- **Price**: `list_price[0].value` is a direct NUMBER (e.g. 17.98), NOT `{amount: "xx.xx"}`
  - Use `extractPrice()` helper in server.js
  - Dashboard uses modified `formatPrice()` that checks both formats
- **Rank**: `salesRanks[0].classificationRanks[0].rank` (NOT `salesRanks[0].ranks[0].rank`)
  - Use `extractRank()` helper in server.js
  - Dashboard `getRank()` checks classificationRanks -> displayGroupRanks -> ranks
- **Images**: `images[0].images[0].link` - works correctly, returns full Amazon CDN URL
- **Brand**: `attributes.brand[0].value` - works correctly
- **Title**: `summaries[0].itemName` - works correctly

## Daily Sales Estimation Formula (BSR-based)
- Health & Household category approximation
- rank <= 5: ~300-700/day
- rank <= 50: ~60-200/day
- rank <= 500: ~20-80/day
- rank <= 5000: ~8-25/day
- rank <= 50000: ~3-8/day
- rank > 50000: ~1-3/day
- Function: `estimateDailySales(rank)` in dashboard.html

## Server Endpoints
- GET `/` - Serves dashboard.html
- GET `/api/health` - Connection status (live/demo)
- GET `/api/trends` - All 50 categories data (prices, ranks, brands, topProducts)
- GET `/api/search?q=keyword` - Search products
- GET `/api/product/:asin` - Single product details
- GET `/api/products/:categoryId` - Products by category
- GET `/api/categories` - List all categories
- GET `/api/debug` - Debug SP-API response structure
- GET `/api/keyword-intelligence` - Keyword analysis from product titles (requires trends cache)
- GET `/api/google-suggest?q=keyword` - Google Autocomplete suggestions
- GET `/api/trend-keywords` - Batch Google search trend keywords for supplements
- GET `/api/market-intel/google-trends` - Google Trends interest over time + autocomplete signals
- GET `/api/market-intel/youtube` - YouTube trending supplement videos (live/demo mode)
- GET `/api/market-intel/reddit` - Reddit hot posts from supplement subreddits
- GET `/api/market-intel/fda?ingredient=X` - OpenFDA safety data for single ingredient
- GET `/api/market-intel/fda-batch` - Batch FDA safety scores for multiple ingredients
- GET `/api/market-intel/summary` - Combined intelligence from all sources
- GET `/api/amazon-suggest?q=keyword` - Amazon autocomplete suggestions (Module 1)
- GET `/api/longtail-keywords?category=X` - Long-tail keyword extraction from Amazon autocomplete (Module 1)
- GET `/api/painpoint-analysis?category=X` - Reddit-based competitor pain point analysis (Module 2)
- GET `/api/legal-barrier?category=X` - Entry barrier & legal risk check using brand data (Module 3)
- GET `/api/margin-calculator?category=X` - 1/3 rule margin calculator with Alibaba links (Module 4)

## Category Keywords (100 categories)
vitamins, protein, omega, probiotics, collagen, magnesium, vitaminD, vitaminC, zinc, iron, calcium, biotin, melatonin, ashwagandha, creatine, turmeric, elderberry, fiber, multivitamin, bcaa, glutamine, coq10, vitaminB, vitaminE, vitaminK, potassium, selenium, manganese, lysine, glucosamine, spirulina, chlorella, echinacea, ginseng, garlic, greenTea, appleCiderVinegar, maca, saw_palmetto, milk_thistle, rhodiola, valerian, fenugreek, black_seed_oil, quercetin, resveratrol, lions_mane, reishi, berberine, digestive_enzymes, lutein, astaxanthin, dhea, five_htp, l_theanine, l_carnitine, alpha_lipoic_acid, nac, dim, tribulus, tongkat_ali, shilajit, cordyceps, chaga, turkey_tail, moringa, sea_moss, olive_leaf, oregano_oil, vitamin_a, folate, chromium, iodine, boron, copper, inositol, pqq, nmn, hyaluronic_acid, keratin, msm, chondroitin, bromelain, psyllium_husk, bovine_colostrum, beta_alanine, citrulline, electrolytes, whey_protein, casein, pea_protein, hemp_protein, fish_oil, krill_oil, evening_primrose, black_cohosh, st_johns_wort, bilberry

## PowerShell Commands (Copy & Paste)

### 처음 설치 (최초 1회)
```powershell
cd C:\Users\admin\Desktop\claude
npm init -y
npm install express cors dotenv axios
```

### 파일 업데이트 (변경사항 반영)
```powershell
cd C:\Users\admin\Desktop\claude
iwr "https://raw.githubusercontent.com/rossehan/Spell-Check/claude/setup-supplemint-5e6W6/vitaview/server.js" -OutFile server.js
iwr "https://raw.githubusercontent.com/rossehan/Spell-Check/claude/setup-supplemint-5e6W6/vitaview/dashboard.html" -OutFile dashboard.html
```

### 서버 실행
```powershell
cd C:\Users\admin\Desktop\claude
node server.js
```

### 서버 중지 후 재시작
```
Ctrl+C (서버 중지)
node server.js
```

### 브라우저
```
http://localhost:3001
Ctrl+Shift+R (하드 리프레시)
```

### 전체 한번에 (업데이트 + 서버 실행)
```powershell
cd C:\Users\admin\Desktop\claude; iwr "https://raw.githubusercontent.com/rossehan/Spell-Check/claude/setup-supplemint-5e6W6/vitaview/server.js" -OutFile server.js; iwr "https://raw.githubusercontent.com/rossehan/Spell-Check/claude/setup-supplemint-5e6W6/vitaview/dashboard.html" -OutFile dashboard.html; node server.js
```

## User Preferences
- Korean language communication (한국어)
- Wants auto-refresh (30 min interval) without manual intervention
- Wants product images + Amazon links visible in Top 100 list
- Wants real-time LIVE mode with SP-API
- Top 100 should be at the top of dashboard, price sections at bottom
- Top 100 should scroll inside its own container, not the whole page
- Text and images should be large enough to read easily
- Refresh button should be in header next to LIVE badge (not in content area)
- Daily sales estimates should be visible per product

## Git Branch
- Working branch: `claude/setup-supplemint-5e6W6`
- Repo: rossehan/Spell-Check
