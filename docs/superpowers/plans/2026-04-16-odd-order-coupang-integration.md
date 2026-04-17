# ODD Order — 쿠팡 Wing API 연동 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ODD Order 웹앱의 탭1(발주서 변환)에 쿠팡 Wing Open API 자동 연동을 추가하여, 네이버+쿠팡 주문을 한 번에 가져와 통합 3PL 발주서로 생성한다.

**Architecture:** Vercel 서버리스 함수로 쿠팡 API 프록시(`/api/coupang-orders.js`) 신규 작성. 프론트엔드(`index.html`)는 두 채널을 `Promise.allSettled`로 병렬 호출하고 공통 주문 객체로 정규화. 쿠팡은 `vendorItemId`로 상품 매핑(텍스트 아님). 주문 스냅샷을 `localStorage`에 10개 FIFO로 저장하여 추적성 확보.

**Tech Stack:** 바닐라 HTML/JS + Vercel 서버리스 함수(Node.js) + Fetch API + Web Crypto API(HMAC-SHA256) + localStorage

**Spec:** `docs/superpowers/specs/2026-04-16-odd-order-coupang-integration-design.md`

**이전 플랜:** `docs/superpowers/plans/2026-03-31-odd-order-automation.md`

---

## 실행 환경 주의사항

- **Bash 타임아웃 문제**: 이 PC에서 `git`, `vercel`, `npm` 등 CLI 명령은 Claude가 실행하면 자주 타임아웃이 발생함. 모든 CLI 명령은 **사용자가 터미널에서 직접 실행**하도록 안내할 것.
- **테스트 프레임워크 없음**: 이 프로젝트는 바닐라 HTML로 별도 테스트 러너가 없음. 각 작업은 **브라우저에서 수동 검증** 방식으로 진행.
- **배포 환경**: Vercel (GitHub 연동). `main`에 push되면 자동 배포됨.
- **보안 원칙**: Access Key / Secret Key는 **절대 코드/문서에 하드코딩 금지**. `process.env.*`로만 참조. `.env.local`은 `.gitignore`에 포함되어야 함.

---

## 파일 구조

```
odd-order/
├── index.html                    # 수정 — 프론트엔드 전체 (탭1 쿠팡 로직 + 탭3 스냅샷 이력)
├── api/
│   ├── orders.js                 # 기존 (네이버) — 변경 없음
│   └── coupang-orders.js         # 신규 — 쿠팡 Wing API 프록시
├── .env.local                    # 기존 수정 — COUPANG_* 3개 추가 (git 제외)
├── .env.local.example            # 신규 또는 수정 — 템플릿
├── .gitignore                    # 확인 — .env.local 포함 여부
└── vercel.json                   # 필요 시 수정
```

### 책임 분리

- `api/coupang-orders.js`: 쿠팡 API 호출/서명/에러 처리만. 상품 매핑/정규화는 모름
- `index.html` 프론트 스크립트 내부 섹션 분리:
  - 설정/매핑 테이블 영역: `PRODUCT_MAP_NAVER`, `PRODUCT_MAP_COUPANG`, `CONFIG`
  - 정규화 영역: `normalizeNaverOrder`, `normalizeCoupangOrder`, `dedupeOrders`
  - 매핑/집계 영역: `applyProductMapping`, `aggregateForPurchase`
  - UI 영역: 알림 표시, 테이블 렌더링, 에러 확장 토글
  - 스냅샷 영역: `saveSnapshot`, `listSnapshots`, `renderSnapshotHistory`

---

## 사전 준비 (Task 0: 사용자 수동 작업)

### Task 0.1: `.gitignore`에 `.env.local` 포함 확인

**Files:**
- Check: `odd-order/.gitignore` (존재하지 않으면 `rossehan-projects/.gitignore` 확인)

- [ ] **Step 1: .gitignore 확인**

파일을 열어 `.env.local` 또는 `.env*` 패턴이 있는지 확인. 없으면 추가.

예상 내용:
```
.env.local
.env*.local
node_modules/
.vercel
```

- [ ] **Step 2: 실제 git status로 검증 (사용자 수동 실행)**

사용자에게 안내:
```bash
cd C:\Users\admin\Desktop\rossehan-projects
git status
```
→ `.env.local`이 목록에 **나타나면 안 됨**. 나타난다면 `.gitignore` 수정 필요.

### Task 0.2: `.env.local`에 쿠팡 환경변수 추가

**Files:**
- Modify: `odd-order/.env.local` (사용자가 직접 편집)

- [ ] **Step 1: 사용자 안내 — 파일 열어서 추가**

파일 경로: `C:\Users\admin\Desktop\rossehan-projects\odd-order\.env.local`

기존 내용 유지하고 아래 3줄 추가:
```
COUPANG_ACCESS_KEY=<발급받은 access key>
COUPANG_SECRET_KEY=<발급받은 secret key>
COUPANG_VENDOR_ID=<업체코드, A로 시작하는 9자리>
```

**중요**: Claude에게 실제 키 값을 채팅으로 공유하지 말 것. 사용자가 직접 파일에 입력.

### Task 0.3: Vercel 환경변수 추가

- [ ] **Step 1: Vercel 대시보드 접속**

https://vercel.com/ → 프로젝트 → Settings → Environment Variables

- [ ] **Step 2: 3개 환경변수 추가**

- `COUPANG_ACCESS_KEY`
- `COUPANG_SECRET_KEY`
- `COUPANG_VENDOR_ID`

Environment: Production, Preview, Development 모두 체크

- [ ] **Step 3: 저장 후 Redeploy**

Deployments 탭 → 최신 배포 → `⋯` → Redeploy

---

## Task 1: 환경변수 템플릿 파일 작성

**Files:**
- Create/Modify: `odd-order/.env.local.example`

- [ ] **Step 1: 템플릿 파일 생성 (또는 업데이트)**

파일 내용:
```
# 네이버 커머스 API (기존)
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=

# 쿠팡 Wing Open API (신규 — 2026-04-16)
COUPANG_ACCESS_KEY=
COUPANG_SECRET_KEY=
COUPANG_VENDOR_ID=
```

- [ ] **Step 2: 커밋 (사용자 수동 실행)**

```bash
cd C:\Users\admin\Desktop\rossehan-projects
git add odd-order/.env.local.example
git commit -m "chore(odd-order): add Coupang env vars to example template"
```

---

## Task 2: 쿠팡 서버리스 함수 기본 구조 + HMAC 서명

**Files:**
- Create: `odd-order/api/coupang-orders.js`

**책임 (이 task):**
- 환경변수 로드
- KST 시간 범위 계산
- HMAC-SHA256 서명 생성
- 쿠팡 API 호출 (성공 케이스만)
- 응답 그대로 반환

**책임 아님 (이 task에서 제외):**
- 페이지네이션 감지 (Task 3)
- 정교한 에러 처리 (Task 3)

- [ ] **Step 1: 파일 생성 및 최소 구현**

```js
// odd-order/api/coupang-orders.js
import crypto from 'node:crypto';

const COUPANG_HOST = 'https://api-gateway.coupang.com';
const API_PATH_PREFIX = '/v2/providers/openapi/apis/api/v4/vendors';

/**
 * KST 기준 "yyyy-MM-ddTHH:mm:ss" 문자열 생성
 * Vercel 런타임은 UTC이므로 +9h 오프셋 적용
 */
function kstIsoString(date) {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 19);
}

/**
 * 쿠팡 HMAC 서명 생성
 * 쿠팡 공식 Authorization 헤더 포맷:
 *   CEA algorithm=HmacSHA256, access-key=..., signed-date=..., signature=...
 * signed-date는 "yyMMddTHHmmssZ" (UTC)
 */
function signCoupangRequest({ method, path, query, secretKey, accessKey }) {
  const now = new Date();
  const signedDate =
    now.toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '')
      .slice(2);  // "yyMMddTHHmmssZ"

  const message = signedDate + method + path + (query || '');
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(message)
    .digest('hex');

  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;
}

export default async function handler(req, res) {
  try {
    const {
      COUPANG_ACCESS_KEY,
      COUPANG_SECRET_KEY,
      COUPANG_VENDOR_ID,
    } = process.env;

    if (!COUPANG_ACCESS_KEY || !COUPANG_SECRET_KEY || !COUPANG_VENDOR_ID) {
      return res.status(500).json({
        error: 'Coupang credentials not configured. Set COUPANG_* env vars.',
      });
    }

    // KST 기준 최근 24시간
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const createdAtFrom = kstIsoString(from);
    const createdAtTo = kstIsoString(now);

    const path = `${API_PATH_PREFIX}/${COUPANG_VENDOR_ID}/ordersheets`;
    const query =
      `createdAtFrom=${createdAtFrom}` +
      `&createdAtTo=${createdAtTo}` +
      `&status=ACCEPT` +
      `&maxPerPage=50`;

    const authorization = signCoupangRequest({
      method: 'GET',
      path,
      query,
      secretKey: COUPANG_SECRET_KEY,
      accessKey: COUPANG_ACCESS_KEY,
    });

    const url = `${COUPANG_HOST}${path}?${query}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[coupang-orders] API error:', response.status, errText);
      return res.status(response.status).json({
        error: `Coupang API ${response.status}: ${errText.slice(0, 200)}`,
      });
    }

    const data = await response.json();
    return res.status(200).json({ orders: data, warning: null });
  } catch (err) {
    console.error('[coupang-orders] exception:', err);
    return res.status(500).json({ error: err.message });
  }
}
```

- [ ] **Step 2: 로컬 검증 (사용자 수동 실행)**

사용자에게 안내:
```bash
cd C:\Users\admin\Desktop\rossehan-projects\odd-order
npx vercel dev
```

다른 터미널에서:
```bash
curl http://localhost:3000/api/coupang-orders
```

예상 결과:
- 환경변수 설정 전이면: `{"error": "Coupang credentials not configured..."}`
- 환경변수 설정 후 주문 없으면: `{"orders": {"code":200,"data":[]}, "warning": null}`
- 실제 주문 있으면: `{"orders": {...data...}, "warning": null}`

쿠팡 Wing에서 실제 주문이 있다면 `data` 배열에 주문 객체들이 포함돼야 함.

- [ ] **Step 3: 커밋 (사용자 수동 실행)**

```bash
git add odd-order/api/coupang-orders.js
git commit -m "feat(odd-order): add Coupang Wing API serverless function"
```

---

## Task 3: 쿠팡 함수에 페이지네이션 감지 + 에러 세부화

**Files:**
- Modify: `odd-order/api/coupang-orders.js`

- [ ] **Step 1: 페이지네이션 감지 로직 추가**

기존 `const data = await response.json();` 라인 아래를 다음으로 교체:

```js
const data = await response.json();

// 페이지네이션 초과 감지
// 쿠팡 응답이 maxPerPage만큼 꽉 차있거나 nextToken이 있으면 경고
let warning = null;
const orderList = Array.isArray(data.data) ? data.data : [];
const hasNextToken = Boolean(data.nextToken);
const maxedOut = orderList.length >= 50;

if (hasNextToken || maxedOut) {
  warning = 'MAX_PAGE_REACHED';
  console.warn('[coupang-orders] pagination limit reached:', {
    count: orderList.length,
    hasNextToken,
  });
}

return res.status(200).json({ orders: data, warning });
```

- [ ] **Step 2: 로컬 재검증**

```bash
curl http://localhost:3000/api/coupang-orders
```

응답에 `"warning": null` 필드가 포함돼야 함 (주문이 50건 미만인 경우).

- [ ] **Step 3: 커밋**

```bash
git add odd-order/api/coupang-orders.js
git commit -m "feat(odd-order): detect Coupang API pagination overflow"
```

---

## Task 4: 프론트엔드 — `PRODUCT_MAP_COUPANG` 매핑 테이블 추가

**Files:**
- Modify: `odd-order/index.html` (스크립트 영역 상단의 매핑 테이블 섹션)

- [ ] **Step 1: 기존 `PRODUCT_MAP` 위치 확인**

`index.html`을 열어 `PRODUCT_MAP` 또는 네이버용 상품 매핑 객체의 위치 파악.

- [ ] **Step 2: 기존 매핑을 `PRODUCT_MAP_NAVER`로 리네임 + 쿠팡 매핑 추가**

기존 네이버 매핑 코드를 찾아 변수명 변경 후, 바로 아래에 쿠팡 매핑 추가:

```js
// 네이버 — 옵션 텍스트로 매칭
const PRODUCT_MAP_NAVER = {
  // 기존 내용 그대로 유지
  // 예:
  // '': { code: 'P00300279', name: 'ODD. M-01 오드 영양제' },
  // '5일분 1개': { code: 'P00300280', name: '오드 M-01 스타터키트 5일분' },
  // ...
};

// 쿠팡 — vendorItemId(문자열)로 매칭 (텍스트보다 안정적)
const PRODUCT_MAP_COUPANG = {
  '95241053251': { code: 'P00300280', name: '오드 M-01 스타터키트 5일분' },  // 5개입
  '95241053249': { code: 'P00300281', name: '오드 M-01 리필팩 30일분' },     // 30개입
};
```

- [ ] **Step 3: 기존 `PRODUCT_MAP` 참조 모두 `PRODUCT_MAP_NAVER`로 변경**

`index.html` 내에서 `PRODUCT_MAP[` 검색 → 네이버 관련 참조를 `PRODUCT_MAP_NAVER[`로 변경.

주의: 다른 매핑 테이블과 이름 겹치지 않는지 확인.

- [ ] **Step 4: 브라우저에서 기존 네이버 흐름 정상 동작 확인**

브라우저에서 `index.html` 열고 탭1에서 엑셀 업로드 → 3PL 발주서 생성 시도. **기존 기능이 그대로 동작해야 함** (리네임 전후 동일 결과).

- [ ] **Step 5: 커밋**

```bash
git add odd-order/index.html
git commit -m "refactor(odd-order): rename PRODUCT_MAP to PRODUCT_MAP_NAVER; add PRODUCT_MAP_COUPANG"
```

---

## Task 5: 프론트엔드 — 정규화 함수 2개 + 공통 객체 포맷

**Files:**
- Modify: `odd-order/index.html`

- [ ] **Step 1: 기존 네이버 주문 처리 코드 위치 파악**

현재 네이버 API 응답을 내부 주문 객체로 변환하는 로직을 찾는다 (아마 `fetchNaverOrders` 또는 주문 가져오기 버튼 핸들러 안).

- [ ] **Step 2: `normalizeNaverOrder` 함수 추출**

기존 인라인 로직을 아래 시그니처의 함수로 분리:

```js
/**
 * 네이버 커머스 API 원본 응답 → 공통 주문 객체 배열
 * @param {object} rawResponse - /api/orders 응답
 * @returns {Array} 공통 포맷 주문 배열
 */
function normalizeNaverOrder(rawResponse) {
  const productOrders = rawResponse?.data?.contents || [];
  return productOrders.map((po) => {
    const content = po.content || po;
    const optionText = content.productOrder?.productOption || '';
    const qty = Number(content.productOrder?.quantity || 1);
    return {
      channel: 'naver',
      orderId: String(content.productOrder?.productOrderId || content.productOrderId || ''),
      matchKey: optionText,
      displayOption: optionText,
      quantity: qty,
      receiver: {
        name: content.shippingAddress?.name || content.orderer?.name || '',
        phone: content.shippingAddress?.tel1 || '',
        address: [
          content.shippingAddress?.baseAddress,
          content.shippingAddress?.detailedAddress,
        ].filter(Boolean).join(' '),
        zipCode: content.shippingAddress?.zipCode || '',
        memo: content.shippingMemo || '',
      },
      productCode: null,    // 매핑 단계에서 채워짐
      productName: null,
    };
  });
}
```

**주의**: 실제 네이버 응답 구조는 `api/orders.js` 또는 기존 `index.html`의 처리 코드를 참조하여 필드명을 정확히 맞춰야 함. 위 코드는 스켈레톤이며, 기존 코드의 필드 추출 로직을 그대로 옮길 것.

- [ ] **Step 3: `normalizeCoupangOrder` 함수 추가**

```js
/**
 * 쿠팡 Wing API 원본 응답 → 공통 주문 객체 배열
 * @param {object} rawResponse - /api/coupang-orders 응답의 orders 필드
 * @returns {Array} 공통 포맷 주문 배열
 */
function normalizeCoupangOrder(rawResponse) {
  const orders = rawResponse?.data || [];
  return orders.flatMap((order) =>
    (order.orderItems || []).map((item) => ({
      channel: 'coupang',
      orderId: String(order.orderId),
      matchKey: String(item.vendorItemId),     // vendorItemId 기반 매칭
      displayOption: item.vendorItemName || '',
      quantity: Number(item.shippingCount || 1),
      receiver: {
        name: order.receiver?.name || '',
        phone: order.receiver?.receiverNumber1 || '',
        address: [
          order.receiver?.addr1,
          order.receiver?.addr2,
        ].filter(Boolean).join(' '),
        zipCode: order.receiver?.postCode || '',
        memo: item.parcelPrintMessage || order.parcelPrintMessage || '',
      },
      productCode: null,
      productName: null,
    }))
  );
}
```

- [ ] **Step 4: 상품 매핑 헬퍼 추가**

```js
/**
 * 정규화된 주문 배열에 channel별 매핑 테이블 적용
 * 매핑 실패 시 productCode/productName은 null 유지
 */
function applyProductMapping(orders) {
  return orders.map((o) => {
    const table = o.channel === 'naver' ? PRODUCT_MAP_NAVER : PRODUCT_MAP_COUPANG;
    const mapped = table[o.matchKey];
    return mapped
      ? { ...o, productCode: mapped.code, productName: mapped.name }
      : { ...o };
  });
}
```

- [ ] **Step 5: `orderId` 기준 중복 제거 헬퍼**

```js
/**
 * 같은 orderId의 주문이 중복으로 들어와도 첫 번째만 유지.
 * 쿠팡은 주문 1건에 orderItems 여러 개일 수 있으므로 (orderId + matchKey) 조합으로 키 생성.
 */
function dedupeOrders(orders) {
  const seen = new Set();
  return orders.filter((o) => {
    const key = `${o.channel}:${o.orderId}:${o.matchKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

- [ ] **Step 6: 브라우저에서 구문 오류 없는지 확인**

`index.html`을 새로고침 → 콘솔(F12)에 에러가 없어야 함. 기존 기능(엑셀 업로드 발주서 생성)은 아직 그대로 동작해야 함 (아직 wire-up 안 함).

- [ ] **Step 7: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat(odd-order): add order normalization functions for multi-channel support"
```

---

## Task 6: 프론트엔드 — 주문 가져오기 로직을 병렬 호출로 전환

**Files:**
- Modify: `odd-order/index.html`

- [ ] **Step 1: 기존 "주문 가져오기" 버튼 핸들러 위치 파악**

네이버 주문을 가져오는 기존 핸들러(예: `onClick` 또는 `addEventListener('click', ...)`) 찾기.

- [ ] **Step 2: 핸들러 교체 — Promise.allSettled 패턴**

```js
async function handleFetchOrders() {
  // UI: 로딩 상태 표시 (기존 패턴 사용)
  showLoading(true);

  try {
    const [naverResult, coupangResult] = await Promise.allSettled([
      fetch('/api/orders').then((r) => r.ok
        ? r.json()
        : Promise.reject(new Error(`네이버 HTTP ${r.status}`))),
      fetch('/api/coupang-orders').then((r) => r.ok
        ? r.json()
        : Promise.reject(new Error(`쿠팡 HTTP ${r.status}`))),
    ]);

    // 각 채널 결과 정규화
    let naverOrders = [];
    let naverError = null;
    if (naverResult.status === 'fulfilled') {
      naverOrders = normalizeNaverOrder(naverResult.value);
    } else {
      naverError = naverResult.reason?.message || String(naverResult.reason);
      console.error('[fetch-orders] naver failed:', naverResult.reason);
    }

    let coupangOrders = [];
    let coupangError = null;
    let coupangWarning = null;
    if (coupangResult.status === 'fulfilled') {
      const payload = coupangResult.value;
      coupangOrders = normalizeCoupangOrder(payload.orders);
      coupangWarning = payload.warning;
    } else {
      coupangError = coupangResult.reason?.message || String(coupangResult.reason);
      console.error('[fetch-orders] coupang failed:', coupangResult.reason);
    }

    // 통합 + 중복 제거 + 매핑
    const merged = dedupeOrders([...naverOrders, ...coupangOrders]);
    const mapped = applyProductMapping(merged);

    // 화면에 렌더링 (기존 렌더 함수 재사용 — Task 7에서 수정)
    renderOrdersTable(mapped);

    // 알림
    renderFetchAlerts({
      naver: { count: naverOrders.length, error: naverError },
      coupang: { count: coupangOrders.length, error: coupangError, warning: coupangWarning },
    });

    // 스냅샷 저장 (Task 9에서 구현)
    if (typeof saveSnapshot === 'function') {
      saveSnapshot({
        ts: new Date().toISOString(),
        naver: {
          status: naverResult.status,
          rawResponse: naverResult.status === 'fulfilled' ? naverResult.value : null,
          error: naverError,
          orderCount: naverOrders.length,
        },
        coupang: {
          status: coupangResult.status,
          rawResponse: coupangResult.status === 'fulfilled' ? coupangResult.value.orders : null,
          warning: coupangWarning,
          error: coupangError,
          orderCount: coupangOrders.length,
        },
        normalized: mapped,
      });
    }
  } finally {
    showLoading(false);
  }
}
```

- [ ] **Step 3: `renderFetchAlerts` 스텁 함수 추가 (Task 7에서 구현)**

```js
function renderFetchAlerts({ naver, coupang }) {
  // Task 7에서 구현. 일단 console.log로 확인만.
  console.log('[alerts]', { naver, coupang });
  const msg = `네이버 ${naver.count}건, 쿠팡 ${coupang.count}건`;
  alert(msg);  // 임시
}
```

- [ ] **Step 4: 브라우저 수동 테스트**

사용자에게 안내:
```bash
cd odd-order
npx vercel dev
```

브라우저에서 http://localhost:3000 접속 → "주문 가져오기" 버튼 클릭.

예상 결과:
- 로컬 환경변수가 설정되어 있으면 두 채널 모두 호출됨
- alert에 두 채널 건수 표시
- 주문 테이블에 주문들 표시됨 (기존 렌더 함수로)

- [ ] **Step 5: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat(odd-order): fetch Naver + Coupang orders in parallel with allSettled"
```

---

## Task 7: 프론트엔드 — 주문 테이블 "채널" 컬럼 + 매핑 실패 표시

**Files:**
- Modify: `odd-order/index.html`

- [ ] **Step 1: 기존 `renderOrdersTable` (또는 동등 함수) 찾기**

주문 테이블 렌더링 함수 확인. `<thead>` 내 컬럼 헤더와 `<tr>` 생성 로직 파악.

- [ ] **Step 2: 테이블 헤더에 "채널" 컬럼 추가**

기존 헤더 HTML에 맨 앞 또는 주문번호 뒤에 추가:
```html
<th>채널</th>
```

- [ ] **Step 3: 각 행에 채널 뱃지 + 매핑 실패 표시**

기존 행 생성 로직에 추가:
```js
const channelBadge = order.channel === 'naver'
  ? '<span class="badge badge-naver">네이버</span>'
  : '<span class="badge badge-coupang">쿠팡</span>';

const mappingStatus = order.productCode
  ? order.productName
  : `<span class="badge badge-warn">⚠️ 매핑 실패</span> ${order.displayOption || ''}`;
```

행 템플릿에 삽입:
```html
<td>${channelBadge}</td>
...
<td>${mappingStatus}</td>
```

- [ ] **Step 4: 뱃지 CSS 추가**

```css
.badge { padding: 2px 8px; border-radius: 4px; font-size: 12px; }
.badge-naver { background: #03c75a; color: white; }
.badge-coupang { background: #ff5a5f; color: white; }
.badge-warn { background: #fff4d6; color: #8a6d00; border: 1px solid #f0c36d; }
```

- [ ] **Step 5: 브라우저 수동 테스트**

`npx vercel dev` 상태에서 "주문 가져오기" 클릭 → 테이블에 "채널" 컬럼과 뱃지가 보여야 함.

- [ ] **Step 6: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat(odd-order): add channel column and mapping-fail badge to order table"
```

---

## Task 8: 프론트엔드 — 채널별 알림 UI (에러 3가지 케이스 + 페이지네이션 경고)

**Files:**
- Modify: `odd-order/index.html`

- [ ] **Step 1: 알림 영역 HTML 추가**

기존 탭1 레이아웃에서 주문 테이블 위에 알림 박스 추가:
```html
<div id="fetch-alerts" class="alerts-area"></div>
```

- [ ] **Step 2: `renderFetchAlerts` 정식 구현 (Task 6의 스텁 교체)**

```js
function renderFetchAlerts({ naver, coupang }) {
  const el = document.getElementById('fetch-alerts');
  const parts = [];

  // 둘 다 실패
  if (naver.error && coupang.error) {
    parts.push(`
      <div class="alert alert-error">
        ❌ 두 채널 모두 주문 가져오기에 실패했습니다. 엑셀 업로드로 진행하세요.
        <details><summary>네이버 에러</summary><pre>${escapeHtml(naver.error)}</pre></details>
        <details><summary>쿠팡 에러</summary><pre>${escapeHtml(coupang.error)}</pre></details>
      </div>
    `);
  } else {
    // 부분 실패 또는 성공
    if (naver.error) {
      parts.push(`
        <div class="alert alert-warn">
          ⚠️ 네이버 주문 가져오기 실패 — 쿠팡 ${coupang.count}건만 표시
          <details><summary>에러 상세</summary><pre>${escapeHtml(naver.error)}</pre></details>
        </div>
      `);
    }
    if (coupang.error) {
      parts.push(`
        <div class="alert alert-warn">
          ⚠️ 쿠팡 주문 가져오기 실패 — 네이버 ${naver.count}건만 표시
          <details><summary>에러 상세</summary><pre>${escapeHtml(coupang.error)}</pre></details>
        </div>
      `);
    }
    if (!naver.error && !coupang.error) {
      parts.push(`
        <div class="alert alert-success">
          ✅ 네이버 ${naver.count}건, 쿠팡 ${coupang.count}건 가져왔습니다.
        </div>
      `);
    }
  }

  // 페이지네이션 경고 (별도 알림)
  if (coupang.warning === 'MAX_PAGE_REACHED') {
    parts.push(`
      <div class="alert alert-warn">
        ⚠️ 쿠팡 주문이 50건에 도달했습니다. 누락된 주문이 있는지 쿠팡 Wing에서 직접 확인하세요.
      </div>
    `);
  }

  el.innerHTML = parts.join('');
}

// 간단한 HTML 이스케이프
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
```

- [ ] **Step 3: 알림 박스 CSS 추가**

```css
.alerts-area { margin-bottom: 16px; }
.alert { padding: 12px 16px; border-radius: 6px; margin-bottom: 8px; }
.alert-success { background: #e8f5e9; color: #1b5e20; }
.alert-warn { background: #fff8e1; color: #6d4c00; }
.alert-error { background: #ffebee; color: #b71c1c; }
.alert details { margin-top: 8px; }
.alert pre { white-space: pre-wrap; font-size: 12px; margin: 4px 0 0; }
```

- [ ] **Step 4: 브라우저 수동 테스트 — 3가지 케이스**

1. **성공 케이스**: 두 채널 모두 응답 → 성공 배너
2. **쿠팡만 실패 케이스**: `COUPANG_ACCESS_KEY`를 임시로 빈 값으로 변경 → `vercel dev` 재시작 → "주문 가져오기" → 부분 실패 알림 + 에러 확장 가능
3. **둘 다 실패 케이스**: 네트워크를 오프라인으로 전환하거나 두 환경변수 다 비움 → 전체 실패 배너

테스트 후 환경변수 원복.

- [ ] **Step 5: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat(odd-order): add channel-aware fetch alerts (3 error cases + pagination warning)"
```

---

## Task 9: 프론트엔드 — 주문 스냅샷 localStorage 저장

**Files:**
- Modify: `odd-order/index.html`

- [ ] **Step 1: 스냅샷 유틸 함수 추가**

```js
const SNAPSHOT_KEY = 'orderSnapshots';
const SNAPSHOT_MAX = 10;

function loadSnapshots() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('[snapshot] load failed:', e);
    return [];
  }
}

function saveSnapshot(snap) {
  try {
    const all = loadSnapshots();
    all.unshift(snap);                          // 최신이 맨 앞
    const trimmed = all.slice(0, SNAPSHOT_MAX); // FIFO — 오래된 것 제거
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(trimmed));
  } catch (e) {
    // QuotaExceededError 등 — 조용히 실패 (기능 블로킹 금지)
    console.warn('[snapshot] save failed:', e);
  }
}
```

- [ ] **Step 2: Task 6의 `saveSnapshot` 호출 확인**

Task 6에서 `if (typeof saveSnapshot === 'function')` 가드로 호출하도록 이미 작성됨. 이제 함수가 정의되었으니 정상 호출됨.

- [ ] **Step 3: 브라우저에서 확인**

"주문 가져오기" 버튼 클릭 → F12 DevTools → Application 탭 → Local Storage → `orderSnapshots` 키에 JSON 배열이 저장됐는지 확인.

10번 이상 호출 시 오래된 항목이 자동 삭제되는지도 확인 (11번째 호출 후 배열 길이 === 10).

- [ ] **Step 4: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat(odd-order): persist last 10 order fetch snapshots to localStorage"
```

---

## Task 10: 프론트엔드 — 탭3 대시보드에 "최근 조회 이력" 섹션 추가

**Files:**
- Modify: `odd-order/index.html`

- [ ] **Step 1: 탭3(대시보드) HTML 영역에 섹션 추가**

기존 대시보드 레이아웃에 추가 (다른 섹션들과 일관된 스타일로):
```html
<section class="dashboard-section">
  <h2>📋 최근 조회 이력</h2>
  <p class="hint">주문 가져오기 시 저장된 최근 10회 스냅샷. 클레임/오매핑 추적용.</p>
  <div id="snapshot-history-list"></div>
</section>
```

- [ ] **Step 2: 렌더링 함수 작성**

```js
function renderSnapshotHistory() {
  const el = document.getElementById('snapshot-history-list');
  if (!el) return;

  const snapshots = loadSnapshots();
  if (snapshots.length === 0) {
    el.innerHTML = '<p class="muted">아직 조회 이력이 없습니다.</p>';
    return;
  }

  el.innerHTML = snapshots.map((snap, idx) => {
    const tsLocal = new Date(snap.ts).toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
    });
    const naverStatus = snap.naver.status === 'fulfilled'
      ? `✅ 네이버 ${snap.naver.orderCount}건`
      : `❌ 네이버 실패`;
    const coupangStatus = snap.coupang.status === 'fulfilled'
      ? `✅ 쿠팡 ${snap.coupang.orderCount}건${snap.coupang.warning ? ' ⚠️' : ''}`
      : `❌ 쿠팡 실패`;

    return `
      <details class="snapshot-item">
        <summary>
          <strong>${tsLocal}</strong>
          &nbsp;·&nbsp; ${naverStatus}
          &nbsp;·&nbsp; ${coupangStatus}
        </summary>
        <div class="snapshot-body">
          <h4>네이버 원본</h4>
          <pre>${escapeHtml(JSON.stringify(snap.naver.rawResponse, null, 2).slice(0, 5000))}</pre>
          <h4>쿠팡 원본</h4>
          <pre>${escapeHtml(JSON.stringify(snap.coupang.rawResponse, null, 2).slice(0, 5000))}</pre>
          <h4>정규화된 주문 (${snap.normalized.length}건)</h4>
          <pre>${escapeHtml(JSON.stringify(snap.normalized, null, 2).slice(0, 5000))}</pre>
        </div>
      </details>
    `;
  }).join('');
}
```

- [ ] **Step 3: 탭3 활성화 시 렌더 함수 호출**

기존 탭 전환 로직에서 탭3 활성 시점에 `renderSnapshotHistory()` 호출하도록 훅 추가.

또는 `saveSnapshot` 직후에도 호출하여 실시간 업데이트되도록:
```js
// saveSnapshot 호출 직후에 추가
if (typeof renderSnapshotHistory === 'function') {
  renderSnapshotHistory();
}
```

- [ ] **Step 4: CSS 추가**

```css
.snapshot-item { border: 1px solid #e0e0e0; border-radius: 4px; padding: 12px; margin-bottom: 8px; }
.snapshot-item summary { cursor: pointer; list-style: none; }
.snapshot-item summary::-webkit-details-marker { display: none; }
.snapshot-body h4 { margin-top: 12px; margin-bottom: 4px; font-size: 13px; }
.snapshot-body pre { background: #f5f5f5; padding: 8px; font-size: 11px; max-height: 300px; overflow: auto; }
.muted { color: #888; font-style: italic; }
.hint { color: #666; font-size: 12px; }
```

- [ ] **Step 5: 브라우저 수동 테스트**

"주문 가져오기" 몇 번 실행 → 탭3 대시보드로 이동 → "최근 조회 이력" 섹션에 스냅샷 리스트 표시됨.

클릭 시 원본 JSON이 확장되어야 함.

- [ ] **Step 6: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat(odd-order): add snapshot history section to dashboard tab"
```

---

## Task 11: 통합 검증 (프로덕션 배포 전)

**Files:** (변경 없음 — 검증만)

- [ ] **Step 1: 배포된 `.env.local` 보안 재확인**

```bash
cd C:\Users\admin\Desktop\rossehan-projects
git status
git ls-files | grep -i env
```

`.env.local` 파일이 git에 tracked되어 있으면 **즉시 중단**하고 제거:
```bash
git rm --cached odd-order/.env.local
git commit -m "chore: remove accidentally tracked .env.local"
```

그리고 API 키 **즉시 재발급** (이미 commit 히스토리에 남았을 수 있음).

- [ ] **Step 2: 하드코딩된 키 문자열 검색**

```bash
cd C:\Users\admin\Desktop\rossehan-projects\odd-order
grep -r "CEA algorithm" . --include='*.js' --include='*.html'
grep -rE "[a-f0-9]{30,}" . --include='*.js' --include='*.html' --exclude-dir=node_modules
```

코드/HTML에 Secret Key처럼 보이는 긴 16진수 문자열이 있으면 제거.

- [ ] **Step 3: 로컬 최종 시나리오 테스트**

`npx vercel dev` 실행 후 브라우저에서:

1. 탭1에서 "주문 가져오기" → 양쪽 채널 주문 표시 + 채널 뱃지
2. 3PL 발주서 다운로드 → 엑셀이 상품코드 기준 집계된 단일 파일로 생성
3. 매핑 실패 테스트: 쿠팡 매핑 테이블에서 한 항목 임시 제거 → 해당 주문에 "매핑 실패" 배지 표시
4. 에러 테스트: 환경변수 하나 비움 → 해당 채널만 실패 알림
5. 탭3 대시보드 → "최근 조회 이력"에 스냅샷 목록 표시
6. 기존 엑셀 업로드 기능 여전히 정상 동작

모두 통과 후 임시 변경사항 원복.

- [ ] **Step 4: 프로덕션 배포 (사용자 수동)**

```bash
cd C:\Users\admin\Desktop\rossehan-projects
git push origin main
```

Vercel이 자동 배포. Vercel 대시보드에서 Deployment 성공 확인.

- [ ] **Step 5: 프로덕션 실사용 검증**

배포된 URL에서:
1. "주문 가져오기" 클릭 → 실제 쿠팡 주문이 네이버와 함께 표시되는지
2. 3PL 발주서 다운로드 → 코드별 집계 정상인지
3. 이메일 발송(기존 기능) 정상인지
4. 탭3 대시보드 이력 저장되는지

이슈 발견 시 → 탭3 대시보드의 원본 JSON으로 디버깅 → 수정 → 재배포.

- [ ] **Step 6: 최종 안내 — 쿠팡 상품 확대 시 대응 방법**

사용자에게 전달:
> 추후 쿠팡에 새 옵션 상품이 추가될 때는:
> 1. 쿠팡 Wing에서 새 상품의 `vendorItemId` 확인
> 2. `index.html`의 `PRODUCT_MAP_COUPANG` 객체에 한 줄 추가:
>    `'새_vendorItemId': { code: '기존_3PL_코드', name: '3PL_상품명' },`
> 3. 커밋 & 푸시 → 자동 배포
> 코드 변경은 이 한 줄뿐. 다른 로직 수정 불필요.

---

## 완료 체크리스트 (최종)

- [ ] `.env.local`에 `COUPANG_*` 3개 추가됨 (로컬)
- [ ] Vercel 환경변수에 `COUPANG_*` 3개 추가됨 (프로덕션)
- [ ] `.env.local`이 git에 tracked되지 **않음** (이중 확인)
- [ ] `api/coupang-orders.js` 작성 + HMAC 서명 + 페이지네이션 감지
- [ ] `PRODUCT_MAP_COUPANG` 추가 + 기존 `PRODUCT_MAP` → `PRODUCT_MAP_NAVER` 리네임
- [ ] `normalizeNaverOrder` / `normalizeCoupangOrder` / `dedupeOrders` / `applyProductMapping` 함수 작성
- [ ] 주문 가져오기가 `Promise.allSettled`로 병렬 호출
- [ ] 주문 테이블에 "채널" 컬럼 + 매핑 실패 뱃지
- [ ] 채널별 알림 UI (3가지 케이스) + 페이지네이션 경고
- [ ] 주문 스냅샷 localStorage 10개 FIFO 저장
- [ ] 탭3 대시보드에 "최근 조회 이력" 섹션
- [ ] 로컬 + 프로덕션 시나리오 검증 통과
- [ ] 프로덕션 배포 + 실사용 검증 완료

---

## Out of Scope (이번 플랜에 포함 안 됨)

- 탭2 송장 변환 쿠팡 대응
- 쿠팡 Wing 자동 송장 등록
- 탭3 대시보드 채널별 매출 집계
- 쿠팡 주문 페이지네이션 자동 반복 호출 (초과 시 경고만)
- 주문 스냅샷 서버 측 영구 저장 (로컬 10개만)
