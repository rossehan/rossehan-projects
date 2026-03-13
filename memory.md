# SuppleMint - Project Memory

## SP-API Configuration
- Credentials stored in local .env file (NOT in git)
- Marketplace: ATVPDKIKX0DER (US)
- .env keys: SP_API_CLIENT_ID, SP_API_CLIENT_SECRET, SP_API_REFRESH_TOKEN, MARKETPLACE_ID

## Local Setup (User's PC)
- Path: C:\Users\admin\Desktop\supplemint-backend
- Files: server.js, dashboard.html, .env, package.json
- Run: `node server.js` -> http://localhost:3001
- NOT a git repo locally; files downloaded via `iwr` from GitHub raw

## Completed Features
1. Dashboard with 3 tabs: Dashboard, Browse, Search
2. 20 supplement categories with real SP-API data
3. Top 100 Products by Sales Rank (clickable -> detail modal)
4. Product images (thumbnail) in Top 100 list
5. Amazon link button on each product row
6. ProductModal with price, rank, ASIN, Amazon link
7. 30-minute auto-refresh with countdown timer
8. Status badge shows LIVE/DEMO + last update time
9. .env file created with SP-API credentials
10. .gitignore protects .env from being pushed

## SP-API Data Structure Fixes (IMPORTANT)
- Price: `list_price[0].value` is a direct NUMBER (not `{amount: "xx.xx"}`)
  - Use `extractPrice()` helper in server.js
- Rank: `salesRanks[0].classificationRanks[0].rank` (NOT `salesRanks[0].ranks[0].rank`)
  - Use `extractRank()` helper in server.js
- Images: `images[0].images[0].link` works correctly
- Brand: `attributes.brand[0].value` works correctly

## How to Update Files on Local PC
```powershell
cd C:\Users\admin\Desktop\supplemint-backend
# Ctrl+C to stop server first
iwr "https://raw.githubusercontent.com/rossehan/Spell-Check/claude/setup-supplemint-5e6W6/supplemint/server.js" -OutFile server.js
iwr "https://raw.githubusercontent.com/rossehan/Spell-Check/claude/setup-supplemint-5e6W6/supplemint/dashboard.html" -OutFile dashboard.html
node server.js
```
Then Ctrl+Shift+R in browser.

## Pending / Known Issues
- Price shows $0 on dashboard -> Fixed with extractPrice() (needs latest server.js + dashboard.html)
- Top 100 empty -> Fixed with extractRank() using classificationRanks (needs latest server.js + dashboard.html)
- Demo mode fallback works when SP-API unavailable
- Debug endpoint available at /api/debug

## User Preferences
- Korean language communication
- Wants auto-refresh (30 min interval) without manual intervention
- Wants product images + Amazon links visible in Top 100 list
- Wants real-time LIVE mode with SP-API
