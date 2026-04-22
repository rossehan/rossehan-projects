import crypto from 'crypto';
import { ProxyAgent, fetch as proxyFetch } from 'undici';

const COUPANG_HOST = 'https://api-gateway.coupang.com';
const API_PATH_PREFIX = '/v2/providers/openapi/apis/api/v4/vendors';

function buildAuthorization({ method, path, query, accessKey, secretKey }) {
  const now = new Date();
  const signedDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
    .slice(2);
  const message = signedDate + method + path + (query || '');
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;
}

async function coupangFetch({ method, path, query, body, accessKey, secretKey }) {
  const authorization = buildAuthorization({ method, path, query, accessKey, secretKey });
  const url = `${COUPANG_HOST}${path}${query ? '?' + query : ''}`;
  const fetchOptions = {
    method,
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
  };
  if (body) fetchOptions.body = JSON.stringify(body);
  if (process.env.PROXY_URL) {
    fetchOptions.dispatcher = new ProxyAgent(process.env.PROXY_URL);
  }
  return proxyFetch(url, fetchOptions);
}

/**
 * orderId로 발주서 단건 조회 → shipmentBoxId + vendorItemId 목록 반환
 * shipmentBoxId는 18자리 정수 → JSON 파싱 시 정밀도 유지를 위해 문자열로 추출
 */
async function getOrderSheetInfo(orderId, { accessKey, secretKey, vendorId }) {
  const path = `${API_PATH_PREFIX}/${vendorId}/ordersheets/${orderId}`;
  const res = await coupangFetch({ method: 'GET', path, accessKey, secretKey });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`발주서 조회 실패 (orderId: ${orderId}, ${res.status}): ${text.slice(0, 300)}`);
  }

  // shipmentBoxId가 18자리 정수라 Number.MAX_SAFE_INTEGER 초과 가능
  // → JSON 파싱 전에 문자열로 변환하여 정밀도 유지
  const rawText = await res.text();
  const safeText = rawText.replace(/"shipmentBoxId"\s*:\s*(\d+)/g, '"shipmentBoxId":"$1"');
  const data = JSON.parse(safeText);

  const sheets = Array.isArray(data.data) ? data.data : [data.data];

  const results = [];
  for (const sheet of sheets) {
    if (!sheet) continue;
    const items = Array.isArray(sheet.orderItems) ? sheet.orderItems : [];
    for (const item of items) {
      results.push({
        shipmentBoxId: String(sheet.shipmentBoxId),
        orderId: String(sheet.orderId),
        vendorItemId: String(item.vendorItemId),
      });
    }
  }

  if (results.length === 0) {
    throw new Error(`발주서 정보 없음 (orderId: ${orderId})`);
  }

  return results;
}

/**
 * 상품준비중 처리 (ACCEPT → INSTRUCT)
 * 이미 INSTRUCT 상태면 에러가 나지만, 무시하고 진행
 */
async function acknowledgeShipmentBoxes(shipmentBoxIds, { accessKey, secretKey, vendorId }) {
  const path = `${API_PATH_PREFIX}/${vendorId}/ordersheets/acknowledgement`;
  const body = {
    vendorId,
    shipmentBoxIds: shipmentBoxIds.map(id => Number(id)),
  };

  const res = await coupangFetch({ method: 'PUT', path, body, accessKey, secretKey });
  // 이미 처리된 경우 에러가 날 수 있으므로 결과만 로깅
  const text = await res.text();
  console.log(`[acknowledgement] status=${res.status}, body=${text.slice(0, 200)}`);
  return res.ok;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID } = process.env;
  if (!COUPANG_ACCESS_KEY || !COUPANG_SECRET_KEY || !COUPANG_VENDOR_ID) {
    return res.status(500).json({
      success: false,
      error: '쿠팡 환경변수(COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID)가 설정되지 않았습니다.',
    });
  }

  try {
    const { orders, deliveryCompanyCode } = req.body;

    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ error: '등록할 송장이 없습니다.' });
    }

    const creds = {
      accessKey: COUPANG_ACCESS_KEY,
      secretKey: COUPANG_SECRET_KEY,
      vendorId: COUPANG_VENDOR_ID,
    };

    // 1단계: 각 orderId에 대해 shipmentBoxId 조회
    const invoiceDtos = [];
    const allShipmentBoxIds = new Set();
    const errors = [];

    console.log('[coupang-invoice] 요청 orders:', JSON.stringify(orders));

    for (const order of orders) {
      try {
        // shipmentBoxId가 이미 있으면 (쿠팡 DeliveryList) ordersheets 조회 건너뛰기
        if (order.shipmentBoxId && order.vendorItemId) {
          console.log(`[coupang-invoice] 직접 등록: orderId=${order.orderId}, shipmentBoxId=${order.shipmentBoxId}`);
          allShipmentBoxIds.add(order.shipmentBoxId);
          invoiceDtos.push({
            shipmentBoxId: Number(order.shipmentBoxId),
            orderId: Number(order.orderId),
            vendorItemId: Number(order.vendorItemId),
            deliveryCompanyCode: deliveryCompanyCode || 'CJGLS',
            invoiceNumber: order.trackingNumber,
            splitShipping: false,
            preSplitShipped: false,
            estimatedShippingDate: '',
          });
        } else {
          // ordersheets 조회 필요 (앱 자체 발주서 형식)
          console.log(`[coupang-invoice] orderId=${order.orderId} 조회 시작`);
          const sheetInfos = await getOrderSheetInfo(order.orderId, creds);
          console.log(`[coupang-invoice] orderId=${order.orderId} 조회 성공:`, JSON.stringify(sheetInfos));
          for (const info of sheetInfos) {
            allShipmentBoxIds.add(info.shipmentBoxId);
            invoiceDtos.push({
              shipmentBoxId: Number(info.shipmentBoxId),
              orderId: Number(info.orderId),
              vendorItemId: Number(info.vendorItemId),
              deliveryCompanyCode: deliveryCompanyCode || 'CJGLS',
              invoiceNumber: order.trackingNumber,
              splitShipping: false,
              preSplitShipped: false,
              estimatedShippingDate: '',
            });
          }
        }
      } catch (err) {
        errors.push({ orderId: order.orderId, error: err.message });
      }
    }

    if (invoiceDtos.length === 0) {
      return res.status(400).json({
        success: false,
        error: '등록 가능한 송장이 없습니다.',
        errors,
      });
    }

    // 2단계: 상품준비중 처리 (ACCEPT → INSTRUCT, 이미 처리됐으면 무시)
    const boxIds = [...allShipmentBoxIds];
    await acknowledgeShipmentBoxes(boxIds, creds);

    // 3단계: 송장 업로드 (POST)
    const path = `${API_PATH_PREFIX}/${COUPANG_VENDOR_ID}/orders/invoices`;
    const body = {
      vendorId: COUPANG_VENDOR_ID,
      orderSheetInvoiceApplyDtos: invoiceDtos,
    };

    const apiRes = await coupangFetch({
      method: 'POST',
      path,
      body,
      accessKey: COUPANG_ACCESS_KEY,
      secretKey: COUPANG_SECRET_KEY,
    });

    const resultText = await apiRes.text();
    let result;
    try {
      result = JSON.parse(resultText);
    } catch {
      result = { raw: resultText };
    }

    if (!apiRes.ok) {
      throw new Error(`송장 업로드 실패 (${apiRes.status}): ${resultText.slice(0, 500)}`);
    }

    return res.status(200).json({
      success: true,
      registeredCount: invoiceDtos.length,
      result,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    console.error('쿠팡 송장등록 오류:', err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
