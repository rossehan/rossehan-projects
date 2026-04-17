import crypto from 'crypto';

const COUPANG_HOST = 'https://api-gateway.coupang.com';
const API_PATH_PREFIX = '/v2/providers/openapi/apis/api/v4/vendors';
const MAX_PER_PAGE = 50;

/**
 * KST(UTC+9) 기준 "yyyy-MM-ddTHH:mm:ss" 문자열 반환
 * Vercel 서버리스는 UTC 타임존이라 직접 변환 필요.
 */
function toKstIsoString(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 19);
}

/**
 * 쿠팡 Wing API Authorization 헤더 생성 (HMAC-SHA256)
 * 포맷: CEA algorithm=HmacSHA256, access-key=..., signed-date=..., signature=...
 * signed-date는 현재 UTC 시각을 "yyMMddTHHmmssZ"로 포맷.
 */
function buildAuthorization({ method, path, query, accessKey, secretKey }) {
  const now = new Date();
  const signedDate =
    now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '')
      .slice(2); // yyMMddTHHmmssZ

  const message = signedDate + method + path + (query || '');
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('hex');

  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;
}

/**
 * 쿠팡 ordersheet 조회 (최근 24시간, status=ACCEPT)
 */
async function fetchCoupangOrderSheets({ accessKey, secretKey, vendorId }) {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const createdAtFrom = toKstIsoString(from);
  const createdAtTo = toKstIsoString(now);

  const path = `${API_PATH_PREFIX}/${vendorId}/ordersheets`;
  const query =
    `createdAtFrom=${createdAtFrom}` +
    `&createdAtTo=${createdAtTo}` +
    `&status=ACCEPT` +
    `&maxPerPage=${MAX_PER_PAGE}`;

  const authorization = buildAuthorization({
    method: 'GET',
    path,
    query,
    accessKey,
    secretKey,
  });

  const url = `${COUPANG_HOST}${path}?${query}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`쿠팡 주문 조회 실패 (${res.status}): ${text.slice(0, 300)}`);
  }

  return res.json();
}

/**
 * 쿠팡 원본 응답 → 평탄한 주문 배열 (네이버 함수와 동일한 shape + channel/matchKey)
 * orderItems가 여러 개면 각 item당 주문 1행으로 펼친다.
 */
function normalizeCoupangOrders(rawData) {
  const orderSheets = Array.isArray(rawData?.data) ? rawData.data : [];

  return orderSheets.flatMap((sheet) => {
    const receiver = sheet.receiver || {};
    const items = Array.isArray(sheet.orderItems) ? sheet.orderItems : [];

    return items.map((item) => ({
      channel: 'coupang',
      // 네이버와 통일된 키 이름 사용 (client가 동일 shape으로 다룸)
      productOrderId: String(sheet.orderId ?? ''),
      // 매칭은 vendorItemId로 (텍스트는 displayOption으로 보존)
      matchKey: String(item.vendorItemId ?? ''),
      recipientName: receiver.name ?? '',
      phone: receiver.receiverNumber1 ?? '',
      phone2: receiver.receiverNumber2 ?? '',
      baseAddress: receiver.addr1 ?? '',
      detailedAddress: receiver.addr2 ?? '',
      zipCode: receiver.postCode ?? '',
      deliveryMemo:
        item.parcelPrintMessage ??
        sheet.parcelPrintMessage ??
        '',
      // 표시용 원본 옵션 텍스트 (매핑 실패 시 사용자에게 보여줌)
      productOption: item.vendorItemName ?? '',
      productName: item.vendorItemName ?? '',
      quantity: Number(item.shippingCount ?? 1),
      totalPaymentAmount: Number(item.orderPrice ?? 0),
      orderDate: sheet.orderedAt ?? '',
    }));
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID } =
    process.env;

  if (!COUPANG_ACCESS_KEY || !COUPANG_SECRET_KEY || !COUPANG_VENDOR_ID) {
    return res.status(500).json({
      success: false,
      error:
        '쿠팡 환경변수(COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID)가 설정되지 않았습니다.',
    });
  }

  try {
    const raw = await fetchCoupangOrderSheets({
      accessKey: COUPANG_ACCESS_KEY,
      secretKey: COUPANG_SECRET_KEY,
      vendorId: COUPANG_VENDOR_ID,
    });

    const orders = normalizeCoupangOrders(raw);

    // 페이지네이션 초과 감지:
    // - 쿠팡 응답 배열이 maxPerPage만큼 가득 찼거나
    // - 응답에 nextToken 필드 존재
    // → 50건 초과 가능성 → 프론트에 경고
    const sheetCount = Array.isArray(raw?.data) ? raw.data.length : 0;
    const hasNextToken = Boolean(raw?.nextToken);
    const warning =
      sheetCount >= MAX_PER_PAGE || hasNextToken ? 'MAX_PAGE_REACHED' : null;

    if (warning) {
      console.warn(
        '[coupang-orders] pagination limit reached:',
        { sheetCount, hasNextToken }
      );
    }

    return res.status(200).json({
      success: true,
      count: orders.length,
      orders,
      warning,
    });
  } catch (err) {
    console.error('쿠팡 API 오류:', err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}
