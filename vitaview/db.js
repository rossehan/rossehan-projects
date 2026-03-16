// [VitaView v2] SQLite DB 세팅 - 6개 테이블
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// DB 파일 경로: /vitaview/data/vitaview.db
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('[VitaView DB] data/ 폴더 생성됨');
}

const DB_PATH = path.join(DATA_DIR, 'vitaview.db');
const db = new Database(DB_PATH);

// WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// ===== 테이블 생성 =====

// 테이블 1: trend_snapshots
db.exec(`
  CREATE TABLE IF NOT EXISTS trend_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT,
    category TEXT,
    google_trends_value REAL,
    google_trends_3m_avg REAL,
    google_trends_prev_3m_avg REAL,
    trend_growth_rate REAL,
    reddit_mention_count INTEGER,
    reddit_negative_ratio REAL,
    youtube_view_count INTEGER,
    youtube_video_count INTEGER,
    bsr_value INTEGER,
    hhi_score REAL,
    opportunity_score REAL,
    verdict TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 테이블 2: category_rankings
db.exec(`
  CREATE TABLE IF NOT EXISTS category_rankings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT,
    keyword TEXT,
    opportunity_score REAL,
    rank_position INTEGER,
    score_breakdown TEXT,
    snapshot_date DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 테이블 3: emerging_keywords
db.exec(`
  CREATE TABLE IF NOT EXISTS emerging_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT,
    first_detected_at DATETIME,
    mention_velocity REAL,
    source TEXT,
    status TEXT DEFAULT 'new',
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 테이블 4: competitor_products
db.exec(`
  CREATE TABLE IF NOT EXISTS competitor_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asin TEXT UNIQUE,
    product_name TEXT,
    category TEXT,
    bsr_history TEXT,
    price REAL,
    first_seen_at DATETIME,
    is_new_product BOOLEAN,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 테이블 5: fda_signals
db.exec(`
  CREATE TABLE IF NOT EXISTS fda_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ingredient TEXT,
    adverse_event_count INTEGER,
    adverse_event_trend TEXT,
    new_approval BOOLEAN,
    opportunity_flag BOOLEAN,
    snapshot_date DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 테이블 6: search_demand_snapshots
db.exec(`
  CREATE TABLE IF NOT EXISTS search_demand_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT,
    source TEXT,
    search_volume_index REAL,
    trend_direction TEXT,
    related_keywords TEXT,
    snapshot_date DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 인덱스 생성
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_trend_snapshots_keyword ON trend_snapshots(keyword, created_at);
  CREATE INDEX IF NOT EXISTS idx_category_rankings_date ON category_rankings(snapshot_date, rank_position);
  CREATE INDEX IF NOT EXISTS idx_emerging_keywords_status ON emerging_keywords(status, last_updated);
  CREATE INDEX IF NOT EXISTS idx_competitor_products_asin ON competitor_products(asin);
  CREATE INDEX IF NOT EXISTS idx_fda_signals_ingredient ON fda_signals(ingredient, snapshot_date);
  CREATE INDEX IF NOT EXISTS idx_search_demand_keyword ON search_demand_snapshots(keyword, snapshot_date);
`);

console.log('[VitaView DB] SQLite 초기화 완료:', DB_PATH);

// ===== DB 헬퍼 함수들 (PostgreSQL 마이그레이션 대비 분리) =====

// [VitaView v2] trend_snapshots 저장
function saveTrendSnapshot(data) {
  return db.prepare(`
    INSERT INTO trend_snapshots
    (keyword, category, google_trends_value, google_trends_3m_avg,
     google_trends_prev_3m_avg, trend_growth_rate, reddit_mention_count,
     reddit_negative_ratio, youtube_view_count, youtube_video_count,
     bsr_value, hhi_score, opportunity_score, verdict)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.keyword, data.category || 'general',
    data.google_trends_value || null, data.google_trends_3m_avg || null,
    data.google_trends_prev_3m_avg || null, data.trend_growth_rate || null,
    data.reddit_mention_count || null, data.reddit_negative_ratio || null,
    data.youtube_view_count || null, data.youtube_video_count || null,
    data.bsr_value || null, data.hhi_score || null,
    data.opportunity_score, data.verdict
  );
}

// [VitaView v2] 마지막 trend snapshot 조회
function getLastTrendSnapshot(keyword) {
  return db.prepare(
    'SELECT * FROM trend_snapshots WHERE keyword = ? ORDER BY created_at DESC LIMIT 1'
  ).get(keyword);
}

// [VitaView v2] category_rankings 저장
function saveCategoryRanking(data) {
  return db.prepare(`
    INSERT OR REPLACE INTO category_rankings
    (category, keyword, opportunity_score, rank_position, score_breakdown, snapshot_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(data.category, data.keyword, data.opportunity_score, data.rank_position,
         JSON.stringify(data.score_breakdown), data.snapshot_date);
}

// [VitaView v2] emerging_keywords 조회
function getEmergingKeywords(limit = 20) {
  return db.prepare(`
    SELECT * FROM emerging_keywords
    WHERE status IN ('new', 'rising')
    AND last_updated > datetime('now', '-24 hours')
    ORDER BY mention_velocity DESC LIMIT ?
  `).all(limit);
}

// [VitaView v2] emerging_keywords upsert
function upsertEmergingKeyword(data) {
  const existing = db.prepare(
    'SELECT * FROM emerging_keywords WHERE keyword = ? ORDER BY last_updated DESC LIMIT 1'
  ).get(data.keyword);

  if (!existing) {
    return db.prepare(`
      INSERT INTO emerging_keywords (keyword, first_detected_at, mention_velocity, source, status)
      VALUES (?, ?, ?, ?, 'new')
    `).run(data.keyword, new Date().toISOString(), data.mention_velocity, data.source || 'reddit');
  } else {
    const velocityGrowth = existing.mention_velocity > 0
      ? ((data.mention_velocity - existing.mention_velocity) / existing.mention_velocity) * 100 : 0;
    const newStatus = velocityGrowth > 50 ? 'rising' : velocityGrowth < -30 ? 'declining' : 'stable';
    return db.prepare(`
      UPDATE emerging_keywords SET mention_velocity = ?, status = ?, last_updated = ? WHERE keyword = ?
    `).run(data.mention_velocity, newStatus, new Date().toISOString(), data.keyword);
  }
}

// [VitaView v2] competitor_products upsert (ASIN 기반)
function upsertCompetitorProduct(data) {
  const existing = db.prepare('SELECT * FROM competitor_products WHERE asin = ?').get(data.asin);
  if (!existing) {
    const bsrHistory = data.bsr ? JSON.stringify([{ bsr: data.bsr, timestamp: new Date().toISOString() }]) : '[]';
    return db.prepare(`
      INSERT INTO competitor_products (asin, product_name, category, bsr_history, price, first_seen_at, is_new_product)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(data.asin, data.product_name, data.category, bsrHistory, data.price, new Date().toISOString());
  } else {
    // BSR history append
    let history = [];
    try { history = JSON.parse(existing.bsr_history || '[]'); } catch(e) {}
    if (data.bsr) {
      history.push({ bsr: data.bsr, timestamp: new Date().toISOString() });
      if (history.length > 100) history = history.slice(-100);
    }
    return db.prepare(`
      UPDATE competitor_products SET bsr_history = ?, price = ?, last_updated = ? WHERE asin = ?
    `).run(JSON.stringify(history), data.price || existing.price, new Date().toISOString(), data.asin);
  }
}

// [VitaView v2] fda_signals 저장/조회
function saveFDASignal(data) {
  return db.prepare(`
    INSERT OR REPLACE INTO fda_signals
    (ingredient, adverse_event_count, adverse_event_trend, new_approval, opportunity_flag, snapshot_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(data.ingredient, data.adverse_event_count, data.adverse_event_trend,
         data.new_approval ? 1 : 0, data.opportunity_flag ? 1 : 0, data.snapshot_date);
}

function getFDASignal(ingredient, date) {
  return db.prepare(
    'SELECT * FROM fda_signals WHERE ingredient = ? AND snapshot_date = ?'
  ).get(ingredient, date);
}

// [VitaView v2] search_demand_snapshots 저장
function saveSearchDemandSnapshot(keyword, source, data) {
  const today = new Date().toISOString().split('T')[0];
  return db.prepare(`
    INSERT OR REPLACE INTO search_demand_snapshots
    (keyword, source, search_volume_index, trend_direction, related_keywords, snapshot_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(keyword, source, data.volumeIndex || 0, data.trendDirection || 'stable',
         JSON.stringify(data.relatedKeywords || []), today);
}

// [VitaView v2] BSR 트렌드 계산
function calculateBSRTrend(bsrHistoryJson) {
  try {
    const history = JSON.parse(bsrHistoryJson || '[]');
    if (history.length < 2) return 'insufficient_data';
    const recent = history.slice(-3).map(h => h.bsr);
    const older = history.slice(0, 3).map(h => h.bsr);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    if (recentAvg < olderAvg * 0.8) return 'rising_fast';
    if (recentAvg < olderAvg) return 'rising';
    if (recentAvg > olderAvg * 1.2) return 'falling_fast';
    return 'stable';
  } catch { return 'unknown'; }
}

// [VitaView v2] 트랜잭션 래퍼
function runTransaction(fn) {
  const transaction = db.transaction(fn);
  return transaction();
}

module.exports = {
  db,
  saveTrendSnapshot,
  getLastTrendSnapshot,
  saveCategoryRanking,
  getEmergingKeywords,
  upsertEmergingKeyword,
  upsertCompetitorProduct,
  saveFDASignal,
  getFDASignal,
  saveSearchDemandSnapshot,
  calculateBSRTrend,
  runTransaction
};
