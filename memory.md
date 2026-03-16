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
26. Trend hashtag rolling banner under Opportunity Score (#Magnesium, #GutHealth, #Fiber, etc.)
27. Competition Analysis with expandable product list (click to see top products per category)
28. Form Analysis (Dosage Type) section: Gummy, Capsule, Softgel, Tablet, Powder, Liquid, etc.
29. Form extraction from product title using regex patterns
30. Ingredient extraction from product title using regex patterns
31. Keyword filtering in dashboard (filter categories by keyword like "Peptide", "Gummy", etc.)
32. New categories added: Lutein, Astaxanthin, DHEA, 5-HTP, L-Theanine, L-Carnitine, ALA, NAC, DIM, Tribulus, Tongkat Ali, Shilajit, Cordyceps, Chaga, Turkey Tail, Moringa, Sea Moss, Olive Leaf, Oregano Oil, Vitamin A, Folate, Chromium, Iodine, Boron, Copper, Inositol, PQQ, NMN, Hyaluronic Acid, Keratin, MSM, Chondroitin, Bromelain, Psyllium Husk, Bovine Colostrum, Beta Alanine, Citrulline, Electrolytes, Whey Protein, Casein, Pea Protein, Hemp Protein, Fish Oil, Krill Oil, Evening Primrose, Black Cohosh, St. John's Wort, Bilberry

33. AI Market Domination Analysis tab - separate tab with full domination scoring algorithm
34. Domination Score = Fragmentation(30%) + Weak Leader(20%) + Supply-Demand Gap(20%) + Revenue(15%) + Price Gap(15%)
35. Top 1 Spotlight card with WHY DOMINATE, ENTRY STRATEGY, MARKET DATA
36. Full ranking table with all factor scores and difficulty levels
37. Top 10 detailed cards with score breakdown, entry strategy, competitor landscape, top products
38. AI Recommendation Summary (dark theme) with immediate entry targets and high revenue targets
39. Methodology explainer section

40. Keyword Intelligence sub-tab: top keywords, compound keywords, cross-category trending ingredients, form trends, premium vs budget keywords
41. Trend Analysis sub-tab: Google search trend keywords (via Autocomplete API), Google+Amazon overlap analysis, category trend momentum ranking
42. Hashtag Discovery sub-tab: ingredient hashtags, Google trend hashtags, product form hashtags, lifestyle/marketing hashtags
43. Domination Score enhanced: 6th factor "Trend Momentum" (15%) added using keyword intelligence + Google trends data
44. AI Domination now has 4 sub-tabs: Domination Score, Keyword Intelligence, Trend Analysis, Hashtag Discovery

45. Market Intelligence Hub tab - new "Market Intel" tab with 5 sub-tabs (Overview, YouTube, Reddit, FDA Safety, Google Trends)
46. Google Trends API integration - interest over time graphs, Google Autocomplete signals
47. YouTube Data API v3 integration - trending supplement videos, ingredient mentions from video titles (demo mode when no API key)
48. Reddit API integration (public JSON, no auth) - r/supplements, r/nootropics, r/nutrition, r/fitness hot posts, sentiment analysis, trending supplement mentions
49. OpenFDA API integration - adverse events, recalls, drug interactions, safety scores per ingredient, batch safety check
50. Market Intelligence Summary endpoint - combines all data sources
51. YouTube demo mode with curated data when YOUTUBE_API_KEY not set

## External API Keys
- YOUTUBE_API_KEY: Optional, in .env file. Demo mode works without it.
- Reddit: No key needed (public JSON endpoints)
- OpenFDA: No key needed (completely free)
- Google Trends: No key needed (scraping approach)

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
