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
  const categories = CATEGORY_KEYWORDS;
  try {
    const results = {};
    const entries = Object.entries(categories);
    const fetches = await fetchInBatches(entries, 10, 1500);
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
    res.json({ categories: results, timestamp: new Date().toISOString() });
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

app.listen(PORT, () => {
  console.log(`🚀 SuppleMint Backend running on http://localhost:${PORT}`);
  console.log(`📋 Mode: LIVE (SP-API direct HTTP)`);
  getAccessToken()
    .then(() => console.log('✅ SP-API connected!'))
    .catch(e => console.log('⚠️ SP-API:', e.message));
});