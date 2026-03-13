require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');
const querystring = require('querystring');

const app = express();
app.use(cors());
app.use(express.json());

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

app.get('/api/categories', (req, res) => {
  res.json([
    { id: 'vitamins', name: 'Vitamins & Supplements', keyword: 'vitamins supplements' },
    { id: 'protein', name: 'Protein & Fitness', keyword: 'protein powder' },
    { id: 'omega', name: 'Omega & Fish Oil', keyword: 'omega fish oil' },
    { id: 'probiotics', name: 'Probiotics', keyword: 'probiotics' },
    { id: 'collagen', name: 'Collagen', keyword: 'collagen supplements' },
    { id: 'magnesium', name: 'Magnesium', keyword: 'magnesium supplement' },
    { id: 'vitaminD', name: 'Vitamin D', keyword: 'vitamin d3' },
    { id: 'vitaminC', name: 'Vitamin C', keyword: 'vitamin c supplement' }
  ]);
});

app.get('/api/trends', async (req, res) => {
  const categories = {
    vitamins: 'vitamins supplements', protein: 'protein powder',
    omega: 'omega fish oil', probiotics: 'probiotics',
    collagen: 'collagen supplements', magnesium: 'magnesium supplement',
    vitaminD: 'vitamin d3', vitaminC: 'vitamin c supplement'
  };
  try {
    const results = {};
    const entries = Object.entries(categories);
    const fetches = await Promise.allSettled(
      entries.map(([id, keyword]) =>
        spApiGet(`/catalog/2022-04-01/items?keywords=${encodeURIComponent(keyword)}&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,attributes,salesRanks,images`)
          .then(r => ({ id, data: r.data }))
      )
    );
    for (const result of fetches) {
      if (result.status === 'fulfilled') {
        const { id, data } = result.value;
        const items = data.items || [];
        const prices = items.map(p => {
          const attrs = p.attributes;
          const price = attrs?.list_price?.[0]?.value?.amount || attrs?.price?.[0]?.value;
          return price ? parseFloat(price) : null;
        }).filter(Boolean);
        const ranks = items.map(p => p.salesRanks?.[0]?.ranks?.[0]?.rank).filter(Boolean);
        const brands = {};
        items.forEach(p => {
          const brand = p.attributes?.brand?.[0]?.value || 'Unknown';
          brands[brand] = (brands[brand] || 0) + 1;
        });
        results[id] = {
          totalProducts: data.numberOfResults || items.length,
          itemCount: items.length,
          avgPrice: prices.length ? +(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2) : 0,
          minPrice: prices.length ? Math.min(...prices) : 0,
          maxPrice: prices.length ? Math.max(...prices) : 0,
          avgRank: ranks.length ? Math.round(ranks.reduce((a, b) => a + b, 0) / ranks.length) : 0,
          brands,
          topProducts: items
            .map(p => ({
              asin: p.asin,
              title: p.summaries?.[0]?.itemName || 'Unknown',
              brand: p.attributes?.brand?.[0]?.value || 'Unknown',
              price: (() => { const pr = p.attributes?.list_price?.[0]?.value?.amount || p.attributes?.price?.[0]?.value; return pr ? parseFloat(pr) : null; })(),
              rank: p.salesRanks?.[0]?.ranks?.[0]?.rank || null,
              image: p.images?.[0]?.images?.[0]?.link || null
            }))
            .filter(p => p.rank)
            .sort((a, b) => a.rank - b.rank)
            .slice(0, 5),
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
  const keywords = {
    vitamins: 'vitamins supplements', protein: 'protein powder',
    omega: 'omega fish oil', probiotics: 'probiotics',
    collagen: 'collagen supplements', magnesium: 'magnesium supplement',
    vitaminD: 'vitamin d3', vitaminC: 'vitamin c supplement'
  };
  const keyword = keywords[req.params.categoryId] || req.params.categoryId;
  try {
    const result = await spApiGet(`/catalog/2022-04-01/items?keywords=${encodeURIComponent(keyword)}&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,attributes,salesRanks,images`);
    res.json(result.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`🚀 SuppleMint Backend running on http://localhost:${PORT}`);
  console.log(`📋 Mode: LIVE (SP-API direct HTTP)`);
  getAccessToken()
    .then(() => console.log('✅ SP-API connected!'))
    .catch(e => console.log('⚠️ SP-API:', e.message));
});