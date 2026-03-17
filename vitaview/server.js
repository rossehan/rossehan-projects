require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const querystring = require('querystring');
const cron = require('node-cron');

// [VitaView v2] SQLite DB import
const {
  db, saveTrendSnapshot, getLastTrendSnapshot, saveCategoryRanking,
  getEmergingKeywords, upsertEmergingKeyword, upsertCompetitorProduct,
  saveFDASignal, getFDASignal, saveSearchDemandSnapshot, calculateBSRTrend,
  runTransaction
} = require('./db');

const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const CLIENT_ID = process.env.SP_API_CLIENT_ID;
const CLIENT_SECRET = process.env.SP_API_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.SP_API_REFRESH_TOKEN;
const MARKETPLACE_ID = process.env.MARKETPLACE_ID || 'ATVPDKIKX0DER';
const PORT = process.env.PORT || 3001;

let accessToken = null;
let tokenExpiry = 0;

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Gemini API 호출 헬퍼 (재시도 + 모델 폴백)
const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-1.5-flash'];

async function callGemini(geminiBody, apiKey) {
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0 || model !== GEMINI_MODELS[0]) {
          console.log(`🔄 Gemini retry: model=${model}, attempt=${attempt + 1}`);
        }
        const bodyStr = typeof geminiBody === 'string' ? geminiBody : JSON.stringify(geminiBody);
        const res = await httpsPost(
          'generativelanguage.googleapis.com',
          `/v1beta/models/${model}:generateContent?key=${apiKey}`,
          { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
          bodyStr
        );
        // 503/429 = 과부하/rate limit → 재시도
        if (res.status === 503 || res.status === 429) {
          console.log(`⚠️ Gemini ${model} returned ${res.status}, trying next...`);
          await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
          continue;
        }
        res._model = model;
        return res;
      } catch(e) {
        console.log(`⚠️ Gemini ${model} error: ${e.message}`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  // 모든 모델 실패
  return { status: 503, data: { error: { code: 503, message: '모든 Gemini 모델이 현재 과부하 상태입니다. 잠시 후 다시 시도해주세요.' } } };
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;
  const body = querystring.stringify({
    grant_type: 'refresh_token',
    refresh_token: REFRESH_TOKEN,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  });
  const res = await httpsPost('api.amazon.com', '/auth/o2/token', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body)
  }, body);
  if (res.data.access_token) {
    accessToken = res.data.access_token;
    tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    console.log('✅ Access token obtained');
    return accessToken;
  }
  throw new Error('Token error: ' + JSON.stringify(res.data));
}

function extractRank(salesRanks) {
  const sr = salesRanks?.[0];
  if (!sr) return null;
  // Try classificationRanks first (category-specific), then displayGroupRanks (overall)
  const rank = sr.classificationRanks?.[0]?.rank || sr.displayGroupRanks?.[0]?.rank || sr.ranks?.[0]?.rank;
  return rank || null;
}

function estimateDailySales(rank) {
  if (!rank || rank <= 0) return 0;
  if (rank <= 5) return Math.round(300 + (5 - rank) * 100);
  if (rank <= 50) return Math.round(200 * Math.pow(rank / 5, -0.6));
  if (rank <= 500) return Math.round(80 * Math.pow(rank / 50, -0.5));
  if (rank <= 5000) return Math.round(25 * Math.pow(rank / 500, -0.45));
  if (rank <= 50000) return Math.round(8 * Math.pow(rank / 5000, -0.4));
  return Math.max(1, Math.round(3 * Math.pow(rank / 50000, -0.35)));
}

function extractPrice(attrs) {
  const lp = attrs?.list_price?.[0];
  if (lp) {
    if (typeof lp.value === 'number') return lp.value;
    if (typeof lp.value === 'string') return parseFloat(lp.value);
    if (lp.value?.amount) return parseFloat(lp.value.amount);
  }
  const p = attrs?.price?.[0];
  if (p) {
    if (typeof p.value === 'number') return p.value;
    if (typeof p.value === 'string') return parseFloat(p.value);
  }
  return null;
}

async function spApiGet(path) {
  const token = await getAccessToken();
  return httpsGet('sellingpartnerapi-na.amazon.com', path, {
    'x-amz-access-token': token,
    'Content-Type': 'application/json'
  });
}

// In-memory cache for trends data (5 min TTL)
let trendsCache = null;
let trendsCacheTime = 0;
const TRENDS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

app.get('/api/health', async (req, res) => {
  let spConnected = false;
  try { await getAccessToken(); spConnected = true; } catch(e) {}
  res.json({ status: 'ok', spApiConnected: spConnected, mode: spConnected ? 'live' : 'demo', timestamp: new Date().toISOString() });
});

app.get('/api/search', async (req, res) => {
  const q = req.query.q || 'vitamin';
  try {
    const result = await spApiGet(`/catalog/2022-04-01/items?keywords=${encodeURIComponent(q)}&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,attributes,salesRanks,images`);
    res.json(result.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/product/:asin', async (req, res) => {
  try {
    const result = await spApiGet(`/catalog/2022-04-01/items/${req.params.asin}?marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,attributes,salesRanks,images`);
    res.json(result.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const CATEGORY_KEYWORDS = {
  vitamins: 'vitamins supplements', protein: 'protein powder',
  omega: 'omega fish oil', probiotics: 'probiotics',
  collagen: 'collagen supplements', magnesium: 'magnesium supplement',
  vitaminD: 'vitamin d3', vitaminC: 'vitamin c supplement',
  zinc: 'zinc supplement', iron: 'iron supplement',
  calcium: 'calcium supplement', biotin: 'biotin supplement',
  melatonin: 'melatonin supplement', ashwagandha: 'ashwagandha supplement',
  creatine: 'creatine supplement', turmeric: 'turmeric curcumin supplement',
  elderberry: 'elderberry supplement', fiber: 'fiber supplement',
  multivitamin: 'multivitamin supplement', bcaa: 'bcaa supplement',
  glutamine: 'glutamine supplement', coq10: 'coq10 supplement',
  vitaminB: 'vitamin b complex', vitaminE: 'vitamin e supplement',
  vitaminK: 'vitamin k2', potassium: 'potassium supplement',
  selenium: 'selenium supplement', manganese: 'manganese supplement',
  lysine: 'l-lysine supplement', glucosamine: 'glucosamine chondroitin',
  spirulina: 'spirulina supplement', chlorella: 'chlorella supplement',
  echinacea: 'echinacea supplement', ginseng: 'ginseng supplement',
  garlic: 'garlic supplement', greenTea: 'green tea extract supplement',
  appleCiderVinegar: 'apple cider vinegar supplement', maca: 'maca root supplement',
  saw_palmetto: 'saw palmetto supplement', milk_thistle: 'milk thistle supplement',
  rhodiola: 'rhodiola rosea supplement', valerian: 'valerian root supplement',
  fenugreek: 'fenugreek supplement', black_seed_oil: 'black seed oil supplement',
  quercetin: 'quercetin supplement', resveratrol: 'resveratrol supplement',
  lions_mane: 'lions mane mushroom supplement', reishi: 'reishi mushroom supplement',
  berberine: 'berberine supplement', digestive_enzymes: 'digestive enzymes supplement',
  lutein: 'lutein eye supplement', astaxanthin: 'astaxanthin supplement',
  dhea: 'dhea supplement', five_htp: '5-htp supplement',
  l_theanine: 'l-theanine supplement', l_carnitine: 'l-carnitine supplement',
  alpha_lipoic_acid: 'alpha lipoic acid supplement', nac: 'nac n-acetyl cysteine supplement',
  dim: 'dim supplement', tribulus: 'tribulus supplement',
  tongkat_ali: 'tongkat ali supplement', shilajit: 'shilajit supplement',
  cordyceps: 'cordyceps mushroom supplement', chaga: 'chaga mushroom supplement',
  turkey_tail: 'turkey tail mushroom supplement', moringa: 'moringa supplement',
  sea_moss: 'sea moss supplement', olive_leaf: 'olive leaf extract supplement',
  oregano_oil: 'oregano oil supplement', vitamin_a: 'vitamin a supplement',
  folate: 'folate folic acid supplement', chromium: 'chromium supplement',
  iodine: 'iodine supplement', boron: 'boron supplement',
  copper: 'copper supplement', inositol: 'inositol supplement',
  pqq: 'pqq supplement', nmn: 'nmn supplement',
  hyaluronic_acid: 'hyaluronic acid supplement', keratin: 'keratin supplement',
  msm: 'msm supplement', chondroitin: 'chondroitin supplement',
  bromelain: 'bromelain supplement', psyllium_husk: 'psyllium husk fiber',
  bovine_colostrum: 'bovine colostrum supplement', beta_alanine: 'beta alanine supplement',
  citrulline: 'citrulline supplement', electrolytes: 'electrolyte supplement',
  whey_protein: 'whey protein powder', casein: 'casein protein powder',
  pea_protein: 'pea protein powder', hemp_protein: 'hemp protein powder',
  fish_oil: 'fish oil supplement', krill_oil: 'krill oil supplement',
  evening_primrose: 'evening primrose oil supplement', black_cohosh: 'black cohosh supplement',
  st_johns_wort: 'st johns wort supplement', bilberry: 'bilberry extract supplement'
};

app.get('/api/categories', (req, res) => {
  res.json(Object.entries(CATEGORY_KEYWORDS).map(([id, keyword]) => ({
    id, keyword, name: id.charAt(0).toUpperCase() + id.slice(1)
  })));
});

// Fetch multiple pages from SP-API for a single keyword (up to maxPages)
async function spApiFetchPages(keyword, maxPages = 3) {
  let allItems = [];
  let pageToken = null;
  let totalResults = 0;
  for (let page = 0; page < maxPages; page++) {
    let url = `/catalog/2022-04-01/items?keywords=${encodeURIComponent(keyword)}&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,attributes,salesRanks,images&pageSize=20`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const r = await spApiGet(url);
    const items = r.data?.items || [];
    allItems = allItems.concat(items);
    totalResults = r.data?.numberOfResults || totalResults;
    pageToken = r.data?.pagination?.nextToken;
    if (!pageToken) break;
    if (page < maxPages - 1) await new Promise(resolve => setTimeout(resolve, 300));
  }
  return { items: allItems, numberOfResults: totalResults };
}

// Batch helper: fetch in groups of BATCH_SIZE with delay between batches
async function fetchInBatches(entries, batchSize = 10, delayMs = 1500) {
  const results = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(([id, keyword]) =>
        spApiFetchPages(keyword, 3)
          .then(data => ({ id, data }))
      )
    );
    results.push(...batchResults);
    if (i + batchSize < entries.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    console.log(`Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(entries.length / batchSize)} done (${Math.min(i + batchSize, entries.length)}/${entries.length})`);
  }
  return results;
}

app.get('/api/trends', async (req, res) => {
  // Return cached data if fresh (skip with ?refresh=true)
  if (trendsCache && Date.now() - trendsCacheTime < TRENDS_CACHE_TTL && req.query.refresh !== 'true') {
    console.log('📦 Returning cached trends data');
    return res.json(trendsCache);
  }
  const categories = CATEGORY_KEYWORDS;
  try {
    const results = {};
    const entries = Object.entries(categories);
    const fetches = await fetchInBatches(entries, 15, 800);
    for (const result of fetches) {
      if (result.status === 'fulfilled') {
        const { id, data } = result.value;
        const items = data.items || [];
        const prices = items.map(p => extractPrice(p.attributes)).filter(Boolean);
        console.log(`[${id}] items: ${items.length}, prices found: ${prices.length}, sample: ${prices.slice(0,3)}`);
        const ranks = items.map(p => extractRank(p.salesRanks)).filter(Boolean);
        const brands = {};
        items.forEach(p => {
          const brand = p.attributes?.brand?.[0]?.value || 'Unknown';
          const priceVal = extractPrice(p.attributes) || 0;
          const rank = extractRank(p.salesRanks);
          const dailySales = estimateDailySales(rank);
          const monthlyRevenue = priceVal * dailySales * 30;
          if (!brands[brand]) brands[brand] = { count: 0, revenue: 0 };
          brands[brand].count += 1;
          brands[brand].revenue += monthlyRevenue;
        });
        // BI metrics
        const totalCatRevenue = Object.values(brands).reduce((sum, b) => sum + b.revenue, 0);
        const dailySalesArr = ranks.map(r => estimateDailySales(r));
        const avgDailySales = dailySalesArr.length ? Math.round(dailySalesArr.reduce((a, b) => a + b, 0) / dailySalesArr.length) : 0;
        const brandCount = Object.keys(brands).length;
        const totalBrandProducts = Object.values(brands).reduce((sum, b) => sum + b.count, 0);
        const hhi = totalBrandProducts > 0 ? Math.round(Object.values(brands).reduce((sum, b) => {
          const share = (b.count / totalBrandProducts) * 100;
          return sum + share * share;
        }, 0)) : 0;
        const topBrandEntry = Object.entries(brands).sort((a, b) => b[1].revenue - a[1].revenue)[0];
        const topBrandShare = topBrandEntry && totalCatRevenue > 0 ? Math.round((topBrandEntry[1].revenue / totalCatRevenue) * 100) : 0;

        results[id] = {
          totalProducts: data.numberOfResults || items.length,
          itemCount: items.length,
          avgPrice: prices.length ? +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : 0,
          minPrice: prices.length ? Math.min(...prices) : 0,
          maxPrice: prices.length ? Math.max(...prices) : 0,
          avgRank: ranks.length ? Math.round(ranks.reduce((a, b) => a + b, 0) / ranks.length) : 0,
          estimatedMonthlyRevenue: Math.round(totalCatRevenue),
          avgDailySales,
          brandCount,
          hhi,
          topBrand: topBrandEntry ? topBrandEntry[0] : 'N/A',
          topBrandShare,
          priceSpread: prices.length ? +(Math.max(...prices) - Math.min(...prices)).toFixed(2) : 0,
          brands,
          topProducts: items
            .map(p => ({
              asin: p.asin,
              title: p.summaries?.[0]?.itemName || 'Unknown',
              brand: p.attributes?.brand?.[0]?.value || 'Unknown',
              price: extractPrice(p.attributes),
              rank: extractRank(p.salesRanks),
              image: p.images?.[0]?.images?.[0]?.link || null
            }))
            .filter(p => p.rank)
            .sort((a, b) => a.rank - b.rank)
            .slice(0, 100),
          priceDistribution: {
            under10: prices.filter(p => p < 10).length,
            '10to20': prices.filter(p => p >= 10 && p < 20).length,
            '20to30': prices.filter(p => p >= 20 && p < 30).length,
            '30to50': prices.filter(p => p >= 30 && p < 50).length,
            over50: prices.filter(p => p >= 50).length,
          }
        };
      }
    }
    const responseData = { categories: results, timestamp: new Date().toISOString() };
    trendsCache = responseData;
    trendsCacheTime = Date.now();
    console.log('✅ Trends data cached');
    res.json(responseData);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/products/:categoryId', async (req, res) => {
  const keyword = CATEGORY_KEYWORDS[req.params.categoryId] || req.params.categoryId;
  try {
    const result = await spApiGet(`/catalog/2022-04-01/items?keywords=${encodeURIComponent(keyword)}&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,attributes,salesRanks,images`);
    res.json(result.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Debug endpoint - shows price extraction details
app.get('/api/debug', async (req, res) => {
  try {
    const result = await spApiGet(`/catalog/2022-04-01/items?keywords=vitamin+supplements&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,attributes,salesRanks,images`);
    const items = result.data?.items || [];
    const itemDebug = items.slice(0, 2).map(p => ({
      asin: p.asin,
      title: p.summaries?.[0]?.itemName,
      extractedPrice: extractPrice(p.attributes),
      list_price_raw: p.attributes?.list_price || 'NOT_FOUND',
      salesRanks_raw: p.salesRanks || 'NOT_FOUND',
      extractedRank: extractRank(p.salesRanks),
      image: p.images?.[0]?.images?.[0]?.link || 'NOT_FOUND',
      topLevelKeys: Object.keys(p),
    }));
    res.json({ totalItems: items.length, itemDebug });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Debug Amazon suggest
app.get('/api/debug-amazon-suggest', async (req, res) => {
  const q = req.query.q || 'vitamin supplement';
  try {
    const result = await httpsGet(
      'completion.amazon.com',
      `/search/complete?search-alias=aps&client=amazon-search-ui&mkt=1&q=${encodeURIComponent(q)}`,
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': 'https://www.amazon.com/',
        'Origin': 'https://www.amazon.com'
      }
    );
    res.json({
      query: q,
      httpStatus: result.status,
      dataType: typeof result.data,
      isArray: Array.isArray(result.data),
      dataPreview: typeof result.data === 'string' ? result.data.slice(0, 500) : result.data,
      suggestions: Array.isArray(result.data) ? result.data[1] : 'not_array'
    });
  } catch(e) {
    res.json({ query: q, error: e.message });
  }
});

// ──── KEYWORD INTELLIGENCE ────

const STOP_WORDS = new Set([
  'the','a','an','and','or','for','with','in','of','to','by','is','it','at','on','as','from','that','this',
  'mg','mcg','count','caps','capsule','capsules','tablet','tablets','softgel','softgels','gummy','gummies',
  'supplement','supplements','serving','servings','supply','day','days','month','months','week','weeks',
  'made','usa','pack','per','oz','fl','lb','lbs','each','size','ct','bottle','bottles',
  'non','gmo','free','gluten','vegan','organic','natural','premium','extra','strength',
  'men','women','adult','adults','kids','children','unflavored','flavor','flavored',
  // Marketing/generic terms that don't differentiate products
  'support','health','healthy','formula','plus','advanced','ultra','super','best','high','potency',
  'quality','pure','essential','daily','maximum','max','pro','complete','complex','enhanced',
  'original','new','now','brand','one','two','three','help','helps','body','contains',
  'includes','also','may','well','good','great','just','like','all','more','most','very',
  'dietary','nutrition','nutritional','intake','recommended','doctor','approved','tested',
  'third','party','verified','certified','lab','manufactured','facility','gmp','cgmp',
  'easy','swallow','take','form','based','plant','derived','source','sourced','added',
  'food','grade','value','bonus','deal','sale','price','offer','special','limited',
  'amazon','choice','seller','rated','star','stars','review','reviews',
  'immune','energy','bone','joint','heart','brain','skin','hair','nail','nails','eye','eyes',
  'muscle','digestive','gut','sleep','mood','stress','weight','loss','management'
]);

function extractKeywords(title) {
  if (!title) return [];
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

function extractBigrams(words) {
  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(words[i] + ' ' + words[i + 1]);
  }
  return bigrams;
}

// Keyword Intelligence endpoint - deep analysis of product title keywords
app.get('/api/keyword-intelligence', (req, res) => {
  if (!trendsCache) return res.json({ error: 'Load trends data first', keywords: [], bigrams: [], categoryKeywords: {}, hashtags: [] });

  const allProducts = [];
  const categoryProducts = {};
  Object.entries(trendsCache.categories || {}).forEach(([catId, cat]) => {
    categoryProducts[catId] = [];
    (cat.topProducts || []).forEach(p => {
      allProducts.push({ ...p, category: catId });
      categoryProducts[catId].push(p);
    });
  });

  // 1. Single keyword frequency
  const kwCounts = {};
  const kwByCategory = {};
  allProducts.forEach(p => {
    const words = extractKeywords(p.title);
    const seen = new Set();
    words.forEach(w => {
      kwCounts[w] = (kwCounts[w] || 0) + 1;
      if (!seen.has(w)) {
        seen.add(w);
        if (!kwByCategory[w]) kwByCategory[w] = new Set();
        kwByCategory[w].add(p.category);
      }
    });
  });

  // 2. Bigram frequency
  const bigramCounts = {};
  allProducts.forEach(p => {
    const words = extractKeywords(p.title);
    extractBigrams(words).forEach(bg => {
      bigramCounts[bg] = (bigramCounts[bg] || 0) + 1;
    });
  });

  // 3. Keywords sorted by frequency
  const topKeywords = Object.entries(kwCounts)
    .map(([keyword, count]) => ({
      keyword,
      count,
      density: +(count / allProducts.length * 100).toFixed(1),
      categorySpread: kwByCategory[keyword]?.size || 1,
      crossCategory: (kwByCategory[keyword]?.size || 1) >= 3
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 150);

  // 4. Top bigrams
  const topBigrams = Object.entries(bigramCounts)
    .map(([bigram, count]) => ({ bigram, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 80);

  // 5. Per-category keyword analysis (top keywords per category)
  const catKeywordAnalysis = {};
  Object.entries(categoryProducts).forEach(([catId, products]) => {
    const catKW = {};
    products.forEach(p => {
      extractKeywords(p.title).forEach(w => {
        catKW[w] = (catKW[w] || 0) + 1;
      });
    });
    catKeywordAnalysis[catId] = Object.entries(catKW)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([keyword, count]) => ({ keyword, count }));
  });

  // 6. Trending ingredient detection (keywords appearing across many categories = trending)
  const trendingIngredients = topKeywords
    .filter(k => k.categorySpread >= 3 && k.count >= 5)
    .sort((a, b) => b.categorySpread - a.categorySpread || b.count - a.count)
    .slice(0, 30);

  // 7. Generate hashtags from trending keywords
  const hashtags = trendingIngredients.slice(0, 20).map(k => ({
    tag: '#' + k.keyword.charAt(0).toUpperCase() + k.keyword.slice(1),
    count: k.count,
    spread: k.categorySpread,
    momentum: Math.round((k.categorySpread / Object.keys(categoryProducts).length) * 100)
  }));

  // 8. Form trend analysis
  const formPatterns = {
    'Gummy': /gumm(y|ies)/i, 'Capsule': /capsule/i, 'Softgel': /softgel/i,
    'Tablet': /tablet/i, 'Powder': /powder/i, 'Liquid': /liquid|drop/i,
    'Chewable': /chewable/i, 'Spray': /spray/i, 'Lozenge': /lozenge/i
  };
  const formTrends = {};
  allProducts.forEach(p => {
    Object.entries(formPatterns).forEach(([form, regex]) => {
      if (regex.test(p.title)) {
        if (!formTrends[form]) formTrends[form] = { count: 0, categories: new Set() };
        formTrends[form].count++;
        formTrends[form].categories.add(p.category);
      }
    });
  });
  const formAnalysis = Object.entries(formTrends)
    .map(([form, data]) => ({ form, count: data.count, categoryCount: data.categories.size }))
    .sort((a, b) => b.count - a.count);

  // 9. Price tier keyword analysis (which keywords appear in premium vs budget products)
  const premiumKeywords = {};
  const budgetKeywords = {};
  allProducts.forEach(p => {
    const words = extractKeywords(p.title);
    if (p.price > 30) words.forEach(w => { premiumKeywords[w] = (premiumKeywords[w] || 0) + 1; });
    if (p.price && p.price < 15) words.forEach(w => { budgetKeywords[w] = (budgetKeywords[w] || 0) + 1; });
  });

  const premiumOnlyKW = Object.entries(premiumKeywords)
    .filter(([kw]) => !budgetKeywords[kw] || premiumKeywords[kw] > budgetKeywords[kw] * 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([keyword, count]) => ({ keyword, count }));

  const budgetOnlyKW = Object.entries(budgetKeywords)
    .filter(([kw]) => !premiumKeywords[kw] || budgetKeywords[kw] > premiumKeywords[kw] * 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([keyword, count]) => ({ keyword, count }));

  // 10. Niche analysis - specific sub-types within each category
  const nicheAnalysis = {};
  const NICHE_PATTERNS = {
    protein: [
      { niche: 'Whey Isolate', pattern: /whey\s*(protein\s*)?isolate/i },
      { niche: 'Whey Concentrate', pattern: /whey\s*(protein\s*)?(concentrate|blend)/i },
      { niche: 'Plant-Based Protein', pattern: /plant[\s-]*(based|protein)|pea\s*protein|hemp\s*protein|soy\s*protein|rice\s*protein/i },
      { niche: 'Casein', pattern: /casein/i },
      { niche: 'Collagen Protein', pattern: /collagen\s*protein|collagen\s*peptide/i },
      { niche: 'Mass Gainer', pattern: /mass\s*gain|weight\s*gain|bulk/i },
      { niche: 'Meal Replacement', pattern: /meal\s*replace|shake\s*mix/i },
      { niche: 'Protein Bars', pattern: /protein\s*bar/i },
      { niche: 'Egg White Protein', pattern: /egg\s*(white\s*)?protein/i },
      { niche: 'Bone Broth Protein', pattern: /bone\s*broth/i },
    ],
    probiotics: [
      { niche: 'Multi-Strain (50B+ CFU)', pattern: /(?:50|60|70|80|90|100)\s*billion/i },
      { niche: 'Multi-Strain (Standard)', pattern: /(?:10|15|20|25|30|40)\s*billion/i },
      { niche: 'Women Probiotic', pattern: /women|feminine|vaginal|cranberry.*probiotic|probiotic.*cranberry/i },
      { niche: 'Kids Probiotic', pattern: /kids|children|child|toddler/i },
      { niche: 'Prebiotic + Probiotic', pattern: /prebiotic.*probiotic|probiotic.*prebiotic|synbiotic/i },
      { niche: 'Spore-Based', pattern: /spore|bacillus/i },
      { niche: 'Saccharomyces', pattern: /saccharomyces|boulardii/i },
      { niche: 'Soil-Based (SBO)', pattern: /soil[\s-]*based|sbo/i },
    ],
    collagen: [
      { niche: 'Marine Collagen', pattern: /marine|fish\s*collagen/i },
      { niche: 'Bovine Collagen', pattern: /bovine|grass[\s-]*fed\s*collagen/i },
      { niche: 'Multi-Collagen (Type I,II,III)', pattern: /multi[\s-]*collagen|type\s*(?:i|1|ii|2|iii|3)/i },
      { niche: 'Collagen Powder', pattern: /collagen\s*(?:powder|peptide)/i },
      { niche: 'Collagen Gummies', pattern: /collagen\s*gumm/i },
      { niche: 'Collagen + Biotin', pattern: /collagen.*biotin|biotin.*collagen/i },
    ],
    creatine: [
      { niche: 'Creatine Monohydrate', pattern: /monohydrate/i },
      { niche: 'Creatine HCL', pattern: /hcl|hydrochloride/i },
      { niche: 'Micronized Creatine', pattern: /micronized/i },
      { niche: 'Creatine Gummies', pattern: /creatine\s*gumm/i },
      { niche: 'Creatine + Electrolytes', pattern: /creatine.*electrolyte|electrolyte.*creatine/i },
    ],
    vitaminD: [
      { niche: 'D3 5000 IU', pattern: /5[,.]?000\s*(?:iu|mcg)/i },
      { niche: 'D3 10000 IU', pattern: /10[,.]?000\s*iu/i },
      { niche: 'D3 + K2', pattern: /d3.*k2|k2.*d3/i },
      { niche: 'Liquid D3', pattern: /liquid.*(?:d3|vitamin\s*d)|(?:d3|vitamin\s*d).*(?:liquid|drop)/i },
      { niche: 'D3 Gummies', pattern: /(?:d3|vitamin\s*d).*gumm/i },
    ],
    ashwagandha: [
      { niche: 'KSM-66', pattern: /ksm[\s-]*66/i },
      { niche: 'Sensoril', pattern: /sensoril/i },
      { niche: 'Ashwagandha Root', pattern: /root\s*(extract|powder)/i },
      { niche: 'Ashwagandha Gummies', pattern: /ashwagandha.*gumm/i },
      { niche: 'Ashwagandha + Black Pepper', pattern: /ashwagandha.*(?:black\s*pepper|bioperine|piperine)/i },
    ],
    magnesium: [
      { niche: 'Magnesium Glycinate', pattern: /glycinate|bisglycinate/i },
      { niche: 'Magnesium Citrate', pattern: /citrate/i },
      { niche: 'Magnesium L-Threonate', pattern: /threonate|magtein/i },
      { niche: 'Magnesium Complex', pattern: /complex|(?:7|8)\s*(?:form|type)/i },
      { niche: 'Magnesium Oxide', pattern: /oxide/i },
      { niche: 'Magnesium Taurate', pattern: /taurate/i },
    ],
    omega: [
      { niche: 'Triple Strength Fish Oil', pattern: /triple\s*strength|3600|3000/i },
      { niche: 'EPA/DHA Concentrated', pattern: /(?:epa|dha)\s*(?:\d{3,4})/i },
      { niche: 'Krill Oil', pattern: /krill/i },
      { niche: 'Algae-Based Omega', pattern: /algae|algal|vegan\s*omega/i },
      { niche: 'Omega-3 Gummies', pattern: /omega.*gumm/i },
    ],
    turmeric: [
      { niche: 'Turmeric + Black Pepper', pattern: /turmeric.*(?:bioperine|black\s*pepper|piperine)/i },
      { niche: 'Turmeric + Ginger', pattern: /turmeric.*ginger|ginger.*turmeric/i },
      { niche: 'Curcumin Extract', pattern: /curcumin\s*(?:extract|95)/i },
      { niche: 'Liquid Turmeric', pattern: /liquid.*turmeric|turmeric.*liquid/i },
    ],
  };
  // Generic niche detection for categories without specific patterns
  const genericNichePatterns = [
    { niche: 'Liquid/Drops', pattern: /liquid|drop(?:s)?/i },
    { niche: 'Gummies', pattern: /gumm(?:y|ies)/i },
    { niche: 'Powder', pattern: /powder/i },
    { niche: 'Softgels', pattern: /softgel/i },
    { niche: 'With Black Pepper', pattern: /bioperine|black\s*pepper|piperine/i },
    { niche: 'High Potency', pattern: /(?:1[0-9]{3,}|[2-9]\d{3,})\s*(?:mg|iu)/i },
    { niche: 'Bundle/Multi-Pack', pattern: /(?:2|3|4)\s*(?:pack|bottle|count)|bundle/i },
  ];

  Object.entries(categoryProducts).forEach(([catId, products]) => {
    const patterns = NICHE_PATTERNS[catId] || genericNichePatterns;
    const niches = {};
    products.forEach(p => {
      let matched = false;
      patterns.forEach(({ niche, pattern }) => {
        if (pattern.test(p.title)) {
          if (!niches[niche]) niches[niche] = { count: 0, prices: [], ranks: [], products: [] };
          niches[niche].count++;
          if (p.price) niches[niche].prices.push(p.price);
          if (p.rank) niches[niche].ranks.push(p.rank);
          if (niches[niche].products.length < 3) niches[niche].products.push({ title: p.title, price: p.price, rank: p.rank });
          matched = true;
        }
      });
      if (!matched) {
        if (!niches['Other/General']) niches['Other/General'] = { count: 0, prices: [], ranks: [], products: [] };
        niches['Other/General'].count++;
        if (p.price) niches['Other/General'].prices.push(p.price);
      }
    });

    nicheAnalysis[catId] = Object.entries(niches)
      .map(([niche, data]) => ({
        niche,
        count: data.count,
        share: Math.round((data.count / products.length) * 100),
        avgPrice: data.prices.length ? +(data.prices.reduce((a, b) => a + b, 0) / data.prices.length).toFixed(2) : 0,
        minPrice: data.prices.length ? +Math.min(...data.prices).toFixed(2) : 0,
        maxPrice: data.prices.length ? +Math.max(...data.prices).toFixed(2) : 0,
        avgRank: data.ranks.length ? Math.round(data.ranks.reduce((a, b) => a + b, 0) / data.ranks.length) : null,
        topProducts: data.products || [],
        competition: data.count >= 5 ? 'High' : data.count >= 2 ? 'Medium' : 'Low',
      }))
      .filter(n => n.niche !== 'Other/General' || n.count >= 2)
      .sort((a, b) => b.count - a.count);
  });

  res.json({
    totalProducts: allProducts.length,
    totalCategories: Object.keys(categoryProducts).length,
    topKeywords,
    topBigrams,
    categoryKeywords: catKeywordAnalysis,
    trendingIngredients,
    hashtags,
    formAnalysis,
    premiumKeywords: premiumOnlyKW,
    budgetKeywords: budgetOnlyKW,
    nicheAnalysis,
    timestamp: new Date().toISOString()
  });
});

// Google Autocomplete suggestions endpoint
app.get('/api/google-suggest', async (req, res) => {
  const q = req.query.q || 'supplement';
  try {
    const result = await httpsGet(
      'suggestqueries.google.com',
      `/complete/search?client=firefox&q=${encodeURIComponent(q)}`,
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    );
    const suggestions = Array.isArray(result.data) ? result.data[1] || [] : [];
    res.json({ query: q, suggestions });
  } catch(e) {
    res.json({ query: q, suggestions: [], error: e.message });
  }
});

// Google Trends - batch keyword suggestions for supplement categories
app.get('/api/trend-keywords', async (req, res) => {
  const seedKeywords = [
    'supplement trending', 'best supplement 2025', 'new supplement',
    'health supplement popular', 'vitamin trending', 'superfood supplement',
    'nootropic supplement', 'gut health supplement', 'collagen supplement trending',
    'mushroom supplement', 'peptide supplement', 'longevity supplement'
  ];

  try {
    const allSuggestions = [];
    for (let i = 0; i < seedKeywords.length; i++) {
      try {
        const result = await httpsGet(
          'suggestqueries.google.com',
          `/complete/search?client=firefox&q=${encodeURIComponent(seedKeywords[i])}`,
          { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        );
        const suggestions = Array.isArray(result.data) ? result.data[1] || [] : [];
        suggestions.forEach(s => {
          if (!allSuggestions.includes(s)) allSuggestions.push(s);
        });
      } catch(e) { /* skip failed requests */ }
      if (i < seedKeywords.length - 1) await new Promise(r => setTimeout(r, 200));
    }

    // Extract trending keywords from suggestions
    const kwFreq = {};
    allSuggestions.forEach(suggestion => {
      const words = suggestion.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
      words.forEach(w => { kwFreq[w] = (kwFreq[w] || 0) + 1; });
    });

    const trendingKeywords = Object.entries(kwFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([keyword, count]) => ({ keyword, count, source: 'google' }));

    res.json({
      suggestions: allSuggestions,
      trendingKeywords,
      seedQueries: seedKeywords.length,
      timestamp: new Date().toISOString()
    });
  } catch(e) {
    res.json({ suggestions: [], trendingKeywords: [], error: e.message });
  }
});

// ──── GOOGLE TRENDS (via google-trends-api npm or scraping) ────

let googleTrendsCache = null;
let googleTrendsCacheTime = 0;
const GOOGLE_TRENDS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// [VitaView v2] Google Trends - npm 패키지 기반 안정화 함수
const googleTrends = require('google-trends-api');

async function getGoogleTrendsData(keyword) {
  try {
    const result = await googleTrends.interestOverTime({
      keyword: keyword,
      startTime: new Date(Date.now() - (180 * 24 * 60 * 60 * 1000)),
      hl: 'en-US',
      geo: 'US'
    });

    const parsed = JSON.parse(result);
    const timelineData = parsed.default.timelineData;

    const recent3m = timelineData.slice(-13).map(d => d.value[0]);
    const prev3m = timelineData.slice(-26, -13).map(d => d.value[0]);

    const recent3mAvg = recent3m.reduce((a, b) => a + b, 0) / recent3m.length;
    const prev3mAvg = prev3m.reduce((a, b) => a + b, 0) / prev3m.length;
    const growthRate = prev3mAvg > 0 ? ((recent3mAvg - prev3mAvg) / prev3mAvg) * 100 : 0;

    // [VitaView v2] DB에 저장
    try {
      saveTrendSnapshot({
        keyword, category: 'google_trends',
        google_trends_value: recent3m[recent3m.length - 1],
        google_trends_3m_avg: recent3mAvg,
        google_trends_prev_3m_avg: prev3mAvg,
        trend_growth_rate: growthRate,
        opportunity_score: 0, verdict: ''
      });
    } catch(e) { /* DB 저장 실패 무시 */ }

    return {
      currentValue: recent3m[recent3m.length - 1],
      recent3mAvg, prev3mAvg, growthRate,
      isRising: growthRate > 0,
      rawData: timelineData
    };
  } catch (error) {
    // [VitaView v2] 실패 시 DB에서 마지막 저장 데이터 fallback
    const lastSnapshot = getLastTrendSnapshot(keyword);
    if (lastSnapshot) {
      return {
        currentValue: lastSnapshot.google_trends_value,
        recent3mAvg: lastSnapshot.google_trends_3m_avg,
        growthRate: lastSnapshot.trend_growth_rate,
        isRising: lastSnapshot.trend_growth_rate > 0,
        fromCache: true,
        cacheDate: lastSnapshot.created_at
      };
    }
    throw error;
  }
}

// [VitaView v2] 데이터 신뢰도 계산
function calculateDataConfidence(data) {
  const signals = {
    googleTrends: { available: !!data.trends, fromCache: data.trends?.fromCache || false, sampleSize: data.trends?.rawData?.length || 0, weight: 0.25 },
    reddit: { available: !!data.reddit, sampleSize: data.reddit?.mentionCount || 0, sufficient: (data.reddit?.mentionCount || 0) >= 20, weight: 0.25 },
    youtube: { available: !!data.youtube, sampleSize: data.youtube?.videoCount || 0, sufficient: (data.youtube?.videoCount || 0) >= 5, weight: 0.20 },
    amazonBSR: { available: !!data.bsr, weight: 0.20 },
    patents: { available: !!data.patents, weight: 0.10 }
  };

  let confidenceScore = 0;
  const warnings = [];

  Object.entries(signals).forEach(([source, info]) => {
    if (!info.available) {
      warnings.push(`${source} 데이터 없음 - 해당 항목 점수 제외됨`);
    } else if (info.fromCache) {
      confidenceScore += info.weight * 0.5;
      warnings.push(`${source} 캐시 데이터 사용 중`);
    } else if (info.sufficient === false) {
      confidenceScore += info.weight * 0.6;
      warnings.push(`${source} 샘플 부족 (${info.sampleSize}개) - 신뢰도 낮음`);
    } else {
      confidenceScore += info.weight;
    }
  });

  return {
    score: Math.round(confidenceScore * 100),
    level: confidenceScore >= 0.8 ? '높음' : confidenceScore >= 0.5 ? '보통' : '낮음',
    warnings
  };
}

app.get('/api/market-intel/google-trends', async (req, res) => {
  if (googleTrendsCache && Date.now() - googleTrendsCacheTime < GOOGLE_TRENDS_CACHE_TTL) {
    return res.json(googleTrendsCache);
  }
  const keywords = (req.query.keywords || 'ashwagandha,creatine,sea moss,berberine,lions mane').split(',').map(k => k.trim());

  try {
    // Use Google Trends explore endpoint via scraping
    const results = [];
    for (const keyword of keywords.slice(0, 5)) {
      try {
        // Google Trends widget token request
        const widgetUrl = `/trends/api/explore?hl=en-US&tz=240&req=${encodeURIComponent(JSON.stringify({
          comparisonItem: [{ keyword, geo: 'US', time: 'today 12-m' }],
          category: 0, property: ''
        }))}&tz=240`;

        const widgetRes = await httpsGet('trends.google.com', widgetUrl, {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });

        // Parse widget response (remove leading )]}' characters)
        let widgetData = typeof widgetRes.data === 'string' ? widgetRes.data : JSON.stringify(widgetRes.data);
        widgetData = widgetData.replace(/^\)\]\}',?\n?/, '');

        try {
          const parsed = JSON.parse(widgetData);
          const timeWidget = parsed.widgets?.find(w => w.id === 'TIMESERIES');
          const relatedWidget = parsed.widgets?.find(w => w.id === 'RELATED_QUERIES');

          if (timeWidget) {
            // Fetch interest over time
            const timeReq = encodeURIComponent(JSON.stringify(timeWidget.request));
            const timeToken = timeWidget.token;
            const timeRes = await httpsGet('trends.google.com',
              `/trends/api/widgetdata/multiline?hl=en-US&tz=240&req=${timeReq}&token=${timeToken}`,
              { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            );
            let timeData = typeof timeRes.data === 'string' ? timeRes.data : JSON.stringify(timeRes.data);
            timeData = timeData.replace(/^\)\]\}',?\n?/, '');
            try {
              const timeParsed = JSON.parse(timeData);
              const points = timeParsed.default?.timelineData?.map(p => ({
                date: p.formattedTime,
                value: p.value?.[0] || 0
              })) || [];
              results.push({ keyword, interestOverTime: points, status: 'ok' });
            } catch(e) {
              results.push({ keyword, interestOverTime: [], status: 'parse_error' });
            }
          } else {
            results.push({ keyword, interestOverTime: [], status: 'no_widget' });
          }
        } catch(e) {
          results.push({ keyword, interestOverTime: [], status: 'parse_error' });
        }
      } catch(e) {
        results.push({ keyword, interestOverTime: [], status: 'error', error: e.message });
      }
      // Rate limit
      await new Promise(r => setTimeout(r, 500));
    }

    // Also get Google Suggest for trending supplement terms
    const suggestKeywords = ['trending supplement 2026', 'best supplement', 'new supplement ingredient', 'viral supplement tiktok'];
    const suggestions = [];
    for (const sq of suggestKeywords) {
      try {
        const sgRes = await httpsGet('suggestqueries.google.com',
          `/complete/search?client=firefox&q=${encodeURIComponent(sq)}`,
          { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        );
        const sgs = Array.isArray(sgRes.data) ? sgRes.data[1] || [] : [];
        sgs.forEach(s => { if (!suggestions.includes(s)) suggestions.push(s); });
      } catch(e) {}
      await new Promise(r => setTimeout(r, 200));
    }

    const responseData = {
      trends: results,
      suggestions,
      queriedAt: new Date().toISOString(),
      source: 'google-trends'
    };
    googleTrendsCache = responseData;
    googleTrendsCacheTime = Date.now();
    res.json(responseData);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ──── YOUTUBE DATA API v3 ────

let youtubeCache = null;
let youtubeCacheTime = 0;
const YOUTUBE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

app.get('/api/market-intel/youtube', async (req, res) => {
  if (youtubeCache && Date.now() - youtubeCacheTime < YOUTUBE_CACHE_TTL && !req.query.refresh) {
    return res.json(youtubeCache);
  }

  const apiKey = YOUTUBE_API_KEY;
  if (!apiKey) {
    // Demo mode - return curated demo data
    const demoData = {
      videos: [
        { title: 'Top 10 Supplements You NEED in 2026', channel: 'Dr. Health', views: 2450000, publishedAt: '2026-02-15', thumbnail: null, videoId: 'demo1' },
        { title: 'Ashwagandha: What They Don\'t Tell You', channel: 'Supplement Reviews', views: 1830000, publishedAt: '2026-03-01', thumbnail: null, videoId: 'demo2' },
        { title: 'Why Creatine is the #1 Supplement', channel: 'FitScience', views: 1560000, publishedAt: '2026-02-20', thumbnail: null, videoId: 'demo3' },
        { title: 'Sea Moss Benefits: Real or Hype?', channel: 'NutriFacts', views: 980000, publishedAt: '2026-03-05', thumbnail: null, videoId: 'demo4' },
        { title: 'Lion\'s Mane Mushroom - 90 Day Results', channel: 'BioHacker', views: 870000, publishedAt: '2026-02-28', thumbnail: null, videoId: 'demo5' },
        { title: 'Berberine: Nature\'s Ozempic?', channel: 'Dr. Wellness', views: 2100000, publishedAt: '2026-01-20', thumbnail: null, videoId: 'demo6' },
        { title: 'Magnesium Glycinate Changed My Sleep', channel: 'SleepBetter', views: 650000, publishedAt: '2026-03-10', thumbnail: null, videoId: 'demo7' },
        { title: 'NMN vs NAD+ - Anti-Aging Supplements', channel: 'LongevityLab', views: 1200000, publishedAt: '2026-02-10', thumbnail: null, videoId: 'demo8' },
      ],
      trendingIngredients: [
        { name: 'Ashwagandha', mentions: 45, momentum: 85 },
        { name: 'Creatine', mentions: 42, momentum: 78 },
        { name: 'Berberine', mentions: 38, momentum: 92 },
        { name: 'Sea Moss', mentions: 35, momentum: 88 },
        { name: "Lion's Mane", mentions: 32, momentum: 82 },
        { name: 'Magnesium', mentions: 30, momentum: 70 },
        { name: 'NMN', mentions: 28, momentum: 95 },
        { name: 'Collagen', mentions: 25, momentum: 60 },
      ],
      mode: 'demo',
      queriedAt: new Date().toISOString(),
      source: 'youtube-demo'
    };
    return res.json(demoData);
  }

  try {
    const searchQueries = [
      'best supplements 2026', 'trending supplements', 'supplement review',
      'new supplement ingredients', 'supplement tier list'
    ];
    const allVideos = [];

    for (const query of searchQueries) {
      try {
        const searchRes = await httpsGet('www.googleapis.com',
          `/youtube/v3/search?key=${apiKey}&q=${encodeURIComponent(query)}&type=video&order=viewCount&maxResults=5&part=snippet&publishedAfter=${new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()}`,
          {}
        );
        const items = searchRes.data?.items || [];
        const videoIds = items.map(i => i.id?.videoId).filter(Boolean);

        // Get view counts
        if (videoIds.length > 0) {
          const statsRes = await httpsGet('www.googleapis.com',
            `/youtube/v3/videos?key=${apiKey}&id=${videoIds.join(',')}&part=statistics,snippet`,
            {}
          );
          (statsRes.data?.items || []).forEach(v => {
            allVideos.push({
              title: v.snippet?.title,
              channel: v.snippet?.channelTitle,
              views: parseInt(v.statistics?.viewCount || 0),
              likes: parseInt(v.statistics?.likeCount || 0),
              comments: parseInt(v.statistics?.commentCount || 0),
              publishedAt: v.snippet?.publishedAt,
              thumbnail: v.snippet?.thumbnails?.medium?.url,
              videoId: v.id
            });
          });
        }
      } catch(e) { /* skip failed queries */ }
      await new Promise(r => setTimeout(r, 200));
    }

    // Deduplicate by videoId
    const seen = new Set();
    const uniqueVideos = allVideos.filter(v => {
      if (seen.has(v.videoId)) return false;
      seen.add(v.videoId);
      return true;
    }).sort((a, b) => b.views - a.views).slice(0, 20);

    // Extract trending ingredients from video titles
    const ingredientPatterns = Object.keys(CATEGORY_KEYWORDS);
    const ingredientMentions = {};
    uniqueVideos.forEach(v => {
      const titleLower = (v.title || '').toLowerCase();
      ingredientPatterns.forEach(ing => {
        const searchTerm = ing.replace(/_/g, ' ').toLowerCase();
        if (titleLower.includes(searchTerm)) {
          ingredientMentions[ing] = (ingredientMentions[ing] || 0) + 1;
        }
      });
    });

    const trendingIngredients = Object.entries(ingredientMentions)
      .map(([name, mentions]) => ({ name, mentions, momentum: Math.min(100, mentions * 15 + Math.random() * 20) }))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 15);

    const responseData = {
      videos: uniqueVideos,
      trendingIngredients,
      mode: 'live',
      queriedAt: new Date().toISOString(),
      source: 'youtube'
    };
    youtubeCache = responseData;
    youtubeCacheTime = Date.now();
    res.json(responseData);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ──── REDDIT API (public JSON, no auth needed) ────

let redditCache = null;
let redditCacheTime = 0;
const REDDIT_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

app.get('/api/market-intel/reddit', async (req, res) => {
  if (redditCache && Date.now() - redditCacheTime < REDDIT_CACHE_TTL && !req.query.refresh) {
    return res.json(redditCache);
  }

  const subreddits = ['supplements', 'nootropics', 'nutrition', 'Fitness'];
  const allPosts = [];

  try {
    for (const sub of subreddits) {
      try {
        const result = await httpsGet('www.reddit.com',
          `/r/${sub}/hot.json?limit=15`,
          { 'User-Agent': 'VitaView/1.0 (supplement market research)' }
        );
        const posts = result.data?.data?.children || [];
        posts.forEach(p => {
          const d = p.data;
          if (d && !d.stickied) {
            allPosts.push({
              title: d.title,
              subreddit: d.subreddit,
              score: d.score,
              numComments: d.num_comments,
              url: `https://reddit.com${d.permalink}`,
              created: new Date(d.created_utc * 1000).toISOString(),
              author: d.author,
              selftext: (d.selftext || '').slice(0, 300)
            });
          }
        });
      } catch(e) {
        console.log(`Reddit r/${sub} fetch error:`, e.message);
      }
      await new Promise(r => setTimeout(r, 1000)); // Reddit rate limit
    }

    // Sort by score
    allPosts.sort((a, b) => b.score - a.score);

    // Extract mentioned supplements from titles
    const supplementMentions = {};
    const ingredientNames = Object.entries(CATEGORY_KEYWORDS).map(([id, kw]) => ({
      id, searchTerms: [id.replace(/_/g, ' '), kw.split(' ')[0]]
    }));

    allPosts.forEach(post => {
      const text = (post.title + ' ' + post.selftext).toLowerCase();
      ingredientNames.forEach(({ id, searchTerms }) => {
        if (searchTerms.some(term => text.includes(term.toLowerCase()))) {
          if (!supplementMentions[id]) supplementMentions[id] = { count: 0, totalScore: 0, posts: [] };
          supplementMentions[id].count++;
          supplementMentions[id].totalScore += post.score;
          if (supplementMentions[id].posts.length < 3) {
            supplementMentions[id].posts.push({ title: post.title, score: post.score, subreddit: post.subreddit });
          }
        }
      });
    });

    const trendingOnReddit = Object.entries(supplementMentions)
      .map(([name, data]) => ({ name, ...data, avgScore: Math.round(data.totalScore / data.count) }))
      .sort((a, b) => b.count - a.count || b.totalScore - a.totalScore)
      .slice(0, 20);

    // Sentiment keywords
    const sentimentWords = {
      positive: ['love', 'amazing', 'best', 'great', 'recommend', 'works', 'helped', 'effective', 'changed', 'excellent'],
      negative: ['waste', 'scam', 'terrible', 'side effects', 'dangerous', 'fake', 'doesn\'t work', 'overpriced', 'avoid', 'warning']
    };
    let positiveCount = 0, negativeCount = 0;
    allPosts.forEach(p => {
      const text = (p.title + ' ' + p.selftext).toLowerCase();
      sentimentWords.positive.forEach(w => { if (text.includes(w)) positiveCount++; });
      sentimentWords.negative.forEach(w => { if (text.includes(w)) negativeCount++; });
    });

    const responseData = {
      posts: allPosts.slice(0, 30),
      trendingSupplements: trendingOnReddit,
      subreddits: subreddits.map(s => `r/${s}`),
      sentiment: {
        positive: positiveCount,
        negative: negativeCount,
        ratio: positiveCount + negativeCount > 0 ? +(positiveCount / (positiveCount + negativeCount) * 100).toFixed(1) : 50
      },
      totalPosts: allPosts.length,
      queriedAt: new Date().toISOString(),
      source: 'reddit'
    };
    redditCache = responseData;
    redditCacheTime = Date.now();
    res.json(responseData);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ──── OpenFDA API (completely free, no key needed) ────

let fdaCache = {};
const FDA_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

app.get('/api/market-intel/fda', async (req, res) => {
  const ingredient = req.query.ingredient || 'supplement';
  const cacheKey = ingredient.toLowerCase();

  if (fdaCache[cacheKey] && Date.now() - fdaCache[cacheKey].time < FDA_CACHE_TTL) {
    return res.json(fdaCache[cacheKey].data);
  }

  try {
    const results = {};

    // 1. Adverse events (side effects reports)
    try {
      const aeRes = await httpsGet('api.fda.gov',
        `/food/event.json?search=products.name_brand:"${encodeURIComponent(ingredient)}"&limit=5`,
        {}
      );
      results.adverseEvents = {
        total: aeRes.data?.meta?.results?.total || 0,
        recent: (aeRes.data?.results || []).map(r => ({
          date: r.date_started,
          outcomes: r.outcomes || [],
          reactions: (r.reactions || []).slice(0, 5),
          products: (r.products || []).map(p => p.name_brand).slice(0, 3)
        }))
      };
    } catch(e) {
      results.adverseEvents = { total: 0, recent: [], error: e.message };
    }

    // 2. Recall/enforcement data
    try {
      const recallRes = await httpsGet('api.fda.gov',
        `/food/enforcement.json?search=reason_for_recall:"${encodeURIComponent(ingredient)}"+product_description:"${encodeURIComponent(ingredient)}"&limit=5&sort=recall_initiation_date:desc`,
        {}
      );
      results.recalls = {
        total: recallRes.data?.meta?.results?.total || 0,
        recent: (recallRes.data?.results || []).map(r => ({
          date: r.recall_initiation_date,
          reason: r.reason_for_recall,
          classification: r.classification,
          status: r.status,
          company: r.recalling_firm
        }))
      };
    } catch(e) {
      results.recalls = { total: 0, recent: [], error: e.message };
    }

    // 3. Drug interactions (check if ingredient has drug interaction warnings)
    try {
      const drugRes = await httpsGet('api.fda.gov',
        `/drug/label.json?search=warnings:"${encodeURIComponent(ingredient)}"+active_ingredient:"${encodeURIComponent(ingredient)}"&limit=3`,
        {}
      );
      results.drugInteractions = {
        total: drugRes.data?.meta?.results?.total || 0,
        warnings: (drugRes.data?.results || []).map(r => ({
          brand: r.openfda?.brand_name?.[0] || 'Unknown',
          warnings: (r.warnings || []).slice(0, 2),
          interactions: (r.drug_interactions || []).slice(0, 2)
        }))
      };
    } catch(e) {
      results.drugInteractions = { total: 0, warnings: [] };
    }

    const responseData = {
      ingredient,
      ...results,
      safetyScore: calculateSafetyScore(results),
      queriedAt: new Date().toISOString(),
      source: 'openfda'
    };

    fdaCache[cacheKey] = { data: responseData, time: Date.now() };
    res.json(responseData);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

function calculateSafetyScore(results) {
  let score = 100;
  const ae = results.adverseEvents?.total || 0;
  const recalls = results.recalls?.total || 0;
  if (ae > 100) score -= 30;
  else if (ae > 50) score -= 20;
  else if (ae > 10) score -= 10;
  else if (ae > 0) score -= 5;
  if (recalls > 5) score -= 25;
  else if (recalls > 2) score -= 15;
  else if (recalls > 0) score -= 10;
  return Math.max(0, Math.min(100, score));
}

// Batch FDA check for multiple ingredients
app.get('/api/market-intel/fda-batch', async (req, res) => {
  const ingredients = (req.query.ingredients || 'ashwagandha,creatine,berberine,sea moss,lions mane').split(',').map(k => k.trim());
  const results = [];

  for (const ing of ingredients.slice(0, 10)) {
    try {
      const aeRes = await httpsGet('api.fda.gov',
        `/food/event.json?search=products.name_brand:"${encodeURIComponent(ing)}"&limit=1`,
        {}
      );
      const recallRes = await httpsGet('api.fda.gov',
        `/food/enforcement.json?search=reason_for_recall:"${encodeURIComponent(ing)}"+product_description:"${encodeURIComponent(ing)}"&limit=1`,
        {}
      );
      const aeTotal = aeRes.data?.meta?.results?.total || 0;
      const recallTotal = recallRes.data?.meta?.results?.total || 0;
      results.push({
        ingredient: ing,
        adverseEvents: aeTotal,
        recalls: recallTotal,
        safetyScore: calculateSafetyScore({ adverseEvents: { total: aeTotal }, recalls: { total: recallTotal } })
      });
    } catch(e) {
      results.push({ ingredient: ing, adverseEvents: 0, recalls: 0, safetyScore: 95 });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  res.json({ ingredients: results, queriedAt: new Date().toISOString(), source: 'openfda' });
});

// ──── MARKET INTELLIGENCE SUMMARY (combines all sources) ────

app.get('/api/market-intel/summary', async (req, res) => {
  try {
    const summary = {
      googleTrends: googleTrendsCache || null,
      youtube: youtubeCache || null,
      reddit: redditCache || null,
      spApi: trendsCache ? {
        totalCategories: Object.keys(trendsCache.categories || {}).length,
        topMovers: Object.entries(trendsCache.categories || {})
          .map(([id, cat]) => ({
            id,
            avgDailySales: cat.avgDailySales,
            revenue: cat.estimatedMonthlyRevenue,
            avgPrice: cat.avgPrice,
            topBrand: cat.topBrand
          }))
          .sort((a, b) => b.revenue - a.revenue)
          .slice(0, 10)
      } : null,
      queriedAt: new Date().toISOString()
    };
    res.json(summary);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Pre-fetch trends data function (reused by startup and API)
async function fetchTrendsData() {
  const entries = Object.entries(CATEGORY_KEYWORDS);
  const results = {};
  const fetches = await fetchInBatches(entries, 15, 800);
  for (const result of fetches) {
    if (result.status === 'fulfilled') {
      const { id, data } = result.value;
      const items = data.items || [];
      const prices = items.map(p => extractPrice(p.attributes)).filter(Boolean);
      const ranks = items.map(p => extractRank(p.salesRanks)).filter(Boolean);
      const brands = {};
      items.forEach(p => {
        const brand = p.attributes?.brand?.[0]?.value || 'Unknown';
        const priceVal = extractPrice(p.attributes) || 0;
        const rank = extractRank(p.salesRanks);
        const dailySales = estimateDailySales(rank);
        const monthlyRevenue = priceVal * dailySales * 30;
        if (!brands[brand]) brands[brand] = { count: 0, revenue: 0 };
        brands[brand].count += 1;
        brands[brand].revenue += monthlyRevenue;
      });
      const totalCatRevenue = Object.values(brands).reduce((sum, b) => sum + b.revenue, 0);
      const dailySalesArr = ranks.map(r => estimateDailySales(r));
      const avgDailySales = dailySalesArr.length ? Math.round(dailySalesArr.reduce((a, b) => a + b, 0) / dailySalesArr.length) : 0;
      const brandCount = Object.keys(brands).length;
      const totalBrandProducts = Object.values(brands).reduce((sum, b) => sum + b.count, 0);
      const hhi = totalBrandProducts > 0 ? Math.round(Object.values(brands).reduce((sum, b) => {
        const share = (b.count / totalBrandProducts) * 100;
        return sum + share * share;
      }, 0)) : 0;
      const topBrandEntry = Object.entries(brands).sort((a, b) => b[1].revenue - a[1].revenue)[0];
      const topBrandShare = topBrandEntry && totalCatRevenue > 0 ? Math.round((topBrandEntry[1].revenue / totalCatRevenue) * 100) : 0;
      results[id] = {
        totalProducts: data.numberOfResults || items.length,
        itemCount: items.length,
        avgPrice: prices.length ? +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : 0,
        minPrice: prices.length ? Math.min(...prices) : 0,
        maxPrice: prices.length ? Math.max(...prices) : 0,
        avgRank: ranks.length ? Math.round(ranks.reduce((a, b) => a + b, 0) / ranks.length) : 0,
        estimatedMonthlyRevenue: Math.round(totalCatRevenue),
        avgDailySales, brandCount, hhi,
        topBrand: topBrandEntry ? topBrandEntry[0] : 'N/A',
        topBrandShare,
        priceSpread: prices.length ? +(Math.max(...prices) - Math.min(...prices)).toFixed(2) : 0,
        brands,
        topProducts: items.map(p => ({
          asin: p.asin, title: p.summaries?.[0]?.itemName || 'Unknown',
          brand: p.attributes?.brand?.[0]?.value || 'Unknown',
          price: extractPrice(p.attributes), rank: extractRank(p.salesRanks),
          image: p.images?.[0]?.images?.[0]?.link || null
        })).filter(p => p.rank).sort((a, b) => a.rank - b.rank).slice(0, 100),
        priceDistribution: {
          under10: prices.filter(p => p < 10).length,
          '10to20': prices.filter(p => p >= 10 && p < 20).length,
          '20to30': prices.filter(p => p >= 20 && p < 30).length,
          '30to50': prices.filter(p => p >= 30 && p < 50).length,
          over50: prices.filter(p => p >= 50).length,
        }
      };
    }
  }
  return { categories: results, timestamp: new Date().toISOString() };
}

// ===== MODULE 1: Amazon Long-tail Keyword Extractor =====
let amazonSuggestCache = {};
const AMAZON_SUGGEST_CACHE_TTL = 60 * 60 * 1000; // 1 hour

app.get('/api/amazon-suggest', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ query: q, suggestions: [] });

  const cacheKey = q;
  if (amazonSuggestCache[cacheKey] && Date.now() - amazonSuggestCache[cacheKey].time < AMAZON_SUGGEST_CACHE_TTL) {
    return res.json(amazonSuggestCache[cacheKey].data);
  }

  try {
    const result = await httpsGet(
      'completion.amazon.com',
      `/search/complete?search-alias=aps&client=amazon-search-ui&mkt=1&q=${encodeURIComponent(q)}`,
      {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': 'https://www.amazon.com/',
        'Origin': 'https://www.amazon.com'
      }
    );
    console.log(`Amazon suggest for "${q}": status=${result.status}, type=${typeof result.data}, isArray=${Array.isArray(result.data)}`);
    let suggestions = [];
    if (Array.isArray(result.data)) {
      suggestions = result.data[1] || [];
    } else if (typeof result.data === 'string') {
      // Try parsing as JSON in case httpsGet didn't parse it
      try {
        const parsed = JSON.parse(result.data);
        suggestions = Array.isArray(parsed) ? (parsed[1] || []) : [];
      } catch(e) {
        console.log(`Amazon suggest parse error for "${q}":`, result.data?.slice?.(0, 200));
      }
    }
    const response = { query: q, suggestions, timestamp: new Date().toISOString() };
    if (suggestions.length > 0) {
      amazonSuggestCache[cacheKey] = { data: response, time: Date.now() };
    }
    res.json(response);
  } catch(e) {
    console.log(`Amazon suggest error for "${q}":`, e.message);
    res.json({ query: q, suggestions: [], error: e.message });
  }
});

// [VitaView v2] /api/longtail-keywords 삭제됨 - Keyword Intelligence 탭이 키워드 분석 담당

// ===== MODULE 2: Competitor Pain Point Analyzer =====
let painPointCache = {};
const PAINPOINT_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

// Pain point categories for rule-based NLP analysis
const PAINPOINT_PATTERNS = {
  taste: { keywords: ['taste', 'flavor', 'smell', 'disgusting', 'awful taste', 'chalky', 'bitter', 'nasty', 'gritty', 'horrible taste', 'aftertaste', 'stink', 'gross'], label: 'Taste / Flavor Issues' },
  efficacy: { keywords: ['doesn\'t work', 'no effect', 'useless', 'waste of money', 'did nothing', 'no difference', 'ineffective', 'snake oil', 'placebo', 'overhyped', 'not effective'], label: 'Efficacy Doubts' },
  sideEffects: { keywords: ['side effect', 'stomach', 'nausea', 'diarrhea', 'headache', 'rash', 'allergic', 'insomnia', 'anxiety', 'upset stomach', 'cramping', 'bloating', 'heartburn', 'jitter'], label: 'Side Effects' },
  quality: { keywords: ['fake', 'counterfeit', 'expired', 'contaminated', 'mold', 'broken seal', 'tampered', 'third party', 'heavy metal', 'lead', 'arsenic', 'impure', 'low quality'], label: 'Quality / Purity Concerns' },
  dosage: { keywords: ['too big', 'hard to swallow', 'pill size', 'horse pill', 'capsule size', 'dosage', 'too many pills', 'serving size', 'underdosed'], label: 'Dosage / Form Problems' },
  price: { keywords: ['overpriced', 'expensive', 'rip off', 'not worth', 'too expensive', 'cheaper', 'price increase', 'shrinkflation', 'less for more'], label: 'Price / Value' },
  packaging: { keywords: ['packaging', 'broken', 'leaked', 'damaged', 'bottle', 'seal', 'cap', 'arrived broken', 'melted', 'poor packaging'], label: 'Packaging Issues' },
  transparency: { keywords: ['proprietary blend', 'hidden ingredients', 'no lab test', 'no certificate', 'misleading', 'false claims', 'label', 'not what advertised'], label: 'Transparency / Trust' }
};

app.get('/api/painpoint-analysis', async (req, res) => {
  const category = req.query.category;
  if (!category) return res.json({ error: 'Category parameter required' });

  const cacheKey = category;
  if (painPointCache[cacheKey] && Date.now() - painPointCache[cacheKey].time < PAINPOINT_CACHE_TTL) {
    return res.json(painPointCache[cacheKey].data);
  }

  try {
    // Step 1: Get top products from SP-API (via trendsCache)
    const catData = trendsCache?.categories?.[category];
    const topProducts = catData?.topProducts?.slice(0, 10) || [];
    const catName = category.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim().toLowerCase();

    // Step 2: Fetch Reddit posts about this category (search multiple subreddits)
    const searchQueries = [
      `${catName} supplement problem`,
      `${catName} side effects`,
      `${catName} review`
    ];
    const redditPosts = [];

    for (const query of searchQueries) {
      try {
        const result = await httpsGet('www.reddit.com',
          `/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=25&restrict_sr=false`,
          { 'User-Agent': 'VitaView/1.0 (supplement market research)' }
        );
        const posts = result.data?.data?.children || [];
        posts.forEach(p => {
          const d = p.data;
          if (d && !d.stickied && (d.selftext || d.title)) {
            redditPosts.push({
              title: d.title || '',
              selftext: (d.selftext || '').slice(0, 500),
              subreddit: d.subreddit,
              score: d.score || 0,
              numComments: d.num_comments || 0,
              url: `https://reddit.com${d.permalink}`,
              created: new Date((d.created_utc || 0) * 1000).toISOString()
            });
          }
        });
      } catch(e) {
        console.log(`Reddit search error for "${query}":`, e.message);
      }
      await new Promise(r => setTimeout(r, 1000)); // Reddit rate limit
    }

    // Deduplicate posts by URL
    const seen = new Set();
    const uniquePosts = redditPosts.filter(p => {
      if (seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    });

    // Step 3: NLP Pain Point Extraction
    const painPoints = {};
    const evidencePosts = {};

    Object.entries(PAINPOINT_PATTERNS).forEach(([key, { keywords, label }]) => {
      painPoints[key] = { label, count: 0, severity: 0, keywords: [] };
      evidencePosts[key] = [];
    });

    uniquePosts.forEach(post => {
      const text = (post.title + ' ' + post.selftext).toLowerCase();
      Object.entries(PAINPOINT_PATTERNS).forEach(([key, { keywords }]) => {
        const matchedKW = keywords.filter(kw => text.includes(kw));
        if (matchedKW.length > 0) {
          painPoints[key].count++;
          painPoints[key].severity += matchedKW.length * (post.score > 10 ? 2 : 1);
          matchedKW.forEach(kw => {
            if (!painPoints[key].keywords.includes(kw)) painPoints[key].keywords.push(kw);
          });
          if (evidencePosts[key].length < 3) {
            evidencePosts[key].push({ title: post.title, score: post.score, subreddit: post.subreddit, url: post.url, matchedKeywords: matchedKW });
          }
        }
      });
    });

    // Rank pain points by severity
    const rankedPainPoints = Object.entries(painPoints)
      .map(([key, data]) => ({
        id: key,
        ...data,
        evidence: evidencePosts[key] || [],
        severityScore: Math.min(100, Math.round(data.severity * 10 / Math.max(1, uniquePosts.length) * 100))
      }))
      .filter(p => p.count > 0)
      .sort((a, b) => b.severity - a.severity);

    // Step 4: Generate improvement suggestions
    const improvementMap = {
      taste: { suggestion: 'Develop flavored gummy or softgel version with natural fruit flavoring', productIdea: 'Pleasant-tasting gummy with verified potency' },
      efficacy: { suggestion: 'Use bioavailable forms (e.g., chelated minerals, liposomal delivery) and provide 3rd-party lab certificates', productIdea: 'High-bioavailability formula with published clinical data' },
      sideEffects: { suggestion: 'Lower initial dosage, add digestive aids (ginger, peppermint), offer a "gentle" formula', productIdea: 'Gentle-formula supplement with stomach-friendly coating' },
      quality: { suggestion: 'NSF/USP certification, heavy metal testing, transparent lab reports on product page', productIdea: 'USP-verified, heavy-metal tested premium supplement' },
      dosage: { suggestion: 'Offer mini capsules, liquid drops, or powder form as alternatives', productIdea: 'Easy-to-swallow mini capsule or liquid drop format' },
      price: { suggestion: 'Competitive pricing with larger pack sizes, subscribe-and-save discounts', productIdea: 'Value pack (180-day supply) at lower per-serving cost' },
      packaging: { suggestion: 'Double-sealed glass bottles, improved cushioning in shipping', productIdea: 'Glass bottle with double-seal and travel-friendly packaging' },
      transparency: { suggestion: 'Full ingredient disclosure, COA (Certificate of Analysis) QR code on every bottle', productIdea: 'Fully transparent label with scannable COA link' }
    };

    const top3Issues = rankedPainPoints.slice(0, 3).map(p => ({
      ...p,
      improvement: improvementMap[p.id] || { suggestion: 'Conduct deeper research', productIdea: 'Improved version addressing this specific concern' }
    }));

    const responseData = {
      category,
      categoryName: catName,
      topProducts: topProducts.slice(0, 5).map(p => ({ asin: p.asin, title: p.title, brand: p.brand, price: p.price, rank: p.rank })),
      redditPostsAnalyzed: uniquePosts.length,
      allPainPoints: rankedPainPoints,
      top3Issues,
      newProductIdea: top3Issues.length >= 3 ? {
        concept: `${catName.charAt(0).toUpperCase() + catName.slice(1)} supplement that solves: ${top3Issues.map(i => i.label).join(', ')}`,
        features: top3Issues.map(i => i.improvement.suggestion),
        uniqueSellingPoint: top3Issues[0]?.improvement?.productIdea || 'Superior quality supplement'
      } : null,
      timestamp: new Date().toISOString()
    };

    painPointCache[cacheKey] = { data: responseData, time: Date.now() };
    res.json(responseData);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// [VitaView v2] Legal Barrier - 실제 작동하도록 수정
app.get('/api/legal-barrier', async (req, res) => {
  const keyword = req.query.keyword || req.query.category;
  if (!keyword) return res.status(400).json({ error: 'keyword 파라미터 필요' });

  try {
    // trendsCache에서 카테고리 데이터 가져오기 (기존 하위호환)
    const catData = trendsCache?.categories?.[keyword];
    const catName = keyword.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim().toLowerCase();
    const searchTerm = CATEGORY_KEYWORDS[keyword] || catName;

    let hhi = null, topBrands = [], brandCount = 0, topBrandShare = 0, totalProducts = 0;

    if (catData) {
      // SP-API 데이터 있는 경우
      const brands = catData.brands || {};
      const brandEntries = Object.entries(brands).sort((a, b) => b[1].revenue - a[1].revenue);
      totalProducts = catData.totalProducts || brandEntries.reduce((s, [, d]) => s + d.count, 0);
      brandCount = brandEntries.length;
      hhi = catData.hhi || 0;
      topBrandShare = catData.topBrandShare || 0;
      topBrands = brandEntries.slice(0, 5).map(([name, data]) => ({
        name, productCount: data.count,
        marketShare: Math.round(data.count / Math.max(1, totalProducts) * 100),
        estimatedRevenue: data.revenue || 0
      }));
    }

    // 특허 검색 링크 (직접 외부 링크 제공)
    const usptoUrl = `https://patents.google.com/?q=${encodeURIComponent(searchTerm + ' supplement')}&country=US&status=GRANT`;
    const googlePatentUrl = `https://patents.google.com/?q=${encodeURIComponent(searchTerm)}&before=priority:20240101`;

    let entryDifficulty = 'LOW';
    const entryReasons = [];

    if (hhi !== null) {
      if (hhi > 2500) {
        entryDifficulty = 'VERY_HIGH';
        entryReasons.push('시장이 소수 브랜드에 완전히 집중됨 (HHI > 2500)');
      } else if (hhi > 1800) {
        entryDifficulty = 'HIGH';
        entryReasons.push('상위 브랜드 점유율 높음 (HHI > 1800)');
      } else if (hhi > 1000) {
        entryDifficulty = 'MEDIUM';
        entryReasons.push('경쟁 있지만 진입 가능한 수준 (HHI 1000~1800)');
      } else {
        entryDifficulty = 'LOW';
        entryReasons.push('시장 분산, 신규 진입 유리 (HHI < 1000)');
      }
    } else {
      entryReasons.push('SP-API 데이터 없음 - 먼저 trends 데이터를 로드하세요');
    }

    // Opportunity Score도 함께 계산
    let opportunityData = null;
    if (catData) {
      opportunityData = calculateOpportunityScore(
        { catId: keyword, hhi, brandCount, topShare: topBrandShare, topBrandShare, topProducts: catData.topProducts || [] },
        {}
      );
    }

    // Brand landscape (기존 하위호환)
    const brands = catData?.brands || {};
    const brandEntries = Object.entries(brands).sort((a, b) => b[1].count - a[1].count);
    const weakBrands = brandEntries.filter(([, d]) => d.count <= 2);
    const strongBrands = brandEntries.filter(([, d]) => d.count >= 5);
    const brandLandscape = brandEntries.slice(0, 15).map(([name, data]) => ({
      name, productCount: data.count,
      marketShare: Math.round(data.count / Math.max(1, totalProducts) * 100),
      estimatedRevenue: data.revenue || 0,
      potentialTrademark: data.count >= 3
    }));

    res.json({
      keyword,
      category: keyword,
      categoryName: catName,
      entryDifficulty, entryReasons, hhi,
      topBrands: topBrands.slice(0, 5),
      patentLinks: { uspto: usptoUrl, googlePatents: googlePatentUrl },
      // 기존 하위호환 필드
      barrierScore: entryDifficulty === 'VERY_HIGH' ? 90 : entryDifficulty === 'HIGH' ? 70 : entryDifficulty === 'MEDIUM' ? 50 : 25,
      riskLevel: entryDifficulty === 'VERY_HIGH' ? 'HIGH' : entryDifficulty,
      riskColor: entryDifficulty === 'VERY_HIGH' || entryDifficulty === 'HIGH' ? '#ef4444' : entryDifficulty === 'MEDIUM' ? '#f59e0b' : '#10b981',
      riskAdvice: entryReasons[0] || '',
      opportunityScore: opportunityData?.opportunityScore || null,
      opportunityVerdict: opportunityData?.verdict || null,
      opportunityBreakdown: opportunityData?.scoreBreakdown || null,
      metrics: {
        hhi: hhi || 0,
        topBrandShare,
        brandCount,
        totalProducts
      },
      brandLandscape,
      opportunities: {
        weakBrandsCount: weakBrands.length,
        strongBrandsCount: strongBrands.length,
        fragmentationRatio: Math.round(weakBrands.length / Math.max(1, brandEntries.length) * 100),
        isFragmented: weakBrands.length > strongBrands.length * 2
      },
      searchLinks: {
        usptoTess: `https://tmsearch.uspto.gov/bin/gate.exe?f=searchss&state=4801:1.1.1&p_s_PARA1=${encodeURIComponent(searchTerm)}`,
        googlePatents: googlePatentUrl,
        usptoSearch: 'https://www.uspto.gov/trademarks/search',
        alibabaSearch: `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(searchTerm)}`
      },
      checkedAt: new Date().toISOString(),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== MODULE 4: 1/3 Rule Margin Calculator =====
app.get('/api/margin-calculator', async (req, res) => {
  if (!trendsCache) return res.json({ error: 'Trends data not loaded yet.' });

  const requestedCategory = req.query.category;
  const categories = trendsCache.categories || {};
  const categoryIds = requestedCategory ? [requestedCategory] : Object.keys(categories);

  const results = [];

  for (const catId of categoryIds) {
    const catData = categories[catId];
    if (!catData || !catData.avgPrice) continue;

    const avgPrice = catData.avgPrice;
    const minPrice = catData.minPrice || avgPrice * 0.5;
    const maxPrice = catData.maxPrice || avgPrice * 1.5;

    // 1/3 Rule: Selling Price = Manufacturing + Amazon Fees + Profit (each ~33%)
    const targetCOGS = +(avgPrice * 0.33).toFixed(2);           // Cost of Goods Sold (33%)
    const estimatedAmazonFees = +(avgPrice * 0.33).toFixed(2);  // Amazon FBA + referral (~33%)
    const estimatedProfit = +(avgPrice * 0.34).toFixed(2);      // Net profit (~34%)

    // Premium segment analysis
    const premiumPrice = maxPrice;
    const premiumCOGS = +(premiumPrice * 0.33).toFixed(2);
    const premiumProfit = +(premiumPrice * 0.34).toFixed(2);

    // Budget entry point
    const budgetPrice = minPrice;
    const budgetCOGS = +(budgetPrice * 0.33).toFixed(2);

    // Revenue projections
    const avgDailySales = catData.avgDailySales || 10;
    const monthlyUnits = avgDailySales * 30;
    const monthlyRevenue = +(monthlyUnits * avgPrice).toFixed(0);
    const monthlyProfit = +(monthlyUnits * estimatedProfit).toFixed(0);

    // Viability rating
    let viability, viabilityColor;
    if (targetCOGS >= 8) {
      viability = 'EXCELLENT';
      viabilityColor = '#10b981';
    } else if (targetCOGS >= 5) {
      viability = 'GOOD';
      viabilityColor = '#3b82f6';
    } else if (targetCOGS >= 3) {
      viability = 'FEASIBLE';
      viabilityColor = '#f59e0b';
    } else {
      viability = 'TIGHT';
      viabilityColor = '#ef4444';
    }

    const catName = catId.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim().toLowerCase();
    const searchTerm = CATEGORY_KEYWORDS[catId] || catName;

    results.push({
      category: catId,
      categoryName: catName,
      pricing: {
        avgSellingPrice: +avgPrice.toFixed(2),
        minPrice: +minPrice.toFixed(2),
        maxPrice: +maxPrice.toFixed(2),
        priceSpread: catData.priceSpread || +(maxPrice - minPrice).toFixed(2)
      },
      oneThirdRule: {
        targetCOGS,
        estimatedAmazonFees,
        estimatedProfit,
        cogsPercentage: 33,
        feesPercentage: 33,
        profitPercentage: 34
      },
      premium: {
        price: +premiumPrice.toFixed(2),
        targetCOGS: premiumCOGS,
        profit: premiumProfit
      },
      budget: {
        price: +budgetPrice.toFixed(2),
        targetCOGS: budgetCOGS
      },
      projections: {
        avgDailySales,
        monthlyUnits,
        monthlyRevenue,
        monthlyProfit,
        annualProfit: monthlyProfit * 12
      },
      viability,
      viabilityColor,
      alibabaLink: `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(searchTerm)}`,
      alibaba1688Link: `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(searchTerm)}`
    });
  }

  // Sort by monthly profit descending
  results.sort((a, b) => b.projections.monthlyProfit - a.projections.monthlyProfit);

  res.json({
    products: results,
    totalAnalyzed: results.length,
    timestamp: new Date().toISOString()
  });
});

// ===== AI SUPPLEMENT FORMULATOR =====
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Health concern -> supplement category mapping
const HEALTH_CONCERNS = {
  sleep: { label: 'Sleep & Relaxation', categories: ['melatonin', 'magnesium', 'valerian', 'l_theanine', 'five_htp', 'ashwagandha', 'rhodiola'], subreddits: ['supplements', 'insomnia', 'sleep', 'Biohackers'] },
  immunity: { label: 'Immune Support', categories: ['vitaminC', 'vitaminD', 'zinc', 'elderberry', 'echinacea', 'quercetin', 'bovine_colostrum', 'sea_moss'], subreddits: ['supplements', 'nutrition', 'Biohackers'] },
  gut: { label: 'Gut Health & Digestion', categories: ['probiotics', 'fiber', 'digestive_enzymes', 'psyllium_husk', 'berberine', 'glutamine'], subreddits: ['supplements', 'nutrition', 'ibs', 'Biohackers'] },
  energy: { label: 'Energy & Focus', categories: ['vitaminB', 'coq10', 'l_carnitine', 'creatine', 'cordyceps', 'lions_mane', 'alpha_lipoic_acid', 'pqq'], subreddits: ['supplements', 'nootropics', 'Biohackers'] },
  beauty: { label: 'Skin, Hair & Beauty', categories: ['collagen', 'biotin', 'hyaluronic_acid', 'keratin', 'vitaminE', 'astaxanthin'], subreddits: ['supplements', 'SkincareAddiction', 'Biohackers'] },
  weight: { label: 'Weight Management', categories: ['greenTea', 'appleCiderVinegar', 'berberine', 'fiber', 'chromium', 'l_carnitine', 'inositol'], subreddits: ['supplements', 'loseit', 'Fitness', 'Biohackers'] },
  joints: { label: 'Joint & Bone Health', categories: ['glucosamine', 'chondroitin', 'msm', 'calcium', 'vitaminD', 'vitaminK', 'bromelain', 'boron'], subreddits: ['supplements', 'Fitness', 'nutrition'] },
  mens: { label: "Men's Health", categories: ['tongkat_ali', 'tribulus', 'shilajit', 'dhea', 'saw_palmetto', 'fenugreek', 'zinc', 'boron'], subreddits: ['supplements', 'Testosterone', 'Biohackers'] },
  womens: { label: "Women's Health", categories: ['iron', 'folate', 'calcium', 'evening_primrose', 'black_cohosh', 'inositol', 'dim', 'vitaminD'], subreddits: ['supplements', 'PCOS', 'nutrition'] },
  longevity: { label: 'Longevity & Anti-Aging', categories: ['nmn', 'resveratrol', 'nac', 'coq10', 'alpha_lipoic_acid', 'astaxanthin', 'pqq', 'quercetin'], subreddits: ['supplements', 'longevity', 'Biohackers', 'nootropics'] },
  stress: { label: 'Stress & Mood', categories: ['ashwagandha', 'rhodiola', 'five_htp', 'l_theanine', 'magnesium', 'st_johns_wort', 'ginseng'], subreddits: ['supplements', 'anxiety', 'Biohackers', 'nootropics'] },
  muscle: { label: 'Muscle & Performance', categories: ['creatine', 'bcaa', 'glutamine', 'whey_protein', 'beta_alanine', 'citrulline', 'electrolytes', 'protein'], subreddits: ['supplements', 'Fitness', 'bodybuilding'] }
};

// ===== [VitaView Fix] BSR History Cache - 시장 불안정성 측정용 =====
// BSR을 주기적으로 기록하여 변동 표준편차 계산 (문제 3)
const bsrHistoryCache = {};  // { catId: { ranks: [{ rank, timestamp }], lastUpdated } }
const BSR_HISTORY_CACHE_TTL = 60 * 60 * 1000; // 1시간 TTL

// [VitaView Fix] BSR 변동폭 기록 함수
function recordBSRSnapshot(catId, topProducts) {
  if (!topProducts || topProducts.length === 0) return;
  if (!bsrHistoryCache[catId]) {
    bsrHistoryCache[catId] = { snapshots: [], lastUpdated: 0 };
  }
  const now = Date.now();
  const ranks = topProducts.map(p => p.rank).filter(Boolean);
  if (ranks.length > 0) {
    bsrHistoryCache[catId].snapshots.push({ ranks, timestamp: now, avgRank: ranks.reduce((a, b) => a + b, 0) / ranks.length });
    // 최대 24개 스냅샷 유지 (24시간치)
    if (bsrHistoryCache[catId].snapshots.length > 24) {
      bsrHistoryCache[catId].snapshots = bsrHistoryCache[catId].snapshots.slice(-24);
    }
    bsrHistoryCache[catId].lastUpdated = now;
  }
}

// [VitaView Fix] BSR 변동 표준편차 계산
function calculateBSRVolatility(catId) {
  const history = bsrHistoryCache[catId];
  if (!history || history.snapshots.length < 2) return { volatility: null, dataPoints: history?.snapshots?.length || 0 };
  const avgRanks = history.snapshots.map(s => s.avgRank);
  const mean = avgRanks.reduce((a, b) => a + b, 0) / avgRanks.length;
  const variance = avgRanks.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / avgRanks.length;
  const stdDev = Math.sqrt(variance);
  // 변동계수(CV) = stdDev / mean * 100 - 평균 대비 변동률
  const cv = mean > 0 ? (stdDev / mean) * 100 : 0;
  return { volatility: Math.round(cv * 100) / 100, stdDev: Math.round(stdDev), mean: Math.round(mean), dataPoints: avgRanks.length };
}

// ===== [VitaView Fix] Opportunity Score 계산 시스템 (문제 2) =====
// 5개 지표 기반, 총 100점 만점. 데이터 없으면 해당 항목 제외 후 재정규화
function calculateOpportunityScore(categoryData, opts = {}) {
  const { redditSentiment, googleTrendsData, youtubeData, suggestionsData } = opts;
  const scores = {};
  let totalMaxScore = 0;
  let totalScore = 0;

  // === A. 시장 접근성 점수 (30점) - HHI 기반 ===
  // [VitaView Fix] HHI 낮을수록 높은 점수 (문제 1 반영)
  const hhi = categoryData.hhi;
  if (hhi != null && hhi !== undefined) {
    let accessScore;
    if (hhi < 1000) accessScore = 30;
    else if (hhi <= 1800) accessScore = 20;
    else if (hhi <= 2500) accessScore = 10;
    else accessScore = 0;
    scores.marketAccessibility = {
      score: accessScore, maxScore: 30, available: true,
      reason: hhi < 1000 ? `HHI ${hhi} - 분산된 시장, 진입 용이` :
              hhi <= 1800 ? `HHI ${hhi} - 보통 수준의 시장 집중도` :
              hhi <= 2500 ? `HHI ${hhi} - 집중된 시장, 주의 필요` :
              `HHI ${hhi} - 독점 시장, 진입 극히 어려움`
    };
    totalMaxScore += 30;
    totalScore += accessScore;
  } else {
    scores.marketAccessibility = { score: 0, maxScore: 30, available: false, reason: '데이터 없음' };
  }

  // === B. 소비자 불만 점수 (25점) - Reddit + YouTube 기반 ===
  if (redditSentiment && redditSentiment.available) {
    const negRatio = redditSentiment.negativeRatio || 0; // 0~100%
    // 불만 비율이 높을수록 높은 점수 (= 개선 기회)
    const dissatScore = Math.min(25, Math.round(negRatio * 0.5));
    scores.consumerDissatisfaction = {
      score: dissatScore, maxScore: 25, available: true,
      reason: `Reddit 부정 언급 ${Math.round(negRatio)}%${redditSentiment.topComplaint ? `, 주요 불만: "${redditSentiment.topComplaint}"` : ''}`
    };
    totalMaxScore += 25;
    totalScore += dissatScore;
  } else {
    scores.consumerDissatisfaction = { score: 0, maxScore: 25, available: false, reason: '데이터 없음' };
  }

  // === C. 트렌드 모멘텀 점수 (20점) - Google Trends 증가율 ===
  if (googleTrendsData && googleTrendsData.available) {
    const growthRate = googleTrendsData.growthRate || 0; // % 증가율
    let trendScore;
    if (growthRate > 50) trendScore = 20;
    else if (growthRate >= 20) trendScore = 15;
    else if (growthRate >= 0) trendScore = 10;
    else trendScore = 0;
    scores.trendMomentum = {
      score: trendScore, maxScore: 20, available: true,
      reason: growthRate > 0 ? `3개월 성장률 +${Math.round(growthRate)}%` : `3개월 성장률 ${Math.round(growthRate)}% (하락 추세)`
    };
    totalMaxScore += 20;
    totalScore += trendScore;
  } else {
    scores.trendMomentum = { score: 0, maxScore: 20, available: false, reason: '데이터 없음' };
  }

  // === D. 진입 장벽 점수 (15점) - 특허/제조 ===
  // USPTO 직접 API 없으므로 브랜드 수 + 시장 구조로 추정
  const brandCount = categoryData.brandCount || 0;
  const topShare = categoryData.topShare || categoryData.topBrandShare || 0;
  if (brandCount > 0) {
    // 브랜드 많고 상위 점유율 낮으면 = 진입장벽 낮음
    let barrierScore = 0;
    if (brandCount >= 20 && topShare < 20) barrierScore = 15;
    else if (brandCount >= 10 && topShare < 35) barrierScore = 10;
    else if (brandCount >= 5) barrierScore = 5;
    else barrierScore = 0;
    scores.entryBarrier = {
      score: barrierScore, maxScore: 15, available: true,
      reason: `${brandCount}개 브랜드, 1위 점유율 ${Math.round(topShare)}%${barrierScore >= 10 ? ' - 진입 장벽 낮음' : barrierScore >= 5 ? ' - 보통' : ' - 높은 진입 장벽'}`
    };
    totalMaxScore += 15;
    totalScore += barrierScore;
  } else {
    scores.entryBarrier = { score: 0, maxScore: 15, available: false, reason: '데이터 없음' };
  }

  // === E. 수요 확인 점수 (10점) - Google Suggestions + YouTube 기반 ===
  if ((suggestionsData && suggestionsData.available) || (youtubeData && youtubeData.available)) {
    let demandScore = 0;
    const sugCount = suggestionsData?.relatedCount || 0;
    const ytViews = youtubeData?.avgViews || 0;
    // Google Suggestions 연관 검색어 5개 이상이면 +5점
    if (sugCount >= 5) demandScore += 5;
    else if (sugCount >= 2) demandScore += 3;
    // YouTube 평균 조회수 10만 이상이면 +5점
    if (ytViews >= 100000) demandScore += 5;
    else if (ytViews >= 10000) demandScore += 3;
    else if (ytViews > 0) demandScore += 1;
    demandScore = Math.min(10, demandScore);
    scores.demandSignal = {
      score: demandScore, maxScore: 10, available: true,
      reason: `연관 검색어 ${sugCount}개, YouTube 평균 조회수 ${ytViews > 0 ? (ytViews / 1000).toFixed(0) + 'K' : 'N/A'}`
    };
    totalMaxScore += 10;
    totalScore += demandScore;
  } else {
    scores.demandSignal = { score: 0, maxScore: 10, available: false, reason: '데이터 없음' };
  }

  // === BSR 변동폭 보조 지표 (보너스 - 문제 3) ===
  const bsrVol = calculateBSRVolatility(categoryData.catId);
  let bsrBonus = 0;
  let bsrReason = '데이터 부족';
  if (bsrVol.volatility !== null) {
    // 변동계수 > 30% = 불안정 = 신규 진입 기회 (+5점 보너스)
    if (bsrVol.volatility > 30) { bsrBonus = 5; bsrReason = `BSR 변동계수 ${bsrVol.volatility}% - 불안정 시장, 진입 기회`; }
    else if (bsrVol.volatility > 15) { bsrBonus = 3; bsrReason = `BSR 변동계수 ${bsrVol.volatility}% - 보통`; }
    else { bsrBonus = 0; bsrReason = `BSR 변동계수 ${bsrVol.volatility}% - 안정적 (기존 강자 유지)`; }
  }
  scores.bsrVolatility = { bonus: bsrBonus, reason: bsrReason, dataPoints: bsrVol.dataPoints };

  // === 최종 점수: 데이터 있는 항목만으로 100점 만점 재정규화 ===
  let normalizedScore;
  if (totalMaxScore > 0) {
    normalizedScore = Math.round((totalScore / totalMaxScore) * 100) + bsrBonus;
    normalizedScore = Math.min(100, normalizedScore);
  } else {
    normalizedScore = 0;
  }

  // === 최종 판정 ===
  let verdict;
  if (normalizedScore >= 80) verdict = '🟢 지금 바로 진입하세요';
  else if (normalizedScore >= 60) verdict = '🟡 6개월 후 재검토 추천';
  else verdict = '🔴 이 시장은 피하세요';

  return {
    opportunityScore: normalizedScore,
    verdict,
    scoreBreakdown: scores,
    rawTotal: totalScore,
    rawMaxScore: totalMaxScore,
    bsrBonus,
    dataCompleteness: totalMaxScore > 0 ? Math.round((totalMaxScore / 100) * 100) + '%' : '0%'
  };
}

// ===== [VitaView Fix] 진입 불가 필터 (문제 5) =====
function checkEntryBlockers(categoryData, googleTrendsData) {
  const blockedReasons = [];

  // 1. HHI > 2500 = 사실상 독점 시장
  if (categoryData.hhi > 2500) {
    blockedReasons.push(`HHI ${categoryData.hhi} > 2500 - 독점 시장`);
  }

  // 2. 상위 3개 제품 BSR 전부 100 이하 = 대형 브랜드 완전 장악
  const topProducts = categoryData.topProducts || [];
  const top3Ranks = topProducts.slice(0, 3).map(p => p.rank).filter(Boolean);
  if (top3Ranks.length >= 3 && top3Ranks.every(r => r <= 100)) {
    blockedReasons.push(`상위 3개 제품 BSR 전부 100 이하 (${top3Ranks.join(', ')}) - 대형 브랜드 완전 장악`);
  }

  // 3. 브랜드 수 극소 + 1위 점유율 극고 = 특허/독점 유사 구조
  const topShare = categoryData.topBrandShare || categoryData.topShare || 0;
  const brandCount = categoryData.brandCount || 0;
  if (brandCount <= 3 && topShare > 60) {
    blockedReasons.push(`${brandCount}개 브랜드, 1위 점유율 ${Math.round(topShare)}% - 특허/독점 유사 구조`);
  }

  // 4. Google Trends 절대값 지속 하락 중
  if (googleTrendsData && googleTrendsData.available && googleTrendsData.growthRate < -20) {
    blockedReasons.push(`Google Trends ${Math.round(googleTrendsData.growthRate)}% 하락 - 수요 감소 추세`);
  }

  return blockedReasons;
}

// ===== [VitaView Fix] Reddit 부정 감성 분석 헬퍼 =====
async function analyzeRedditSentiment(searchTerm) {
  const negativeKeywords = ['bad', 'disappointed', 'waste', 'problem', 'issue', 'side effect', 'complaint', 'terrible', 'scam', 'overpriced', 'doesn\'t work', 'ineffective', 'nausea', 'stomach'];
  try {
    const result = await httpsGet('www.reddit.com',
      `/search.json?q=${encodeURIComponent(searchTerm + ' supplement')}&sort=relevance&t=year&limit=25`,
      { 'User-Agent': 'VitaView/1.0 (supplement research)' }
    );
    const posts = (result.data?.data?.children || []).filter(p => !p.data?.stickied);
    if (posts.length === 0) return { available: false };
    let negCount = 0;
    let topComplaint = '';
    let maxNegScore = 0;
    posts.forEach(p => {
      const text = (p.data.title + ' ' + (p.data.selftext || '')).toLowerCase();
      negativeKeywords.forEach(kw => {
        if (text.includes(kw)) {
          negCount++;
          if (p.data.score > maxNegScore) { maxNegScore = p.data.score; topComplaint = kw; }
        }
      });
    });
    const negativeRatio = (negCount / (posts.length * negativeKeywords.length)) * 100;
    return { available: true, negativeRatio: Math.min(100, negativeRatio * 10), postsAnalyzed: posts.length, topComplaint };
  } catch(e) { return { available: false, error: e.message }; }
}

// ===== [VitaView Fix] Google Trends 증가율 계산 헬퍼 =====
async function fetchTrendGrowthRate(keyword) {
  try {
    const widgetUrl = `/trends/api/explore?hl=en-US&tz=240&req=${encodeURIComponent(JSON.stringify({
      comparisonItem: [{ keyword, geo: 'US', time: 'today 6-m' }], category: 0, property: ''
    }))}&tz=240`;
    const widgetRes = await httpsGet('trends.google.com', widgetUrl, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    let widgetData = typeof widgetRes.data === 'string' ? widgetRes.data : JSON.stringify(widgetRes.data);
    widgetData = widgetData.replace(/^\)\]\}',?\n?/, '');
    const parsed = JSON.parse(widgetData);
    const timeWidget = parsed.widgets?.find(w => w.id === 'TIMESERIES');
    if (!timeWidget) return { available: false };

    const timeReq = encodeURIComponent(JSON.stringify(timeWidget.request));
    const timeRes = await httpsGet('trends.google.com',
      `/trends/api/widgetdata/multiline?hl=en-US&tz=240&req=${timeReq}&token=${timeWidget.token}`,
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    );
    let timeData = typeof timeRes.data === 'string' ? timeRes.data : JSON.stringify(timeRes.data);
    timeData = timeData.replace(/^\)\]\}',?\n?/, '');
    const timeParsed = JSON.parse(timeData);
    const points = (timeParsed.default?.timelineData || []).map(p => p.value?.[0] || 0);
    if (points.length < 8) return { available: false };

    // 최근 3개월 vs 이전 3개월
    const half = Math.floor(points.length / 2);
    const older = points.slice(0, half);
    const newer = points.slice(half);
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    const newerAvg = newer.reduce((a, b) => a + b, 0) / newer.length;
    const growthRate = olderAvg > 0 ? ((newerAvg - olderAvg) / olderAvg) * 100 : (newerAvg > 0 ? 100 : 0);
    // 지속적 하락 체크 (최근 4주 모두 감소)
    const last4 = points.slice(-4);
    const isConsistentDecline = last4.length >= 4 && last4.every((v, i) => i === 0 || v <= last4[i - 1]);
    return { available: true, growthRate, newerAvg, olderAvg, isConsistentDecline, currentValue: points[points.length - 1] };
  } catch(e) { return { available: false, error: e.message }; }
}

// ===== [VitaView Fix] YouTube + Suggestions 수요 시그널 헬퍼 =====
async function fetchDemandSignals(keyword) {
  const result = { youtube: { available: false }, suggestions: { available: false } };
  // Google Suggestions
  try {
    const sgRes = await httpsGet('suggestqueries.google.com',
      `/complete/search?client=firefox&q=${encodeURIComponent(keyword + ' supplement')}`,
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    );
    const sgs = Array.isArray(sgRes.data) ? sgRes.data[1] || [] : [];
    result.suggestions = { available: sgs.length > 0, relatedCount: sgs.length, terms: sgs.slice(0, 5) };
  } catch(e) {}
  // YouTube
  if (YOUTUBE_API_KEY) {
    try {
      const searchRes = await httpsGet('www.googleapis.com',
        `/youtube/v3/search?key=${YOUTUBE_API_KEY}&q=${encodeURIComponent(keyword + ' supplement review')}&type=video&order=viewCount&maxResults=5&part=snippet&publishedAfter=${new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()}`,
        {}
      );
      const videoIds = (searchRes.data?.items || []).map(i => i.id?.videoId).filter(Boolean);
      if (videoIds.length > 0) {
        const statsRes = await httpsGet('www.googleapis.com',
          `/youtube/v3/videos?key=${YOUTUBE_API_KEY}&id=${videoIds.join(',')}&part=statistics`, {}
        );
        const views = (statsRes.data?.items || []).map(v => parseInt(v.statistics?.viewCount || 0));
        const avgViews = views.length > 0 ? views.reduce((a, b) => a + b, 0) / views.length : 0;
        result.youtube = { available: true, avgViews: Math.round(avgViews), videoCount: views.length };
      }
    } catch(e) {}
  }
  return result;
}

// ===== [VitaView Fix] 새 Opportunity Score API 엔드포인트 =====
app.get('/api/opportunity-score', async (req, res) => {
  if (!trendsCache?.categories) {
    return res.status(503).json({ error: 'Data not loaded yet.' });
  }
  const category = req.query.category;
  if (!category || !trendsCache.categories[category]) {
    return res.json({ error: 'Invalid category', validCategories: Object.keys(trendsCache.categories) });
  }

  const catData = trendsCache.categories[category];
  const keyword = (CATEGORY_KEYWORDS[category] || category.replace(/_/g, ' '));

  // BSR 스냅샷 기록
  recordBSRSnapshot(category, catData.topProducts);

  // 병렬로 외부 데이터 수집
  const [redditSentiment, googleTrendsData, demandSignals] = await Promise.all([
    analyzeRedditSentiment(keyword),
    fetchTrendGrowthRate(keyword),
    fetchDemandSignals(keyword)
  ]);

  // Opportunity Score 계산
  const catInput = {
    catId: category,
    hhi: catData.hhi,
    brandCount: catData.brandCount || Object.keys(catData.brands || {}).length,
    topShare: catData.topBrandShare,
    topProducts: catData.topProducts || [],
    topBrandShare: catData.topBrandShare
  };

  const scoreResult = calculateOpportunityScore(catInput, {
    redditSentiment,
    googleTrendsData,
    suggestionsData: demandSignals.suggestions,
    youtubeData: demandSignals.youtube
  });

  // 진입 불가 필터 체크
  const blockedReasons = checkEntryBlockers(catInput, googleTrendsData);
  if (blockedReasons.length > 0) {
    scoreResult.verdict = `⛔ 진입 불가 - ${blockedReasons[0]}`;
    scoreResult.blockedReasons = blockedReasons;
  }

  // [VitaView v2] 데이터 신뢰도 + AI 전략 분석 추가
  const dataConfidence = calculateDataConfidence({
    trends: googleTrendsData?.available ? googleTrendsData : null,
    reddit: redditSentiment?.available ? { mentionCount: redditSentiment.postsAnalyzed || 0 } : null,
    youtube: demandSignals.youtube?.available ? { videoCount: demandSignals.youtube.videoCount || 0 } : null,
    bsr: catData ? true : null,
    patents: null
  });

  let aiStrategy = null;
  try {
    aiStrategy = await getGeminiStrategyAnalysis(keyword, {
      hhi: catData.hhi, opportunityScore: scoreResult.opportunityScore,
      trendGrowthRate: googleTrendsData?.growthRate,
      redditNegativeRatio: redditSentiment?.negativeRatio,
      estimatedMargin: catData.avgPrice ? Math.round(catData.avgPrice * 0.34) : null
    });
  } catch(e) { /* Gemini 실패 무시 */ }

  res.json({
    category,
    categoryName: keyword,
    ...scoreResult,
    bsrVolatility: calculateBSRVolatility(category),
    dataConfidence,
    aiStrategy,
    dataFreshness: new Date().toISOString()
  });
});

// ===== SMART RECOMMEND: User picks target, AI recommends 3 products with market sizing & ROI =====
app.get('/api/ai-formulator/auto-recommend', async (req, res) => {
  if (!trendsCache?.categories) {
    return res.status(503).json({ error: 'Data not loaded yet. Please wait for initial data fetch.' });
  }
  if (!GEMINI_API_KEY) {
    return res.json({ error: 'GEMINI_API_KEY not set', message: 'Gemini API 키가 필요합니다. .env 파일에 GEMINI_API_KEY=your_key를 추가해주세요.' });
  }

  // User inputs (all support comma-separated multi-select)
  const targetMarket = req.query.targetMarket || '';  // e.g. "sleep,gut,beauty"
  const targetAudience = req.query.targetAudience || '';  // e.g. "gen_z,athletes,vegan"
  const considerations = req.query.considerations || '';  // e.g. "high_margin,trending"
  const preferredIngredients = req.query.ingredients || '';  // e.g. "ashwagandha,magnesium"
  const formType = req.query.formType || '';  // e.g. "gummy,capsule"
  const budget = parseInt(req.query.budget) || 10000;  // initial investment USD

  try {
    // [VitaView Fix] 1. 카테고리 기본 데이터 수집 + Opportunity Score 준비
    const catEntries = Object.entries(trendsCache.categories);
    const maxRev = Math.max(...catEntries.map(([,c]) => c.estimatedMonthlyRevenue || 0), 1);
    const maxSpread = Math.max(...catEntries.map(([,c]) => c.priceSpread || 0), 1);

    // [VitaView Fix] 기본 카테고리 점수 계산 (HHI 방향 반전 적용)
    const scored = catEntries.map(([catId, c]) => {
      const hhi = c.hhi || 0;
      const topShare = c.topBrandShare || 0;
      const brandCount = c.brandCount || Object.keys(c.brands || {}).length;
      const totalProducts = c.totalProducts || 0;
      const avgDailySales = c.avgDailySales || 0;
      const revenue = c.estimatedMonthlyRevenue || 0;
      const priceSpread = c.priceSpread || 0;
      const avgPrice = c.avgPrice || 0;

      // [VitaView Fix] BSR 스냅샷 기록 (문제 3)
      recordBSRSnapshot(catId, c.topProducts);

      // [VitaView Fix] 빠른 Opportunity Score (외부 API 없이 SP-API 데이터만으로)
      // 전체 카테고리에 대해 빠르게 계산 - 외부 데이터는 top 10에만 적용
      const quickScore = calculateOpportunityScore(
        { catId, hhi, brandCount, topShare, topBrandShare: topShare, topProducts: c.topProducts || [] },
        {} // 외부 데이터 없이 빠른 점수
      );

      // [VitaView Fix] 하위호환: dominationScore 유지 (= opportunityScore)
      const dominationScore = quickScore.opportunityScore;

      const topBrandEntry = Object.entries(c.brands || {}).sort((a, b) => b[1].revenue - a[1].revenue)[0];
      const brandEntries = Object.entries(c.brands || {}).sort((a, b) => b[1].revenue - a[1].revenue);
      const top3Rev = brandEntries.slice(0, 3).reduce((s, [,b]) => s + b.revenue, 0);
      const totalRev = brandEntries.reduce((s, [,b]) => s + b.revenue, 0);
      const top3Share = totalRev > 0 ? Math.round((top3Rev / totalRev) * 100) : 0;

      return {
        catId, dominationScore, opportunityScore: dominationScore,
        scoreBreakdown: quickScore.scoreBreakdown,
        verdict: quickScore.verdict,
        brandCount, totalProducts,
        avgDailySales, revenue, avgPrice, priceSpread,
        hhi, topShare, top3Share,
        topBrand: topBrandEntry ? topBrandEntry[0] : 'N/A',
        topProducts: (c.topProducts || []).slice(0, 5),
        minPrice: c.minPrice || 0, maxPrice: c.maxPrice || 0,
        brands: c.brands,
        annualRevenue: revenue * 12
      };
    }).sort((a, b) => b.dominationScore - a.dominationScore);

    // 2. Filter by user's target markets (supports multiple comma-separated)
    let relevantCategories = scored;
    const marketKeys = targetMarket ? targetMarket.split(',').filter(k => HEALTH_CONCERNS[k]) : [];
    if (marketKeys.length > 0) {
      const allTargetCats = new Set();
      marketKeys.forEach(k => HEALTH_CONCERNS[k].categories.forEach(c => allTargetCats.add(c)));
      relevantCategories = scored.filter(s => allTargetCats.has(s.catId));
      if (relevantCategories.length === 0) relevantCategories = scored.slice(0, 10);
    }

    // [VitaView Fix] 진입 불가 필터 적용 (문제 5)
    const blockedCategories = [];
    relevantCategories = relevantCategories.filter(cat => {
      const blockers = checkEntryBlockers(
        { hhi: cat.hhi, topBrandShare: cat.topShare, brandCount: cat.brandCount, topProducts: cat.topProducts },
        null // Google Trends는 top10에서만 체크
      );
      if (blockers.length > 0) {
        blockedCategories.push({ catId: cat.catId, blockedReasons: blockers, verdict: `⛔ 진입 불가 - ${blockers[0]}` });
        return false;
      }
      return true;
    });

    // 3. Build market context (top 10 relevant categories for broader analysis)
    const topCats = relevantCategories.slice(0, 10);

    // [VitaView Fix] top 카테고리에 대해 외부 데이터 기반 정밀 Opportunity Score 계산
    // 병렬로 Reddit 감성 + Google Trends + 수요 시그널 수집 (상위 3개만 - API 비용 절감)
    const enrichedScores = {};
    try {
      const enrichPromises = topCats.slice(0, 3).map(async (cat) => {
        const keyword = CATEGORY_KEYWORDS[cat.catId] || cat.catId.replace(/_/g, ' ');
        const [redditSent, trendsData, demandSig] = await Promise.all([
          analyzeRedditSentiment(keyword).catch(() => ({ available: false })),
          fetchTrendGrowthRate(keyword).catch(() => ({ available: false })),
          fetchDemandSignals(keyword).catch(() => ({ youtube: { available: false }, suggestions: { available: false } }))
        ]);
        const fullScore = calculateOpportunityScore(
          { catId: cat.catId, hhi: cat.hhi, brandCount: cat.brandCount, topShare: cat.topShare, topBrandShare: cat.topShare, topProducts: cat.topProducts },
          { redditSentiment: redditSent, googleTrendsData: trendsData, suggestionsData: demandSig.suggestions, youtubeData: demandSig.youtube }
        );
        // 추가 진입 불가 체크 (Google Trends 포함)
        const extraBlockers = checkEntryBlockers(
          { hhi: cat.hhi, topBrandShare: cat.topShare, brandCount: cat.brandCount, topProducts: cat.topProducts },
          trendsData
        );
        enrichedScores[cat.catId] = { ...fullScore, blockedReasons: extraBlockers, trendsData, redditSentiment: redditSent };
      });
      await Promise.all(enrichPromises);
    } catch(e) { console.log('[VitaView] Enrichment error (non-fatal):', e.message); }

    // 4. Map categories to health concerns
    const categoryConcernMap = {};
    for (const [concernKey, concernData] of Object.entries(HEALTH_CONCERNS)) {
      for (const cat of concernData.categories) {
        if (!categoryConcernMap[cat]) categoryConcernMap[cat] = [];
        categoryConcernMap[cat].push({ key: concernKey, label: concernData.label });
      }
    }

    // 5. Get Reddit data
    let redditData = { topPosts: [] };
    try {
      const searchTerm = targetMarket ? (HEALTH_CONCERNS[targetMarket]?.label || targetMarket) : topCats[0]?.catId?.replace(/_/g, ' ') || 'supplement';
      const result = await httpsGet('www.reddit.com',
        `/search.json?q=${encodeURIComponent(searchTerm + ' supplement')}&sort=relevance&t=month&limit=20`,
        { 'User-Agent': 'VitaView/1.0 (supplement research)' }
      );
      const posts = (result.data?.data?.children || [])
        .filter(p => !p.data?.stickied)
        .map(p => ({ title: p.data.title, score: p.data.score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      redditData.topPosts = posts.map(p => `[Score:${p.score}] ${p.title}`);
    } catch(e) { redditData.error = e.message; }

    // 6. Get FDA data
    let fdaData = [];
    try {
      for (const cat of topCats.slice(0, 3)) {
        const ingName = cat.catId.replace(/_/g, ' ');
        try {
          const aeRes = await httpsGet('api.fda.gov', `/food/event.json?search=products.name_brand:"${encodeURIComponent(ingName)}"&limit=1`, {});
          fdaData.push({ ingredient: ingName, adverseEvents: aeRes.data?.meta?.results?.total || 0 });
        } catch(e) { fdaData.push({ ingredient: ingName, adverseEvents: 0 }); }
        await new Promise(r => setTimeout(r, 200));
      }
    } catch(e) {}

    // [VitaView Fix] 7. Build context for Gemini (Opportunity Score 포함)
    const marketContext = topCats.map(cat => {
      const enriched = enrichedScores[cat.catId];
      return {
        category: cat.catId,
        // [VitaView Fix] dominationScore 유지 (하위호환) + opportunityScore 추가
        dominationScore: cat.dominationScore,
        opportunityScore: enriched?.opportunityScore || cat.opportunityScore,
        verdict: enriched?.verdict || cat.verdict,
        scoreBreakdown: enriched?.scoreBreakdown || cat.scoreBreakdown,
        brandCount: cat.brandCount,
        totalProducts: cat.totalProducts,
        avgDailySales: cat.avgDailySales,
        monthlyRevenue: cat.revenue,
        annualRevenue: cat.annualRevenue,
        avgPrice: cat.avgPrice,
        priceRange: `$${cat.minPrice} ~ $${cat.maxPrice}`,
        hhi: cat.hhi,
        topBrand: `${cat.topBrand} (${cat.topShare}%)`,
        top3Share: cat.top3Share,
        bsrVolatility: calculateBSRVolatility(cat.catId),
        healthConcerns: categoryConcernMap[cat.catId]?.map(c => c.label) || [],
        topProducts: cat.topProducts.slice(0, 3).map(p => `${p.brand} - ${p.title} ($${p.price}, Rank #${p.rank})`)
      };
    });

    // Calculate total market size for relevant categories
    const totalAnnualMarket = topCats.reduce((sum, c) => sum + c.annualRevenue, 0);

    // 8. GEMINI PROMPT - 3 Product Recommendations with Market Sizing & ROI
    const systemPrompt = `You are the world's #1 Amazon FBA supplement consultant. You analyze real market data and recommend 3 differentiated products based on the user's target market and preferences. Each recommendation targets a different price point and strategy.

IMPORTANT: Always respond in Korean (한국어). Follow the exact JSON schema. Be bold, data-driven, and decisive.`;

    // Audience label map
    const audienceLabels = {
      gen_z: 'Gen Z (18-27)', millennial: '밀레니얼 (28-43)', gen_x: 'Gen X (44-59)',
      boomer: '시니어 (60+)', athletes: '운동선수/헬스', pregnant: '임산부/수유부',
      kids: '키즈/어린이', vegan: '비건/채식', keto: '키토/저탄고지', busy_pro: '직장인/바쁜 사람'
    };
    const considerationLabels = {
      high_margin: '고마진 우선', low_competition: '경쟁 적은 틈새', trending: '트렌드/성장성',
      repeat_purchase: '반복구매율', easy_manufacture: '제조 용이성', fda_safe: 'FDA 안전성',
      brand_story: '브랜드 스토리', subscription: '구독 모델 적합', social_viral: 'SNS 바이럴',
      patent_possible: '특허/독점 가능', clean_label: '클린라벨/천연', price_sensitive: '가격 경쟁력'
    };

    const marketLabels = marketKeys.map(k => HEALTH_CONCERNS[k]?.label || k).join(', ');
    const audienceList = targetAudience ? targetAudience.split(',').map(k => audienceLabels[k] || k).join(', ') : '';
    const considerationList = considerations ? considerations.split(',').map(k => considerationLabels[k] || k).join(', ') : '';

    const userInputSection = `## 사용자 요청:
- 타겟 시장: ${marketLabels || '전체 (사용자 미선택)'}
- 타겟 고객층: ${audienceList || '없음 (AI 추천)'}
- 제품 기획 고려사항: ${considerationList || '없음 (AI 추천)'}
- 선호 원료: ${preferredIngredients || '없음 (AI 추천)'}
- 선호 제형: ${formType || '없음 (AI 추천)'}
- 초기 투자 예산: $${budget.toLocaleString()}`;

    const userPrompt = `${userInputSection}

## 해당 시장 카테고리 데이터 (${topCats.length}개):
${JSON.stringify(marketContext, null, 2)}

## 연간 시장 규모 (해당 카테고리 합산): $${totalAnnualMarket.toLocaleString()}

## Reddit 소비자 반응:
${JSON.stringify(redditData, null, 2)}

## FDA 안전성 데이터:
${JSON.stringify(fdaData, null, 2)}

## 전체 시장 요약:
- 전체 분석 카테고리: ${scored.length}개
- 해당 분야 카테고리: ${topCats.length}개
- 🟢 즉시 진입 (80점+): ${topCats.filter(s => (enrichedScores[s.catId]?.opportunityScore || s.opportunityScore) >= 80).length}개
- 🟡 재검토 필요 (60-79점): ${topCats.filter(s => { const sc = enrichedScores[s.catId]?.opportunityScore || s.opportunityScore; return sc >= 60 && sc < 80; }).length}개
- 🔴 진입 비추천 (60점 미만): ${topCats.filter(s => (enrichedScores[s.catId]?.opportunityScore || s.opportunityScore) < 60).length}개
- ⛔ 진입 불가 (필터 차단): ${blockedCategories.length}개

## 미션: 3개의 차별화된 제품을 추천해줘.
- 제품1: 프리미엄 전략 (고가, 고마진)
- 제품2: 가성비 전략 (중가, 대량 판매)
- 제품3: 틈새 전략 (독특한 배합/제형으로 차별화)

중요: 사용자가 선택한 타겟 고객층과 고려사항을 반드시 반영해서 제품을 설계해.
${audienceList ? `타겟 고객층(${audienceList})의 니즈, 구매력, 선호도를 고려해.` : ''}
${considerationList ? `특히 다음 사항을 우선적으로 고려해: ${considerationList}` : ''}
각 제품에 대해 시장 파이와 ROI를 반드시 계산해서 포함해줘.
사용자가 선호 원료나 제형을 입력했으면 그것을 반영하되, AI가 더 나은 옵션이 있다고 판단하면 이유와 함께 대안을 제시해.

반드시 아래 JSON으로 답변:
{
  "recommendations": [
    {
      "strategy": "PREMIUM 또는 VALUE 또는 NICHE",
      "productName": "영어 브랜드 제품명",
      "productNameKr": "한국어 제품 설명 한 줄",
      "formType": "제형",
      "tagline": "아마존 카피 한 줄 (영어)",
      "targetCategory": "주요 타겟 카테고리 ID",
      "whyThisProduct": "왜 이 제품인지 2-3문장 (데이터 근거)",
      "ingredients": [
        {"name": "성분명", "dosage": "용량", "reason": "이유"}
      ],
      "pricingStrategy": {
        "suggestedPrice": 가격숫자,
        "targetCOGS": 원가숫자,
        "marginPercent": 마진율숫자,
        "reasoning": "가격 전략 한 줄"
      },
      "marketSizing": {
        "annualMarketSize": 연간시장규모숫자,
        "targetMarketShare": 목표점유율숫자,
        "projectedAnnualRevenue": 예상연매출숫자,
        "projectedMonthlyUnits": 예상월판매량숫자
      },
      "roiProjection": {
        "initialInvestment": 초기투자숫자,
        "monthlyRevenue": 월매출숫자,
        "monthlyCost": 월비용숫자,
        "monthlyProfit": 월순이익숫자,
        "breakEvenMonths": 손익분기월숫자,
        "yearOneROI": 1년ROI퍼센트숫자
      },
      "competitorWeaknesses": [
        {"weakness": "약점", "ourFix": "우리 해결", "impact": "HIGH/MEDIUM/LOW"}
      ],
      "sellingPoints": ["포인트1", "포인트2", "포인트3"],
      "fdaTrafficLight": "GREEN/YELLOW/RED",
      "riskLevel": "LOW/MEDIUM/HIGH",
      "riskNote": "리스크 한 줄"
    }
  ],
  "marketOverall": {
    "totalAnnualMarket": 전체연간시장규모,
    "growthTrend": "성장 추세 한 줄",
    "bestOpportunity": "3개 중 가장 추천하는 것과 이유 2문장"
  }
}`;

    // 9. Call Gemini
    const geminiBody = JSON.stringify({
      contents: [{ parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: "application/json" }
    });

    console.log('🤖 Smart-recommend: calling Gemini with user preferences...');
    console.log('📋 Target:', targetMarket, '| Ingredients:', preferredIngredients, '| Form:', formType, '| Budget:', budget);

    const geminiRes = await callGemini(geminiBody, GEMINI_API_KEY);

    console.log('📡 Gemini response status:', geminiRes.status, '| model:', geminiRes._model || 'unknown');
    if (geminiRes.data?.error) {
      console.log('❌ Gemini error:', JSON.stringify(geminiRes.data.error));
    }

    if (geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      let aiResponse;
      try {
        aiResponse = JSON.parse(geminiRes.data.candidates[0].content.parts[0].text);
      } catch(e) {
        aiResponse = { rawText: geminiRes.data.candidates[0].content.parts[0].text };
      }

      // [VitaView Fix] 응답에 Opportunity Score + scoreBreakdown 포함 (문제 4)
      res.json({
        aiFormulation: aiResponse,
        userInputs: { targetMarket, targetAudience, considerations, preferredIngredients, formType, budget },
        marketData: {
          totalCategories: scored.length,
          relevantCategories: topCats.length,
          totalAnnualMarket,
          // [VitaView Fix] 각 카테고리에 opportunityScore, verdict, scoreBreakdown 포함
          categories: marketContext
        },
        // [VitaView Fix] 진입 불가로 필터된 카테고리 목록 (문제 5)
        blockedCategories: blockedCategories.length > 0 ? blockedCategories : undefined,
        dataSourcesSummary: {
          spApiCategories: scored.length,
          redditPosts: redditData.topPosts?.length || 0,
          fdaIngredients: fdaData.length,
          enrichedWithOpportunityScore: Object.keys(enrichedScores).length,
          blockedByFilter: blockedCategories.length
        },
        // [VitaView v2] 데이터 신뢰도
        dataConfidence: calculateDataConfidence({
          trends: null, reddit: redditData.topPosts?.length > 0 ? { mentionCount: redditData.topPosts.length } : null,
          youtube: null, bsr: trendsCache ? true : null, patents: null
        }),
        // [VitaView v2] AI 추정값 명시
        aiDisclaimer: 'ROI, 예상 매출, 점유율 등 수치는 AI 추정값이며 실제 결과와 다를 수 있습니다.',
        dataFreshness: new Date().toISOString(),
        timestamp: new Date().toISOString()
      });
    } else {
      console.log('❌ Gemini full response:', JSON.stringify(geminiRes.data).slice(0, 500));
      res.json({
        error: 'Gemini response error',
        message: geminiRes.data?.error?.message || 'Gemini API 응답을 파싱할 수 없습니다.',
        details: geminiRes.data
      });
    }
  } catch(e) {
    console.error('Smart-recommend error:', e.message);
    res.status(500).json({ error: 'Smart-recommend failed: ' + e.message });
  }
});

// Step 1: Data Aggregation Pipeline
app.get('/api/ai-formulator/context', async (req, res) => {
  const concern = req.query.concern || 'sleep';
  const concernData = HEALTH_CONCERNS[concern];
  if (!concernData) return res.json({ error: 'Invalid concern. Valid: ' + Object.keys(HEALTH_CONCERNS).join(', ') });

  const context = {
    concern,
    concernLabel: concernData.label,
    timestamp: new Date().toISOString(),
    spApiData: {},
    redditData: {},
    fdaData: {},
    trendsData: {},
    marginData: {}
  };

  // 1. SP-API: Market data + Pain points for relevant categories
  if (trendsCache) {
    for (const catId of concernData.categories.slice(0, 6)) {
      const catData = trendsCache.categories?.[catId];
      if (!catData) continue;
      const avgPrice = catData.avgPrice || 0;
      context.spApiData[catId] = {
        avgPrice: +avgPrice.toFixed(2),
        minPrice: catData.minPrice ? +catData.minPrice.toFixed(2) : null,
        maxPrice: catData.maxPrice ? +catData.maxPrice.toFixed(2) : null,
        totalProducts: catData.totalProducts || 0,
        avgDailySales: catData.avgDailySales || 0,
        topBrand: catData.topBrand || 'Unknown',
        topBrandShare: catData.topBrandShare || 0,
        brandCount: catData.brandCount || Object.keys(catData.brands || {}).length,
        hhi: catData.hhi || 0,
        topProducts: (catData.topProducts || []).slice(0, 3).map(p => ({
          title: p.title, brand: p.brand, price: p.price, rank: p.rank,
          dailySales: estimateDailySales(p.rank)
        })),
        targetCOGS: +(avgPrice * 0.33).toFixed(2),
        estimatedMonthlyProfit: Math.round((catData.avgDailySales || 10) * 30 * avgPrice * 0.34)
      };
    }
  }

  // 2. Reddit: Trending ingredients + pain points from relevant subreddits
  try {
    const redditPosts = [];
    const searchTerms = [
      `${concernData.label} supplement`,
      `best ${concern} supplement 2025`,
      `${concern} supplement side effects`
    ];
    for (const query of searchTerms.slice(0, 2)) {
      try {
        const result = await httpsGet('www.reddit.com',
          `/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=month&limit=15`,
          { 'User-Agent': 'VitaView/1.0 (supplement research)' }
        );
        (result.data?.data?.children || []).forEach(p => {
          const d = p.data;
          if (d && !d.stickied) {
            redditPosts.push({
              title: d.title, selftext: (d.selftext || '').slice(0, 400),
              subreddit: d.subreddit, score: d.score, numComments: d.num_comments
            });
          }
        });
      } catch(e) {}
      await new Promise(r => setTimeout(r, 1000));
    }

    // Extract trending ingredients from Reddit
    const ingredientMentions = {};
    const complaints = [];
    const recommendations = [];

    const complainKeywords = ['side effect', 'stomach', 'nausea', 'doesn\'t work', 'waste', 'too big', 'smell', 'taste awful', 'overpriced', 'fake', 'ineffective'];
    const positiveKeywords = ['amazing', 'works great', 'recommend', 'life changing', 'best', 'game changer', 'finally found', 'love this'];

    redditPosts.forEach(post => {
      const text = (post.title + ' ' + post.selftext).toLowerCase();

      // Count ingredient mentions
      concernData.categories.forEach(catId => {
        const name = catId.replace(/_/g, ' ').toLowerCase();
        if (text.includes(name)) {
          ingredientMentions[name] = (ingredientMentions[name] || 0) + 1;
        }
      });

      // Extract complaints
      complainKeywords.forEach(kw => {
        if (text.includes(kw)) {
          complaints.push({ keyword: kw, title: post.title.slice(0, 100), score: post.score });
        }
      });

      // Extract positive mentions
      positiveKeywords.forEach(kw => {
        if (text.includes(kw)) {
          recommendations.push({ keyword: kw, title: post.title.slice(0, 100), score: post.score });
        }
      });
    });

    context.redditData = {
      postsAnalyzed: redditPosts.length,
      trendingIngredients: Object.entries(ingredientMentions).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, mentions: count })),
      topComplaints: complaints.sort((a, b) => b.score - a.score).slice(0, 5),
      topRecommendations: recommendations.sort((a, b) => b.score - a.score).slice(0, 5),
      rawTopPosts: redditPosts.sort((a, b) => b.score - a.score).slice(0, 5).map(p => ({ title: p.title, score: p.score, subreddit: p.subreddit }))
    };
  } catch(e) {
    context.redditData = { error: e.message };
  }

  // 3. OpenFDA: Safety data for relevant ingredients
  try {
    const fdaResults = [];
    for (const catId of concernData.categories.slice(0, 5)) {
      const ingName = catId.replace(/_/g, ' ');
      const cacheKey = ingName.toLowerCase();
      if (fdaCache[cacheKey] && Date.now() - fdaCache[cacheKey].time < FDA_CACHE_TTL) {
        fdaResults.push({ ingredient: ingName, ...fdaCache[cacheKey].data });
        continue;
      }
      try {
        const aeRes = await httpsGet('api.fda.gov', `/food/event.json?search=products.name_brand:"${encodeURIComponent(ingName)}"&limit=1`, {});
        const recallRes = await httpsGet('api.fda.gov', `/food/enforcement.json?search=reason_for_recall:"${encodeURIComponent(ingName)}"&limit=1`, {});
        const aeTotal = aeRes.data?.meta?.results?.total || 0;
        const recallTotal = recallRes.data?.meta?.results?.total || 0;
        const safety = calculateSafetyScore({ adverseEvents: { total: aeTotal }, recalls: { total: recallTotal } });
        fdaResults.push({ ingredient: ingName, adverseEvents: aeTotal, recalls: recallTotal, safetyScore: safety });
      } catch(e) {
        fdaResults.push({ ingredient: ingName, adverseEvents: 0, recalls: 0, safetyScore: 95 });
      }
      await new Promise(r => setTimeout(r, 300));
    }
    context.fdaData = { ingredients: fdaResults };
  } catch(e) {
    context.fdaData = { error: e.message };
  }

  // 4. Google Trends: Consumer interest
  try {
    const trendSuggestions = [];
    for (const catId of concernData.categories.slice(0, 3)) {
      const q = CATEGORY_KEYWORDS[catId] || catId.replace(/_/g, ' ');
      try {
        const result = await httpsGet('suggestqueries.google.com',
          `/complete/search?client=firefox&q=${encodeURIComponent(q + ' supplement')}`,
          { 'User-Agent': 'Mozilla/5.0' }
        );
        const suggestions = Array.isArray(result.data) ? result.data[1] || [] : [];
        trendSuggestions.push({ keyword: q, suggestions: suggestions.slice(0, 5) });
      } catch(e) {}
      await new Promise(r => setTimeout(r, 300));
    }
    context.trendsData = { googleSuggestions: trendSuggestions };
  } catch(e) {
    context.trendsData = { error: e.message };
  }

  // 5. Margin data for relevant categories
  for (const catId of concernData.categories.slice(0, 6)) {
    const catData = trendsCache?.categories?.[catId];
    if (!catData || !catData.avgPrice) continue;
    const avgPrice = catData.avgPrice;
    context.marginData[catId] = {
      avgPrice: +avgPrice.toFixed(2),
      targetCOGS: +(avgPrice * 0.33).toFixed(2),
      amazonFees: +(avgPrice * 0.33).toFixed(2),
      profitPerUnit: +(avgPrice * 0.34).toFixed(2),
      monthlyProfit: Math.round((catData.avgDailySales || 10) * 30 * avgPrice * 0.34),
      viability: avgPrice * 0.33 >= 8 ? 'EXCELLENT' : avgPrice * 0.33 >= 5 ? 'GOOD' : avgPrice * 0.33 >= 3 ? 'FEASIBLE' : 'TIGHT'
    };
  }

  res.json(context);
});

// Step 2: Gemini LLM Integration - The Formulator
app.get('/api/ai-formulator/generate', async (req, res) => {
  const concern = req.query.concern || 'sleep';

  // First, get the aggregated context
  let contextData;
  try {
    const contextUrl = `/api/ai-formulator/context?concern=${concern}`;
    // Internal fetch - reuse the context logic
    const contextReq = { query: { concern } };
    const concernData = HEALTH_CONCERNS[concern];
    if (!concernData) return res.json({ error: 'Invalid concern' });

    // Build context inline (same as /context endpoint)
    contextData = { concern, concernLabel: concernData.label, spApiData: {}, redditData: {}, fdaData: {}, trendsData: {}, marginData: {} };

    // SP-API data
    if (trendsCache) {
      for (const catId of concernData.categories.slice(0, 6)) {
        const catData = trendsCache.categories?.[catId];
        if (!catData) continue;
        const avgPrice = catData.avgPrice || 0;
        contextData.spApiData[catId] = {
          avgPrice: +avgPrice.toFixed(2), totalProducts: catData.totalProducts || 0,
          avgDailySales: catData.avgDailySales || 0, topBrand: catData.topBrand || 'Unknown',
          topBrandShare: catData.topBrandShare || 0, brandCount: Object.keys(catData.brands || {}).length,
          hhi: catData.hhi || 0,
          topProducts: (catData.topProducts || []).slice(0, 3).map(p => ({ title: p.title, brand: p.brand, price: p.price, rank: p.rank })),
          targetCOGS: +(avgPrice * 0.33).toFixed(2)
        };
      }
    }

    // Reddit data
    try {
      const redditPosts = [];
      const query = `${concernData.label} supplement`;
      const result = await httpsGet('www.reddit.com',
        `/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=month&limit=20`,
        { 'User-Agent': 'VitaView/1.0 (supplement research)' }
      );
      (result.data?.data?.children || []).forEach(p => {
        const d = p.data;
        if (d && !d.stickied) redditPosts.push({ title: d.title, selftext: (d.selftext || '').slice(0, 300), score: d.score });
      });
      contextData.redditData = {
        topPosts: redditPosts.sort((a, b) => b.score - a.score).slice(0, 8).map(p => `[Score:${p.score}] ${p.title}`)
      };
    } catch(e) { contextData.redditData = { error: e.message }; }

    // FDA data
    try {
      const fdaResults = [];
      for (const catId of concernData.categories.slice(0, 4)) {
        const ingName = catId.replace(/_/g, ' ');
        try {
          const aeRes = await httpsGet('api.fda.gov', `/food/event.json?search=products.name_brand:"${encodeURIComponent(ingName)}"&limit=1`, {});
          fdaResults.push({ ingredient: ingName, adverseEvents: aeRes.data?.meta?.results?.total || 0 });
        } catch(e) { fdaResults.push({ ingredient: ingName, adverseEvents: 0 }); }
        await new Promise(r => setTimeout(r, 200));
      }
      contextData.fdaData = fdaResults;
    } catch(e) {}

    // Margin data
    for (const catId of concernData.categories.slice(0, 6)) {
      const catData = trendsCache?.categories?.[catId];
      if (!catData) continue;
      contextData.marginData[catId] = {
        avgPrice: +(catData.avgPrice || 0).toFixed(2),
        targetCOGS: +((catData.avgPrice || 0) * 0.33).toFixed(2),
        monthlyProfit: Math.round((catData.avgDailySales || 10) * 30 * (catData.avgPrice || 0) * 0.34)
      };
    }

  } catch(e) {
    return res.status(500).json({ error: 'Context aggregation failed: ' + e.message });
  }

  // Build the formulator prompt
  const systemPrompt = `You are a top Amazon FBA seller and a certified supplement formulator/pharmacist. You analyze real market data and produce actionable product plans.

IMPORTANT: Always respond in Korean (한국어). Follow the exact JSON schema. Be concise and data-driven.`;

  const userPrompt = `아래 실시간 데이터를 분석해서 아마존 독점 가능한 건기식 신제품 기획안을 1개 제안해.

## 분석 대상: ${contextData.concernLabel}

## 데이터:
### 아마존 SP-API:
${JSON.stringify(contextData.spApiData, null, 2)}
### Reddit:
${JSON.stringify(contextData.redditData, null, 2)}
### FDA:
${JSON.stringify(contextData.fdaData, null, 2)}
### 마진:
${JSON.stringify(contextData.marginData, null, 2)}

## 반드시 아래 JSON으로 답변:
{
  "productName": "영어 브랜드 제품명",
  "productNameKr": "한국어 제품 설명 (한 줄)",
  "formType": "제형 (구미, 리포조말 소프트젤, 분말스틱 등)",
  "tagline": "아마존 상세페이지 첫 줄 영어 카피 (한 문장)",
  "viralMomentumScore": 0에서100사이숫자(Reddit언급량+트렌드+관심도 종합),
  "complaintsBreakdown": [
    {"complaint": "불만 유형 (예: 알약 크기)", "percentage": 퍼센트숫자, "source": "데이터 근거"}
  ],
  "fdaTrafficLight": "GREEN 또는 YELLOW 또는 RED",
  "fdaOneLiner": "FDA 관련 주의사항 딱 한 줄",
  "ingredients": [
    {"name": "성분명", "dosage": "용량", "reason": "배합 이유 (한 줄)"}
  ],
  "synergyOneLiner": "성분 배합 시너지 핵심 한 줄",
  "competitorWeaknesses": [
    {"weakness": "기존 약점", "ourFix": "우리 해결법", "impact": "HIGH/MEDIUM/LOW"}
  ],
  "pricingStrategy": {
    "suggestedPrice": 가격,
    "targetCOGS": 원가,
    "monthlyProfit": 월순이익,
    "reasoning": "가격 전략 한 줄"
  },
  "sellingPoints": ["셀링포인트1", "셀링포인트2", "셀링포인트3"],
  "amazonTitle": "아마존 상품 타이틀 영어 200자 이내",
  "dominationReason": "독점 가능 핵심 이유 2-3문장"
}`;

  // Call Gemini API
  if (!GEMINI_API_KEY) {
    return res.json({
      error: 'GEMINI_API_KEY not set',
      message: 'Gemini API 키가 필요합니다. .env 파일에 GEMINI_API_KEY=your_key를 추가해주세요.',
      howToGet: 'https://aistudio.google.com/apikey 에서 무료로 발급 가능합니다.',
      contextData
    });
  }

  try {
    const geminiBody = JSON.stringify({
      contents: [{ parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 4096,
        responseMimeType: "application/json"
      }
    });

    const geminiRes = await callGemini(geminiBody, GEMINI_API_KEY);

    if (geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      let aiResponse;
      try {
        aiResponse = JSON.parse(geminiRes.data.candidates[0].content.parts[0].text);
      } catch(e) {
        aiResponse = { rawText: geminiRes.data.candidates[0].content.parts[0].text };
      }

      res.json({
        concern,
        concernLabel: contextData.concernLabel,
        aiFormulation: aiResponse,
        dataSourcesSummary: {
          spApiCategories: Object.keys(contextData.spApiData).length,
          redditPosts: contextData.redditData?.topPosts?.length || 0,
          fdaIngredients: contextData.fdaData?.length || 0
        },
        timestamp: new Date().toISOString()
      });
    } else {
      res.json({ error: 'Gemini response error', message: geminiRes.data?.error?.message || 'Gemini API 응답 실패', details: geminiRes.data, contextData });
    }
  } catch(e) {
    res.status(500).json({ error: 'Gemini API call failed: ' + e.message, contextData });
  }
});

// ═══════════════════════════════════════════════════════════
// [VitaView v2] 작업 3: 카테고리 비교 API
// ═══════════════════════════════════════════════════════════

// GET /api/compare?keywords=omega3,magnesium,collagen
app.get('/api/compare', async (req, res) => {
  const keywordsParam = req.query.keywords;
  if (!keywordsParam) return res.status(400).json({ error: 'keywords 파라미터 필요 (콤마 구분)' });
  const keywords = keywordsParam.split(',').map(k => k.trim());
  if (keywords.length > 10) {
    return res.status(400).json({ error: '최대 10개 키워드까지 비교 가능합니다.' });
  }

  try {
    const results = await Promise.allSettled(
      keywords.map(async keyword => {
        // trendsCache에서 매칭 카테고리 찾기
        const catId = Object.keys(CATEGORY_KEYWORDS).find(k =>
          k.toLowerCase() === keyword.toLowerCase() ||
          CATEGORY_KEYWORDS[k].toLowerCase().includes(keyword.toLowerCase())
        ) || keyword;
        const catData = trendsCache?.categories?.[catId];
        if (!catData) return { keyword, opportunityScore: null, error: 'Category not found' };

        const scoreResult = calculateOpportunityScore(
          { catId, hhi: catData.hhi, brandCount: catData.brandCount || Object.keys(catData.brands || {}).length,
            topShare: catData.topBrandShare, topBrandShare: catData.topBrandShare, topProducts: catData.topProducts || [] },
          {}
        );
        return { keyword, ...scoreResult, hhi: catData.hhi, brandCount: catData.brandCount, avgPrice: catData.avgPrice, revenue: catData.estimatedMonthlyRevenue };
      })
    );

    const ranked = results
      .map((result, i) => ({
        keyword: keywords[i],
        ...(result.status === 'fulfilled' ? result.value : { error: result.reason?.message, opportunityScore: null })
      }))
      .sort((a, b) => (b.opportunityScore || 0) - (a.opportunityScore || 0))
      .map((item, index) => ({ ...item, rank: index + 1 }));

    // DB 저장
    const today = new Date().toISOString().split('T')[0];
    try {
      runTransaction(() => {
        ranked.forEach((item, index) => {
          if (item.opportunityScore !== null) {
            saveCategoryRanking({
              category: 'comparison', keyword: item.keyword,
              opportunity_score: item.opportunityScore, rank_position: index + 1,
              score_breakdown: item.scoreBreakdown, snapshot_date: today
            });
          }
        });
      });
    } catch(e) { /* DB 저장 실패 무시 */ }

    // 데이터 신뢰도 추가
    const dataConfidence = calculateDataConfidence({
      trends: null, reddit: null, youtube: null,
      bsr: trendsCache ? true : null, patents: null
    });

    res.json({
      comparedAt: new Date().toISOString(),
      totalCompared: keywords.length,
      winner: ranked[0],
      rankings: ranked,
      dataConfidence
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/compare/history?days=30
app.get('/api/compare/history', (req, res) => {
  const { days = 30 } = req.query;
  const history = db.prepare(`
    SELECT * FROM category_rankings
    WHERE snapshot_date > date('now', '-' || ? || ' days')
    ORDER BY snapshot_date DESC, rank_position ASC
  `).all(days);
  res.json({ periodDays: days, history });
});

// ═══════════════════════════════════════════════════════════
// [VitaView v2] 작업 5: 신흥 키워드 자동 감지
// ═══════════════════════════════════════════════════════════

const BASE_CATEGORIES = [
  'supplements', 'vitamins', 'protein', 'collagen', 'probiotics',
  'omega3', 'magnesium', 'vitamin d', 'creatine', 'ashwagandha',
  'turmeric', 'melatonin', 'zinc', 'iron supplement', 'b12'
];

async function detectEmergingKeywords() {
  const emerging = [];

  for (const baseKeyword of BASE_CATEGORIES) {
    try {
      // Google Suggestions 활용
      const sgRes = await httpsGet('suggestqueries.google.com',
        `/complete/search?client=firefox&q=${encodeURIComponent(baseKeyword + ' supplement')}`,
        { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      );
      const suggestions = Array.isArray(sgRes.data) ? sgRes.data[1] || [] : [];

      for (const suggestion of suggestions.slice(0, 5)) {
        try {
          // Reddit에서 언급 빈도 확인
          const redditRes = await httpsGet('www.reddit.com',
            `/search.json?q=${encodeURIComponent(suggestion)}&sort=new&t=week&limit=10`,
            { 'User-Agent': 'VitaView/1.0 (supplement research)' }
          );
          const posts = redditRes.data?.data?.children || [];
          const currentVelocity = posts.length;

          const result = upsertEmergingKeyword({ keyword: suggestion, mention_velocity: currentVelocity, source: 'reddit' });

          if (currentVelocity > 5) {
            emerging.push({ keyword: suggestion, status: 'new', velocity: currentVelocity });
          }
        } catch(e) { /* skip */ }
        await new Promise(r => setTimeout(r, 500));
      }
    } catch(e) { /* skip */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return emerging.sort((a, b) => b.velocity - a.velocity);
}

app.get('/api/emerging', async (req, res) => {
  try {
    const fromDB = getEmergingKeywords(20);

    if (fromDB.length === 0) {
      const fresh = await detectEmergingKeywords();
      return res.json({ source: 'fresh', detectedAt: new Date().toISOString(), keywords: fresh });
    }
    res.json({ source: 'db', detectedAt: fromDB[0]?.last_updated, keywords: fromDB });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// [VitaView v2] 작업 6: 경쟁사 신제품 모니터링
// ═══════════════════════════════════════════════════════════

// SP-API 제품 데이터를 competitor_products 테이블에 자동 upsert
function trackCompetitorProducts(catId, topProducts) {
  if (!topProducts || topProducts.length === 0) return;
  try {
    runTransaction(() => {
      topProducts.forEach(p => {
        if (p.asin) {
          upsertCompetitorProduct({
            asin: p.asin, product_name: p.title, category: catId,
            bsr: p.rank, price: p.price
          });
        }
      });
    });
  } catch(e) { /* DB 저장 실패 무시 */ }
}

// GET /api/new-products?category=supplements&days=90
app.get('/api/new-products', async (req, res) => {
  const { category = 'supplements', days = 90 } = req.query;
  try {
    const products = db.prepare(`
      SELECT * FROM competitor_products
      WHERE is_new_product = 1 AND category = ?
      AND first_seen_at > datetime('now', '-' || ? || ' days')
      ORDER BY first_seen_at DESC LIMIT 50
    `).all(category, days);

    res.json({
      category, monitoringPeriodDays: parseInt(days),
      newProductsFound: products.length,
      products: products.map(p => ({
        asin: p.asin, productName: p.product_name,
        price: p.price, firstSeenAt: p.first_seen_at,
        bsrTrend: calculateBSRTrend(p.bsr_history)
      }))
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// [VitaView v2] 작업 7: Gemini AI 전략 분석 프롬프트 강화
// ═══════════════════════════════════════════════════════════

let geminiStrategyCache = {};
const GEMINI_STRATEGY_CACHE_TTL = 6 * 60 * 60 * 1000; // 6시간

async function getGeminiStrategyAnalysis(keyword, opportunityData) {
  const cacheKey = keyword.toLowerCase();
  if (geminiStrategyCache[cacheKey] && Date.now() - geminiStrategyCache[cacheKey].time < GEMINI_STRATEGY_CACHE_TTL) {
    return geminiStrategyCache[cacheKey].data;
  }

  if (!GEMINI_API_KEY) return null;

  const prompt = `당신은 아마존 서플리먼트 시장 전문 분석가입니다. 아래 데이터를 분석해서 신제품 진입 전략을 알려주세요.

## 분석 대상: ${keyword}
## 시장 데이터:
- HHI 지수: ${opportunityData.hhi || 'N/A'} (${(opportunityData.hhi || 0) < 1500 ? '분산 시장' : '집중 시장'})
- Google Trends 성장률: ${opportunityData.trendGrowthRate || 'N/A'}%
- Reddit 부정 언급 비율: ${opportunityData.redditNegativeRatio || 'N/A'}%
- Opportunity Score: ${opportunityData.opportunityScore || 'N/A'}점 / 100점
- 특허 현황: ${opportunityData.patentStatus || 'N/A'}
- 예상 마진: ${opportunityData.estimatedMargin || 'N/A'}%

## 요청사항 (반드시 아래 형식으로만 답변):
1. **한줄 결론** (진입 추천 여부와 이유, 20자 이내)
2. **차별화 포인트 TOP 3** (소비자 불만 기반, 각 1줄)
3. **예상 리스크 TOP 2** (각 1줄)
4. **첫 3개월 액션 플랜** (3단계, 각 1줄)`;

  try {
    const geminiBody = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
    });

    const response = await callGemini(geminiBody, GEMINI_API_KEY);

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const result = {
      summary: text || 'AI 분석 실패',
      generatedAt: new Date().toISOString(),
      model: response._model || 'gemini-2.5-flash-lite',
      isAIGenerated: true
    };
    geminiStrategyCache[cacheKey] = { data: result, time: Date.now() };
    return result;
  } catch(e) {
    return { summary: 'AI 분석 실패: ' + e.message, isAIGenerated: true, error: true };
  }
}

// ═══════════════════════════════════════════════════════════
// [VitaView v2] 작업 8: OpenFDA 강화 + DB 저장
// ═══════════════════════════════════════════════════════════

async function analyzeFDASignals(ingredient) {
  const today = new Date().toISOString().split('T')[0];
  const cached = getFDASignal(ingredient.toLowerCase(), today);
  if (cached) return cached;

  try {
    const adverseUrl = `/food/enforcement.json?search=product_description:"${encodeURIComponent(ingredient)}"&count=report_date`;
    const adverseData = await httpsGet('api.fda.gov', adverseUrl, {});

    const results = adverseData.data?.results || [];
    const recentCount = results.slice(-3).reduce((a, b) => a + (b.count || 0), 0);
    const prevCount = results.slice(-6, -3).reduce((a, b) => a + (b.count || 0), 0);
    const trend = recentCount > prevCount * 1.3 ? 'increasing' : recentCount < prevCount * 0.7 ? 'decreasing' : 'stable';
    const opportunityFlag = trend !== 'stable';

    saveFDASignal({
      ingredient: ingredient.toLowerCase(),
      adverse_event_count: recentCount,
      adverse_event_trend: trend,
      new_approval: false,
      opportunity_flag: opportunityFlag,
      snapshot_date: today
    });

    return { ingredient, adverse_event_count: recentCount, adverse_event_trend: trend, opportunity_flag: opportunityFlag };
  } catch(e) {
    return { ingredient, adverse_event_count: 0, adverse_event_trend: 'unknown', opportunity_flag: false, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════
// [VitaView v2] 작업 10: 히스토리 + 대시보드 API
// ═══════════════════════════════════════════════════════════

// GET /api/history?keyword=omega3&days=30
app.get('/api/history', (req, res) => {
  const { keyword, days = 30 } = req.query;
  if (!keyword) return res.status(400).json({ error: 'keyword 파라미터 필요' });

  try {
    const history = db.prepare(`
      SELECT keyword, opportunity_score, verdict, hhi_score,
             trend_growth_rate, reddit_negative_ratio, created_at
      FROM trend_snapshots
      WHERE keyword = ? AND created_at > datetime('now', '-' || ? || ' days')
      ORDER BY created_at ASC
    `).all(keyword, days);

    res.json({
      keyword, periodDays: parseInt(days), dataPoints: history.length, history,
      scoreChange: history.length >= 2
        ? history[history.length - 1].opportunity_score - history[0].opportunity_score : null
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboard
app.get('/api/dashboard', (req, res) => {
  try {
    const topOpportunities = db.prepare(`
      SELECT keyword, opportunity_score, verdict, trend_growth_rate, hhi_score, MAX(created_at) as latest
      FROM trend_snapshots GROUP BY keyword ORDER BY opportunity_score DESC LIMIT 10
    `).all();

    const emergingKeywords = db.prepare(`
      SELECT * FROM emerging_keywords WHERE status IN ('new', 'rising')
      ORDER BY mention_velocity DESC LIMIT 5
    `).all();

    const newProducts = db.prepare(`
      SELECT * FROM competitor_products WHERE is_new_product = 1
      ORDER BY first_seen_at DESC LIMIT 10
    `).all();

    const fdaSignals = db.prepare(`
      SELECT * FROM fda_signals WHERE opportunity_flag = 1
      ORDER BY snapshot_date DESC LIMIT 5
    `).all();

    res.json({ generatedAt: new Date().toISOString(), topOpportunities, emergingKeywords, newProducts, fdaSignals });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// [VitaView v2] 작업 9: 자동 스냅샷 스케줄러
// ═══════════════════════════════════════════════════════════

const MONITORED_KEYWORDS = [
  'omega3', 'magnesium', 'collagen', 'vitamin d', 'probiotics',
  'creatine', 'ashwagandha', 'turmeric', 'melatonin', 'zinc',
  'protein powder', 'multivitamin', 'iron supplement', 'b12', 'coq10'
];

// 매일 오전 6시 (UTC) 전체 스냅샷
cron.schedule('0 6 * * *', async () => {
  console.log('[VitaView Cron] 일일 스냅샷 시작...');
  for (const keyword of MONITORED_KEYWORDS) {
    try {
      const catId = Object.keys(CATEGORY_KEYWORDS).find(k =>
        k.toLowerCase() === keyword.toLowerCase() ||
        CATEGORY_KEYWORDS[k].toLowerCase().includes(keyword.toLowerCase())
      );
      const catData = trendsCache?.categories?.[catId];
      if (!catData) continue;

      const scoreResult = calculateOpportunityScore(
        { catId: catId || keyword, hhi: catData.hhi, brandCount: catData.brandCount || Object.keys(catData.brands || {}).length,
          topShare: catData.topBrandShare, topBrandShare: catData.topBrandShare, topProducts: catData.topProducts || [] },
        {}
      );

      saveTrendSnapshot({
        keyword, category: catId || 'general',
        google_trends_value: scoreResult.scoreBreakdown?.trendMomentum?.currentValue || null,
        google_trends_3m_avg: scoreResult.scoreBreakdown?.trendMomentum?.recent3mAvg || null,
        google_trends_prev_3m_avg: scoreResult.scoreBreakdown?.trendMomentum?.prev3mAvg || null,
        trend_growth_rate: scoreResult.scoreBreakdown?.trendMomentum?.growthRate || null,
        reddit_mention_count: scoreResult.scoreBreakdown?.consumerDissatisfaction?.redditMentionCount || null,
        reddit_negative_ratio: scoreResult.scoreBreakdown?.consumerDissatisfaction?.negativeRatio || null,
        youtube_view_count: scoreResult.scoreBreakdown?.demandSignal?.youtubeViewCount || null,
        youtube_video_count: scoreResult.scoreBreakdown?.demandSignal?.youtubeVideoCount || null,
        bsr_value: scoreResult.scoreBreakdown?.marketAccessibility?.bsr || null,
        hhi_score: scoreResult.scoreBreakdown?.marketAccessibility?.hhi || catData.hhi || null,
        opportunity_score: scoreResult.opportunityScore, verdict: scoreResult.verdict
      });
      console.log(`[VitaView Cron] ${keyword} 저장 완료`);
    } catch (err) {
      console.error(`[VitaView Cron] ${keyword} 실패:`, err.message);
    }
  }
});

// 매 6시간마다 신흥 키워드 감지
cron.schedule('0 */6 * * *', async () => {
  console.log('[VitaView Cron] 신흥 키워드 감지 시작...');
  try {
    await detectEmergingKeywords();
    console.log('[VitaView Cron] 신흥 키워드 감지 완료');
  } catch(e) {
    console.error('[VitaView Cron] 신흥 키워드 감지 실패:', e.message);
  }
});

// ═══════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`🚀 VitaView Backend running on http://localhost:${PORT}`);
  console.log(`📋 Mode: LIVE (SP-API direct HTTP)`);
  console.log('[VitaView v2] SQLite DB, Google Trends npm, node-cron 활성화');
  getAccessToken()
    .then(() => {
      console.log('✅ SP-API connected!');
      console.log('📊 Pre-fetching trends data...');
      return fetchTrendsData();
    })
    .then(data => {
      trendsCache = data;
      trendsCacheTime = Date.now();
      console.log('✅ Trends data pre-cached! First load will be instant.');
      // [VitaView v2] 초기 로드 시 경쟁사 제품 DB 추적 시작
      Object.entries(data.categories || {}).forEach(([catId, catData]) => {
        trackCompetitorProducts(catId, catData.topProducts);
      });
    })
    .catch(e => console.log('⚠️ SP-API:', e.message));
});