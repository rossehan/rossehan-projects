require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const querystring = require('querystring');

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

// Batch helper: fetch in groups of BATCH_SIZE with delay between batches
async function fetchInBatches(entries, batchSize = 10, delayMs = 1500) {
  const results = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(([id, keyword]) =>
        spApiGet(`/catalog/2022-04-01/items?keywords=${encodeURIComponent(keyword)}&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,attributes,salesRanks,images`)
          .then(r => ({ id, data: r.data }))
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

// ──── KEYWORD INTELLIGENCE ────

const STOP_WORDS = new Set([
  'the','a','an','and','or','for','with','in','of','to','by','is','it','at','on','as','from','that','this',
  'mg','mcg','count','caps','capsule','capsules','tablet','tablets','softgel','softgels','gummy','gummies',
  'supplement','supplements','serving','servings','supply','day','days','month','months','week','weeks',
  'made','usa','pack','per','oz','fl','lb','lbs','each','size','ct','bottle','bottles',
  'non','gmo','free','gluten','vegan','organic','natural','premium','extra','strength',
  'men','women','adult','adults','kids','children','unflavored','flavor','flavored'
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

app.listen(PORT, () => {
  console.log(`🚀 VitaView Backend running on http://localhost:${PORT}`);
  console.log(`📋 Mode: LIVE (SP-API direct HTTP)`);
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
    })
    .catch(e => console.log('⚠️ SP-API:', e.message));
});