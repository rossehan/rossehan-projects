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
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    );
    const suggestions = Array.isArray(result.data) ? (result.data[1] || []) : [];
    const response = { query: q, suggestions, timestamp: new Date().toISOString() };
    amazonSuggestCache[cacheKey] = { data: response, time: Date.now() };
    res.json(response);
  } catch(e) {
    res.json({ query: q, suggestions: [], error: e.message });
  }
});

app.get('/api/longtail-keywords', async (req, res) => {
  // Use trendsCache to get main keywords from SP-API categories
  if (!trendsCache) {
    return res.json({ error: 'Trends data not loaded yet. Please wait for initial data fetch.', keywords: {} });
  }

  const requestedCategory = req.query.category; // optional: specific category
  const categories = trendsCache.categories || {};
  const categoryIds = requestedCategory ? [requestedCategory] : Object.keys(categories).slice(0, 20); // limit to 20 at a time

  const results = {};
  for (const catId of categoryIds) {
    const catData = categories[catId];
    if (!catData) continue;

    // Build seed keywords from category name + top product titles
    const seedKeywords = [];
    // Category name itself (convert id to search term)
    const catName = catId.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim().toLowerCase();
    seedKeywords.push(catName + ' supplement');

    // Extract top brand keywords
    if (catData.topProducts?.length > 0) {
      // Get unique meaningful words from top 3 product titles
      const topTitles = catData.topProducts.slice(0, 3).map(p => p.title || '');
      const commonWords = new Set(['the','a','an','and','or','for','with','in','of','to','by','is','mg','ct','count','pack','capsules','tablets','softgels','gummies','supplement','supply','day','days','month','serving','servings','size','made','usa','non','gmo','free','gluten','vegan','organic','natural','premium','best']);
      const titleWords = topTitles.join(' ').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3 && !commonWords.has(w));
      const wordFreq = {};
      titleWords.forEach(w => { wordFreq[w] = (wordFreq[w] || 0) + 1; });
      const topWords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
      topWords.forEach(w => {
        if (w !== catName) seedKeywords.push(w + ' supplement');
      });
    }

    // Fetch Amazon autocomplete for each seed keyword
    const longtailKeywords = [];
    for (const seed of seedKeywords.slice(0, 4)) { // max 4 seeds per category
      const cacheKey = seed;
      let suggestions = [];

      if (amazonSuggestCache[cacheKey] && Date.now() - amazonSuggestCache[cacheKey].time < AMAZON_SUGGEST_CACHE_TTL) {
        suggestions = amazonSuggestCache[cacheKey].data.suggestions || [];
      } else {
        try {
          const result = await httpsGet(
            'completion.amazon.com',
            `/search/complete?search-alias=aps&client=amazon-search-ui&mkt=1&q=${encodeURIComponent(seed)}`,
            { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          );
          suggestions = Array.isArray(result.data) ? (result.data[1] || []) : [];
          amazonSuggestCache[cacheKey] = { data: { query: seed, suggestions }, time: Date.now() };
        } catch(e) {
          console.log(`Amazon suggest error for "${seed}":`, e.message);
        }
        // Rate limit: 500ms between requests
        await new Promise(r => setTimeout(r, 500));
      }

      suggestions.forEach(s => {
        if (!longtailKeywords.find(k => k.keyword === s)) {
          longtailKeywords.push({
            keyword: s,
            seed,
            wordCount: s.split(/\s+/).length,
            isLongTail: s.split(/\s+/).length >= 3
          });
        }
      });
    }

    results[catId] = {
      categoryName: catName,
      seedKeywords,
      longtailKeywords: longtailKeywords.sort((a, b) => b.wordCount - a.wordCount),
      totalFound: longtailKeywords.length,
      longTailCount: longtailKeywords.filter(k => k.isLongTail).length
    };
  }

  res.json({
    keywords: results,
    totalCategories: Object.keys(results).length,
    timestamp: new Date().toISOString()
  });
});

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

// ===== MODULE 3: Entry Barrier & Legal Risk Checker =====
app.get('/api/legal-barrier', async (req, res) => {
  const category = req.query.category;
  if (!category) return res.json({ error: 'Category parameter required' });

  const catData = trendsCache?.categories?.[category];
  if (!catData) return res.json({ error: 'Category data not found. Load trends first.' });

  const catName = category.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim().toLowerCase();
  const searchTerm = CATEGORY_KEYWORDS[category] || catName;

  // 1. Brand Concentration Analysis (from SP-API data)
  const brands = catData.brands || {};
  const brandEntries = Object.entries(brands).sort((a, b) => b[1].count - a[1].count);
  const totalProducts = catData.totalProducts || brandEntries.reduce((s, [, d]) => s + d.count, 0);
  const topBrand = brandEntries[0];
  const topBrandShare = topBrand ? Math.round(topBrand[1].count / totalProducts * 100) : 0;
  const top3Share = brandEntries.slice(0, 3).reduce((s, [, d]) => s + d.count, 0) / Math.max(1, totalProducts) * 100;
  const brandCount = brandEntries.length;
  const hhi = catData.hhi || 0;

  // 2. Trademark density estimation based on brand count
  const trademarkDensity = Math.min(100, Math.round(brandCount * 2));

  // 3. Legal barrier score calculation
  // High HHI = monopolistic = harder to enter
  // High top brand share = dominant player = harder
  // Few brands = consolidated market = harder
  const hhiScore = Math.min(100, Math.round(hhi / 100)); // 0-100
  const dominanceScore = Math.min(100, Math.round(topBrandShare * 1.5));
  const consolidationScore = brandCount < 5 ? 90 : brandCount < 10 ? 70 : brandCount < 20 ? 50 : brandCount < 30 ? 30 : 10;
  const barrierScore = Math.round(hhiScore * 0.35 + dominanceScore * 0.35 + consolidationScore * 0.3);

  // 4. Risk level determination
  let riskLevel, riskColor, riskAdvice;
  if (barrierScore >= 70) {
    riskLevel = 'HIGH';
    riskColor = '#ef4444';
    riskAdvice = 'This market has high entry barriers. Dominant brands may have strong trademark protection. Consider differentiating with unique formulation or targeting underserved sub-niches.';
  } else if (barrierScore >= 40) {
    riskLevel = 'MEDIUM';
    riskColor = '#f59e0b';
    riskAdvice = 'Moderate competition. Some established brands but room for new entrants. Check trademarks before choosing brand name.';
  } else {
    riskLevel = 'LOW';
    riskColor = '#10b981';
    riskAdvice = 'Fragmented market with low barriers. Good opportunity for new brands. Few dominant players to worry about.';
  }

  // 5. Generate search links for manual verification
  const searchLinks = {
    usptoTess: `https://tmsearch.uspto.gov/bin/gate.exe?f=searchss&state=4801:1.1.1&p_s_PARA1=${encodeURIComponent(searchTerm)}&p_s_PARA2=&p_s_ParaOperator=AND&p_s_ALL=&BackReference=&p_L=50&p_plural=yes&p_s_ALL=&a_default=search&a_search=Submit+Query`,
    googlePatents: `https://patents.google.com/?q=${encodeURIComponent(searchTerm + ' supplement')}&oq=${encodeURIComponent(searchTerm)}`,
    usptoSearch: `https://www.uspto.gov/trademarks/search`,
    alibabaSearch: `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(searchTerm)}`
  };

  // 6. Brand landscape analysis
  const brandLandscape = brandEntries.slice(0, 15).map(([name, data]) => ({
    name,
    productCount: data.count,
    marketShare: Math.round(data.count / totalProducts * 100),
    estimatedRevenue: data.revenue || 0,
    potentialTrademark: data.count >= 3 // likely has trademark if 3+ products
  }));

  // Count "dead zone" opportunities - brands with low share
  const weakBrands = brandEntries.filter(([, d]) => d.count <= 2);
  const strongBrands = brandEntries.filter(([, d]) => d.count >= 5);

  res.json({
    category,
    categoryName: catName,
    barrierScore,
    riskLevel,
    riskColor,
    riskAdvice,
    metrics: {
      hhi,
      hhiScore,
      topBrandShare,
      dominanceScore,
      brandCount,
      consolidationScore,
      totalProducts,
      top3Share: Math.round(top3Share)
    },
    brandLandscape,
    opportunities: {
      weakBrandsCount: weakBrands.length,
      strongBrandsCount: strongBrands.length,
      fragmentationRatio: Math.round(weakBrands.length / Math.max(1, brandEntries.length) * 100),
      isFragmented: weakBrands.length > strongBrands.length * 2
    },
    searchLinks,
    timestamp: new Date().toISOString()
  });
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
  const systemPrompt = `You are a top Amazon FBA seller and a certified supplement formulator/pharmacist. You specialize in creating innovative dietary supplement products that dominate the Amazon marketplace.

IMPORTANT: Always respond in Korean (한국어). Your response must follow the exact JSON format specified.`;

  const userPrompt = `아래의 실시간 시장 데이터를 분석해서 아마존을 독점할 수 있는 혁신적인 영양제 신제품 기획안을 딱 1개 제안해.

## 분석 대상: ${contextData.concernLabel}

## 실시간 데이터:
### 아마존 시장 데이터 (SP-API):
${JSON.stringify(contextData.spApiData, null, 2)}

### Reddit 소비자 트렌드:
${JSON.stringify(contextData.redditData, null, 2)}

### FDA 안전성 데이터:
${JSON.stringify(contextData.fdaData, null, 2)}

### 마진 분석 (1/3 법칙):
${JSON.stringify(contextData.marginData, null, 2)}

## 반드시 아래 JSON 형식으로 답변해:
{
  "productName": "제품명 (영어, 브랜드네임 느낌으로)",
  "productNameKr": "제품명 한국어 설명",
  "formType": "제형 (예: 리포조말 소프트젤, 구미, 분말 스틱 등)",
  "tagline": "상세페이지 첫 줄에 들어갈 영어 카피라이팅 (한 줄)",
  "targetAudience": "핵심 타겟 고객층 설명",
  "ingredients": [
    {"name": "성분명", "dosage": "용량", "reason": "이 성분을 넣는 이유 (데이터 근거 포함)"}
  ],
  "synergyExplanation": "성분 배합 시너지 설명 (왜 이 조합이 효과적인지)",
  "competitorWeaknesses": [
    {"weakness": "기존 제품 약점", "ourSolution": "우리 제품이 해결하는 방법"}
  ],
  "fdaSafetyReport": {
    "riskLevel": "LOW/MEDIUM/HIGH",
    "warnings": ["주의사항 1", "주의사항 2"],
    "marketingDontSay": ["절대 쓰면 안 되는 마케팅 문구"],
    "marketingCanSay": ["안전하게 쓸 수 있는 마케팅 문구"]
  },
  "pricingStrategy": {
    "suggestedPrice": 가격숫자,
    "targetCOGS": 원가숫자,
    "estimatedMonthlyProfit": 월순이익숫자,
    "reasoning": "가격 전략 이유"
  },
  "marketingCopy": {
    "title": "아마존 상품 타이틀 (200자 이내 영어)",
    "bulletPoints": ["불릿포인트 1", "불릿포인트 2", "불릿포인트 3", "불릿포인트 4", "불릿포인트 5"]
  },
  "whyThisWillDominate": "이 제품이 시장을 독점할 수 있는 핵심 이유 요약"
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

    const geminiRes = await httpsPost(
      'generativelanguage.googleapis.com',
      `/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      { 'Content-Type': 'application/json' },
      geminiBody
    );

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
      res.json({ error: 'Gemini response error', details: geminiRes.data, contextData });
    }
  } catch(e) {
    res.status(500).json({ error: 'Gemini API call failed: ' + e.message, contextData });
  }
});

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