# CLAUDE.md - Instructions for Claude Code

## Project: VitaView
Amazon supplement market intelligence dashboard using SP-API.

## IMPORTANT: Always Read memory.md First
Before starting any work, read `/memory.md` for:
- Complete feature list and current state
- SP-API data structure (price, rank, image formats)
- User preferences and local setup details
- All helper functions (extractPrice, extractRank, estimateDailySales)

## Key Rules
1. **Language**: Always communicate in Korean (한국어)
2. **SP-API price**: `list_price[0].value` is a NUMBER, not `{amount: "xx.xx"}`
3. **SP-API rank**: Use `classificationRanks[0].rank`, NOT `ranks[0].rank`
4. **After changes**: Tell user to run `iwr` commands to download updated files
5. **Never commit .env** or any secrets to git
6. **Update memory.md** after every significant change
7. **Git branch**: `claude/setup-supplemint-5e6W6`

## File Locations
- Backend: `/vitaview/server.js`
- Frontend: `/vitaview/dashboard.html`
- Memory: `/memory.md`
- User's local: `C:\Users\admin\Desktop\supplemint-backend`
