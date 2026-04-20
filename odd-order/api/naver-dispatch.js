import bcrypt from 'bcryptjs';
import { ProxyAgent, fetch as proxyFetch } from 'undici';

const NAVER_API_BASE = 'https://api.commerce.naver.com/external/v1';

function getFetch() {
  if (process.env.PROXY_URL) {
    const dispatcher = new ProxyAgent(process.env.PROXY_URL);
    return (url, opts = {}) => proxyFetch(url, { ...opts, dispatcher });
  }
  return globalThis.fetch;
}

async function getAccessToken() {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET 환경변수가 설정되지 않았습니다.');
  }
  const timestamp = Date.now();
  const password = `${clientId}_${timestamp}`;
  const hashed = bcrypt.hashSync(password, clientSecret);
  const signature = Buffer.from(hashed).toString('base64');

  const params = new URLSearchParams({
    client_id: clientId,
    timestamp: String(timestamp),
    client_secret_sign: signature,
    grant_type: 'client_credentials',
    type: 'SELF',
  });

  const pFetch = getFetch();
  const res = await pFetch(`${NAVER_API_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`토큰 발급 실패 (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.access_token;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { orders, deliveryCompanyCode } = req.body;

    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: '발송처리할 주문이 없습니다.' });
    }

    const token = await getAccessToken();
    const pFetch = getFetch();

    const dispatchBody = {
      dispatchProductOrders: orders.map((o) => ({
        productOrderId: o.productOrderId,
        deliveryMethod: 'DELIVERY',
        deliveryCompanyCode: deliveryCompanyCode || 'CJGLS',
        trackingNumber: o.trackingNumber,
        dispatchDate: new Date().toISOString(),
      })),
    };

    const apiRes = await pFetch(
      `${NAVER_API_BASE}/pay-order/seller/product-orders/dispatch`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(dispatchBody),
      }
    );

    const resultText = await apiRes.text();
    let result;
    try {
      result = JSON.parse(resultText);
    } catch {
      result = { raw: resultText };
    }

    if (!apiRes.ok) {
      throw new Error(`발송처리 실패 (${apiRes.status}): ${resultText.slice(0, 500)}`);
    }

    return res.status(200).json({
      success: true,
      registeredCount: orders.length,
      result,
    });
  } catch (err) {
    console.error('네이버 발송처리 오류:', err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
