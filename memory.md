# SuppleMint - Project Memory

## SP-API Configuration
- Credentials stored in local .env file (NOT in git)
- Marketplace: ATVPDKIKX0DER (US)
- .env keys: SP_API_CLIENT_ID, SP_API_CLIENT_SECRET, SP_API_REFRESH_TOKEN, MARKETPLACE_ID

## Local Setup (User's PC)
- Path: C:\Users\admin\Desktop\supplemint-backend
- Files: server.js, dashboard.html, .env, package.json, node_modules/
- Run: `node server.js` -> http://localhost:3001
- NOT a git repo locally; files downloaded via `iwr` from GitHub raw
- Browser: Ctrl+Shift+R for hard refresh after file updates

## File Structure (in repo)
- `/supplemint/server.js` - Express backend, SP-API integration
- `/supplemint/dashboard.html` - Single-page React app (Babel standalone)
- `/supplemint/package.json` - Dependencies (express, cors, dotenv)
- `/supplemint/.env` - SP-API credentials (gitignored)

## Completed Features
1. Dashboard with 3 tabs: Dashboard, Browse, Search
2. 20 supplement categories with real SP-API data
3. Top 100 Products by Sales Rank (clickable -> detail modal)
4. Product images (64px thumbnail) in Top 100 list
5. Amazon link button (orange arrow) on each product row
6. ProductModal with price, rank, ASIN, bullet points, Amazon link
7. 30-minute auto-refresh with countdown timer (Next Refresh card)
8. Status badge shows LIVE/DEMO + last update time in header
9. .env file with SP-API credentials (local only)
10. .gitignore protects .env from being pushed
11. Dashboard section order: Top 100 -> Top Brands -> Products by Category -> Avg Price -> Price Distribution + Category Table
12. Top 100 has scrollable container (600px max, no page scroll needed)
13. Estimated daily sales based on BSR rank shown in Top 100 (blue badge ~X sales/day)
14. Refresh button moved to header next to LIVE badge
15. Larger product images (64px) and text (15px title, 13px brand) in Top 100
16. Demo mode fallback when SP-API unavailable
17. Debug endpoint at /api/debug

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
- GET `/api/trends` - All 20 categories data (prices, ranks, brands, topProducts)
- GET `/api/search?q=keyword` - Search products
- GET `/api/product/:asin` - Single product details
- GET `/api/products/:categoryId` - Products by category
- GET `/api/categories` - List all categories
- GET `/api/debug` - Debug SP-API response structure

## Category Keywords (20 categories)
vitamins, protein, omega, probiotics, collagen, magnesium, vitaminD, vitaminC, zinc, iron, calcium, biotin, melatonin, ashwagandha, creatine, turmeric, elderberry, fiber, multivitamin, bcaa

## How to Update Files on Local PC
```powershell
cd C:\Users\admin\Desktop\supplemint-backend
# Ctrl+C to stop server first
iwr "https://raw.githubusercontent.com/rossehan/Spell-Check/claude/setup-supplemint-5e6W6/supplemint/server.js" -OutFile server.js
iwr "https://raw.githubusercontent.com/rossehan/Spell-Check/claude/setup-supplemint-5e6W6/supplemint/dashboard.html" -OutFile dashboard.html
node server.js
```
Then Ctrl+Shift+R in browser.

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
