import bcrypt from 'bcryptjs';

const NAVER_API_BASE = 'https://api.commerce.naver.com/external/v1';

async function getAccessToken() {
  const clientId = process.env.NAVER_CLIENT_ID;
  const secretB64 = process.env.NAVER_CLIENT_SECRET_B64;

  if (!clientId || !secretB64) {
    throw new Error('NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET_B64 환경변수가 설정되지 않았습니다.');
  }
  const clientSecret = Buffer.from(secretB64, 'base64').toString('utf-8');

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

  const res = await fetch(`${NAVER_API_BASE}/oauth2/token`, {
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

async function fetchOrders(token) {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    lastChangedFrom: from.toISOString(),
    lastChangedType: 'PAYED',
    limitCount: '300',
  });

  const allOrders = [];
  let moreSequence = null;

  do {
    if (moreSequence) {
      params.set('moreSequence', moreSequence);
    }

    const res = await fetch(
      `${NAVER_API_BASE}/pay-order/seller/product-orders/last-changed-statuses?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`주문 조회 실패 (${res.status}): ${text}`);
    }

    const data = await res.json();
    const productOrderIds = (data.data?.lastChangeStatuses || []).map(
      (s) => s.productOrderId
    );

    if (productOrderIds.length > 0) {
      const details = await fetchOrderDetails(token, productOrderIds);
      allOrders.push(...details);
    }

    moreSequence = data.data?.moreSequence || null;
  } while (moreSequence);

  return allOrders;
}

async function fetchOrderDetails(token, productOrderIds) {
  const res = await fetch(
    `${NAVER_API_BASE}/pay-order/seller/product-orders/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ productOrderIds }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`주문 상세 조회 실패 (${res.status}): ${text}`);
  }

  const data = await res.json();
  return (data.data || []).map((item) => {
    const order = item.productOrder || item;
    const shipping = order.shippingAddress || {};
    const product = order.product || order;

    return {
      productOrderId: order.productOrderId || '',
      recipientName: shipping.name || '',
      phone: shipping.tel1 || '',
      phone2: shipping.tel2 || '',
      baseAddress: shipping.baseAddress || '',
      detailedAddress: shipping.detailedAddress || '',
      deliveryMemo: shipping.deliveryMemo || '',
      productName: product.productName || '',
      productOption: product.productOption || '',
      quantity: product.quantity || 1,
      totalPaymentAmount: order.totalPaymentAmount || 0,
      orderDate: order.orderDate || '',
    };
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const token = await getAccessToken();
    const orders = await fetchOrders(token);

    return res.status(200).json({
      success: true,
      count: orders.length,
      orders,
    });
  } catch (err) {
    console.error('네이버 API 오류:', err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
