# ODD Order — 쿠팡 Wing Open API 연동 설계

작성일: 2026-04-16
대상 프로젝트: `odd-order/` (스마트스토어 ↔ 3PL 주문 자동화 웹앱)
관련 선행 설계: `2026-04-08-odd-order-naver-api-design.md`

## 1. 목적

현재 ODD Order는 스마트스토어(네이버) 주문만 자동으로 가져와 3PL(한아원/고고창고) 발주서로 변환한다. 공구 판매 채널에 쿠팡이 추가됨에 따라 쿠팡 주문도 동일한 발주서 흐름에 통합해야 한다.

## 2. 요구사항 요약

| 항목 | 결정 |
|---|---|
| 연동 방식 | 쿠팡 Wing Open API 자동 연동 (엑셀 업로드 방식 X) |
| API 키 상태 | 미발급 — 설계 문서에 발급 절차 포함 |
| UI 구성 | 탭1 "발주서 변환"에 통합 — 네이버+쿠팡 주문을 한 번에 가져와 3PL 발주서 1개로 병합 |
| 상품 매핑 | 쿠팡용 별도 매핑 테이블 (`PRODUCT_MAP_COUPANG`) 사용, 3PL 상품코드(P00300xxx)는 네이버와 공유 |
| 범위 | 탭1 (발주서 변환)만 — 탭2 송장 변환, 탭3 대시보드, 탭4 개인 발주는 이번 범위 밖 |

## 3. 전체 아키텍처

```
[탭1: 발주서 변환]
  ├─ [주문 가져오기] 버튼 → 네이버 + 쿠팡 병렬 호출
  ├─ [엑셀 업로드] 버튼  → 수동 대안 (기존 유지)
  ├─ 주문 테이블 (채널 컬럼 추가)
  └─ [3PL 발주서 다운로드] → 통합 엑셀 1개
          │                         │
          ▼                         ▼
   /api/orders.js           /api/coupang-orders.js (신규)
   (네이버, 기존)              (쿠팡, 신규)
          │                         │
          ▼                         ▼
   네이버 커머스 API           쿠팡 Wing Open API
```

**핵심 원칙**:
- 주문 조회 직후 모든 주문을 **공통 주문 객체 포맷**으로 정규화한다. 이후 모든 로직(상품 매핑, 발주서 생성, 화면 표시)은 채널 구분 없이 동일하게 동작한다.
- 두 채널 호출은 **반드시 `Promise.allSettled`** 사용 — 한쪽 API 실패/타임아웃이 다른 쪽을 막지 않는다.
- **타임존은 KST 고정** — 쿠팡 Wing Open API와 네이버 커머스 API 모두 KST 기준으로 주문 시간을 해석하므로, 서버리스 함수 내 시간 계산은 `Asia/Seoul` 오프셋으로 생성한다.

## 4. 공통 주문 객체 포맷

```js
{
  channel: 'naver' | 'coupang',   // 채널 구분 (신규 필드)
  orderId: '2026041600012345',    // 원본 주문번호
  matchKey: '5일분 3개(15개입)'    // 채널별 매핑 키:
                                  //   - naver: 옵션 텍스트 문자열
                                  //   - coupang: vendorItemId (문자열)
  displayOption: '5일분 3개(15개입)', // 화면 표시용 옵션 텍스트 (매핑 실패 디버깅용)
  quantity: 2,
  receiver: {
    name: '홍길동',
    phone: '010-1234-5678',
    address: '서울시 서초구 ...',
    zipCode: '06000',
    memo: '문앞에 놓아주세요'
  },
  productCode: 'P00300282',       // 매핑 후 부여
  productName: '5일분 3개'         // 매핑 후 부여
}
```

**매칭 키 설계 이유 (쿠팡)**: 쿠팡 `vendorItemName`은 판매자가 수정 가능하지만 `vendorItemId`(숫자)는 상품 존재 기간 동안 불변이다. 옵션명 오타 수정/리뉴얼 등으로 매핑이 silent하게 깨지는 것을 방지하기 위해 **ID 기반 매칭**을 사용한다. 네이버는 별도의 상품 옵션 ID가 노출되지 않아 텍스트 기반 유지.

## 5. 처리 플로우

```
1. [주문 가져오기] 버튼 클릭
     │
     ├─ Promise.allSettled 병렬 호출 (한쪽 실패가 전체를 막지 않음)
     │    ├─ fetch('/api/orders')         → 네이버 원본 응답
     │    └─ fetch('/api/coupang-orders') → 쿠팡 원본 응답
     │
2. 각각 공통 주문 포맷으로 정규화
     ├─ normalizeNaverOrder(raw)   → [{ channel: 'naver', ... }]
     └─ normalizeCoupangOrder(raw) → [{ channel: 'coupang', ... }]
     │
3. 두 배열 concat → 통합 orders 배열
     │  (dedupe: orderId 기준 중복 제거. "주문 가져오기" 버튼 2번 클릭 또는
     │   API가 동일 주문을 중복 반환하는 경우 방지)
     │
4. 상품 매핑 (채널별 매핑 테이블 사용)
     ├─ order.channel === 'naver'   → PRODUCT_MAP_NAVER[order.matchKey]   (텍스트 매칭)
     └─ order.channel === 'coupang' → PRODUCT_MAP_COUPANG[order.matchKey] (vendorItemId 매칭)
     │  → 둘 다 동일한 productCode(P00300xxx)로 수렴
     │  매핑 실패 시: productCode=null 유지, 화면에 '⚠️ 매핑 실패' 배지 + displayOption 표시
     │
5. 화면 테이블에 표시 (채널 컬럼 포함)
     │
6. [발주서 다운로드] 버튼
     → productCode 기준으로 집계 (채널 무관)
     → 3PL 엑셀 1개 생성
```

**에러 독립 처리 (3가지 케이스)**:
- 네이버 성공 + 쿠팡 실패 → 네이버 주문만 표시, 쿠팡 실패 알림 별도 표시
- 네이버 실패 + 쿠팡 성공 → 쿠팡 주문만 표시, 네이버 실패 알림 별도 표시
- **둘 다 실패** → "두 채널 모두 주문 가져오기에 실패했습니다. 엑셀 업로드로 진행하세요." + 각 채널 에러 메시지 별도 확장 영역에 표시 (개발자 콘솔 의존 없이 UI에서 원인 확인 가능)

`Promise.allSettled`로 각 채널 결과를 독립적으로 판정하고, 실패한 채널 에러는 UI 알림 + `console.error` 로그 동시 기록.

## 6. 쿠팡 Wing API 연동 상세

### 6.1 신규 파일

- `odd-order/api/coupang-orders.js` — Vercel 서버리스 함수 (쿠팡 API 프록시)

### 6.2 환경변수 (3개 신규)

```
COUPANG_ACCESS_KEY=xxxxxxxx-xxxx-xxxx
COUPANG_SECRET_KEY=xxxxxxxxxxxxxxxxxxxx
COUPANG_VENDOR_ID=A00123456
```

등록 위치 2곳:
- 로컬: `odd-order/.env.local` (`.gitignore`에 포함되어 있어 git 제외)
- Vercel: 프로젝트 Settings → Environment Variables → Redeploy

`.env.local.example`에는 키 이름만 플레이스홀더로 기록하여 git에 커밋한다.

### 6.3 인증 방식

- HMAC-SHA256 서명을 매 요청의 `Authorization` 헤더에 포함
- 네이버와 달리 토큰 발급/갱신 단계 없음 (요청별 서명) → 상태 관리 불필요
- 서명 규칙은 쿠팡 Open API 공식 샘플 방식을 그대로 따른다

### 6.4 엔드포인트

```
GET https://api-gateway.coupang.com/v2/providers/openapi/apis/api/v4/vendors/{vendorId}/ordersheets
  ?createdAtFrom=2026-04-15T00:00:00    // KST 기준
  &createdAtTo=2026-04-16T23:59:59      // KST 기준
  &status=ACCEPT
  &maxPerPage=50
```

- `status=ACCEPT`: 결제완료/상품준비중 상태. 네이버의 `PAYED`에 대응
- 조회 기간: 최근 24시간 (네이버와 동일), **KST 기준**
  - 서버리스 함수에서 `new Date()` 사용 시 Vercel 런타임이 UTC라는 점 유의 → `toLocaleString('en-US', { timeZone: 'Asia/Seoul' })` 또는 UTC+9 오프셋 직접 계산으로 KST 문자열 생성
  - 자정 경계 근처 주문 누락 방지가 핵심 목적
- **페이지네이션 안전장치 (신규)**:
  - 응답 확인 → 50건 꽉 찬 경우 `hasMore` 플래그 또는 `nextToken` 필드 존재 여부 체크
  - 초과 감지 시 **프론트엔드에 경고 표시**: "쿠팡 주문이 50건을 초과할 수 있습니다. 누락된 주문이 있는지 쿠팡 Wing에서 직접 확인하세요."
  - 자동 페이지네이션 반복 호출은 이번 범위에서 제외 (Out of Scope), 단 **조용히 누락되는 것만은 방지**

### 6.5 서버리스 함수 구조

```js
// api/coupang-orders.js
export default async function handler(req, res) {
  try {
    const { COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID } = process.env;
    // 1. 조회 기간 계산 (KST 기준, 지금 - 24h ~ 지금)
    //    Vercel 런타임은 UTC이므로 KST로 변환 필요
    // 2. HMAC-SHA256 서명 생성 (쿠팡 공식 샘플 방식)
    // 3. 쿠팡 API 호출 (fetch)
    // 4. 페이지네이션 초과 감지:
    //    - 반환된 data 배열 길이 === maxPerPage(50) 이거나
    //    - 응답에 nextToken/hasMore 같은 필드 존재 시
    //    - → { orders: data, warning: 'MAX_PAGE_REACHED' } 형태로 반환
    // 5. 정상 응답: { orders: data, warning: null }
    res.status(200).json({ orders: data, warning });
  } catch (err) {
    // 에러 로깅 (Vercel Logs에서 확인 가능하도록)
    console.error('[coupang-orders] error:', err);
    res.status(500).json({ error: err.message });
  }
}
```

### 6.6 쿠팡 응답 예시

```json
{
  "data": [{
    "orderId": 123456789,
    "orderedAt": "2026-04-16T10:30:00",
    "orderer": { "name": "홍길동" },
    "receiver": {
      "name": "홍길동",
      "addr1": "서울시 서초구 서초대로 ...",
      "postCode": "06000",
      "receiverNumber1": "010-1234-5678"
    },
    "orderItems": [{
      "vendorItemId": 95241053251,
      "vendorItemName": "액상 25ml + 정제 1.2g 5개입",
      "shippingCount": 2,
      "parcelPrintMessage": "문앞에 놓아주세요"
    }]
  }]
}
```

### 6.7 정규화 함수 (프론트)

```js
function normalizeCoupangOrder(rawResponse) {
  return rawResponse.data.flatMap(order =>
    order.orderItems.map(item => ({
      channel: 'coupang',
      orderId: String(order.orderId),
      matchKey: String(item.vendorItemId),     // ← vendorItemId로 매칭
      displayOption: item.vendorItemName,       // 화면 표시/디버깅용
      quantity: item.shippingCount,
      receiver: {
        name: order.receiver.name,
        phone: order.receiver.receiverNumber1,
        address: order.receiver.addr1,
        zipCode: order.receiver.postCode,
        memo: item.parcelPrintMessage || ''
      }
    }))
  );
}
```

네이버 쪽도 동형의 `normalizeNaverOrder(raw)` 함수로 리팩터링하여 일관성을 맞춘다. 네이버의 경우 `matchKey`와 `displayOption`은 모두 옵션 텍스트 문자열로 동일.

## 7. 쿠팡 Wing Open API 키 발급 절차 (사용자 작업)

1. **쿠팡 Wing 로그인** — https://wing.coupang.com
2. **Open API 사용 신청**
   - 메뉴 위치: `사용자 설정` → `Open API 키 발급` (쿠팡 정책에 따라 위치 변경 가능)
3. **발급 후 확보할 3가지 정보**

   | 항목 | 용도 |
   |---|---|
   | Access Key | HMAC 서명 생성에 사용 |
   | Secret Key | HMAC 서명 생성에 사용 (발급 시에만 노출) |
   | Vendor ID | 주문 조회 엔드포인트 경로 (`A00123456` 형식) |

4. **환경변수 등록 (2곳)**
   - `odd-order/.env.local`
   - Vercel 프로젝트 Environment Variables → Redeploy

### 주의사항
- Secret Key는 발급 시에만 평문 노출되므로 즉시 안전한 곳에 복사/보관
- `.env.local`은 절대 git commit 금지 (`.gitignore`에 포함되어 있음을 배포 전 확인)
- 키 유출 의심 시 쿠팡 Wing에서 즉시 재발급

## 8. 상품 매핑 테이블

3PL 상품 코드(`P00300279`~`P00300285`)는 네이버와 동일하게 공유한다. 쿠팡은 **vendorItemId를 키로** 매핑한다 (옵션 텍스트가 아님 — 안정성 확보).

쿠팡은 현재 아래 2개 상품만 판매 중이므로 매핑 테이블도 2개 항목으로 유지:

```js
const PRODUCT_MAP_COUPANG = {
  // vendorItemId (문자열) → { code, name }
  '95241053251': { code: 'P00300280', name: '오드 M-01 스타터키트 5일분' },  // 액상 25ml + 정제 1.2g 5개입
  '95241053249': { code: 'P00300281', name: '오드 M-01 리필팩 30일분' },     // 액상 25ml + 정제 1.2g 30개입
};
```

| 쿠팡 vendorItemId | 쿠팡 옵션명 (표시용) | 3PL 코드 | 3PL 상품명 | 네이버 대응 |
|---|---|---|---|---|
| 95241053251 | 액상 25ml + 정제 1.2g 5개입 | P00300280 | 오드 M-01 스타터키트 5일분 | 5일분 1개 |
| 95241053249 | 액상 25ml + 정제 1.2g 30개입 | P00300281 | 오드 M-01 리필팩 30일분 | 30일분 |

**추후 쿠팡 상품 확대 시 대응**:
- 새 옵션 추가되면 이 테이블에 vendorItemId 추가만 하면 됨 (코드 변경 불필요)
- 매핑 테이블에 없는 vendorItemId가 주문에 포함되면 UI에 "⚠️ 매핑 실패" 표시 → 발주서 생성 시 해당 행 제외하고, 사용자에게 수동 처리 안내

## 8.5 주문 스냅샷 추적 (추적성, 신규)

**동기**: 네이버/쿠팡 주문이 혼합된 후 누락/중복/오매핑 클레임이 발생했을 때, 원인을 추적할 수 있어야 한다. 현재 앱에는 "이번에 API가 뭘 반환했는지"를 사후 확인할 방법이 없음.

**설계**:
- `localStorage` 키 `orderSnapshots`에 **최근 10회까지** 주문 가져오기 스냅샷 저장
- 스냅샷 구조:
  ```js
  {
    ts: '2026-04-16T15:30:00+09:00',   // 수집 시각 (KST)
    naver: {
      status: 'fulfilled' | 'rejected',
      rawResponse: {...} | null,         // 네이버 API 원본
      error: string | null,
      orderCount: 12
    },
    coupang: {
      status: 'fulfilled' | 'rejected',
      rawResponse: {...} | null,         // 쿠팡 API 원본
      warning: 'MAX_PAGE_REACHED' | null,
      error: string | null,
      orderCount: 7
    },
    normalized: [{ channel, orderId, ... }, ...]  // 정규화된 통합 배열
  }
  ```
- FIFO로 10개 초과 시 오래된 것부터 자동 삭제 (localStorage 용량 관리)
- 대시보드(탭3)에 **"최근 조회 이력"** 섹션 추가 — 시각 + 채널별 건수 + 실패 여부 표시, 클릭 시 원본 JSON 확장 보기

**비범위**: 서버 측 저장, 영구 보관, 검색 기능은 제외. 클레임 대응용 단기 증거 확보가 목적.

## 9. UI 변경사항

- **주문 테이블**: 기존 컬럼 앞에 "채널" 컬럼 추가 (값: `네이버` / `쿠팡`)
- **주문 가져오기 버튼**: 레이블은 그대로 유지, 내부적으로 두 API 병렬 호출 (`Promise.allSettled`)
- **알림 영역**: 네이버/쿠팡 각각의 조회 건수와 실패 여부를 별도로 표시
  - 성공 예: `네이버 12건, 쿠팡 7건 가져왔습니다 (중복 제거 0건)`
  - 부분 실패 예: `쿠팡 주문 가져오기 실패 - 네이버 12건만 표시` + "자세히" 클릭 시 에러 메시지 확장
  - 전체 실패 예: `두 채널 모두 주문 가져오기에 실패했습니다. 엑셀 업로드로 진행하세요.` + 각 채널 에러 확장 가능
  - 쿠팡 50건 초과 경고: `⚠️ 쿠팡 주문이 50건에 도달했습니다. 누락 여부를 쿠팡 Wing에서 직접 확인하세요.`
- **대시보드(탭3)에 "최근 조회 이력" 섹션 추가** (추적성):
  - 최근 10회까지 스냅샷 리스트 (시각 + 네이버/쿠팡 건수 + 상태)
  - 행 클릭 시 원본 API 응답 JSON 확장 표시

## 10. 범위 정리

### In Scope
- `api/coupang-orders.js` 서버리스 함수 신규 작성
  - HMAC 서명, KST 타임존 계산, 페이지네이션 초과 감지(`warning` 필드)
  - `console.error` 로깅
- `index.html` 수정:
  - 주문 가져오기 로직을 두 채널 병렬(`Promise.allSettled`)로 확장
  - `PRODUCT_MAP_COUPANG` 신규 테이블
  - `normalizeNaverOrder`, `normalizeCoupangOrder` 공통 정규화 함수
  - 통합 후 `orderId` 기준 dedupe 처리
  - 주문 테이블에 "채널" 컬럼 추가
  - 채널별 에러 독립 처리 (3가지 케이스: 네이버만/쿠팡만/둘 다 실패)
  - 50건 초과 경고 알림 UI
- **주문 스냅샷 추적 (신규)**:
  - `orderSnapshots` localStorage 저장/FIFO 관리 (10개)
  - 탭3 대시보드에 "최근 조회 이력" 섹션 추가
- `.env.local.example` 업데이트 (COUPANG_* 3개)
- `vercel.json` 필요 시 함수 추가 반영

### Out of Scope (차기 과제)
- 탭2 송장 변환 쿠팡 대응
- 쿠팡 Wing 자동 송장 등록 API 연동
- 탭3 대시보드 채널별 매출 집계 (이력 표시는 포함)
- 쿠팡 주문 페이지네이션 자동 반복 호출 (50건 초과 시 경고만 표시)
- 주문 스냅샷 서버 측 영구 저장 (로컬 10개만 유지)

### 사용자 선행 작업
1. 쿠팡 Wing Open API 키 발급 (Access Key / Secret Key / Vendor ID) — ✅ 완료
2. 쿠팡 상품 vendorItemId 확인 — ✅ 완료 (2개 상품: `95241053251`, `95241053249`)
3. `.env.local` 및 Vercel 환경변수에 COUPANG_* 3개 직접 입력 — **구현 시작 전 필수**

## 11. 검증 기준

**기능 검증**
- 네이버만 주문 있을 때: 기존과 동일하게 동작, 채널 컬럼에 "네이버"만 표시
- 쿠팡만 주문 있을 때: 쿠팡 주문 표시, 3PL 발주서 엑셀 정상 생성
- 네이버+쿠팡 혼합: 두 채널 주문이 한 테이블에 표시되고, 발주서는 상품코드 기준으로 합산된 엑셀 1개로 출력

**에러 처리 검증**
- 네이버 API 실패 + 쿠팡 성공: 쿠팡 주문만 표시, 네이버 실패 알림 + 에러 상세 확장 가능
- 쿠팡 API 실패 + 네이버 성공: 반대 경우 동일
- 둘 다 실패: 전체 실패 알림 + 엑셀 업로드 안내, 각 채널 에러 확장 가능

**신규 검증 항목**
- 주문 가져오기 버튼 연속 2회 클릭 시 `orderId` 기준 중복 제거되어 같은 주문이 2번 표시되지 않음
- KST 자정 근처 주문 (예: 23:55 주문)이 정상 조회됨 (UTC로 계산 시 누락되는 버그 없음)
- 쿠팡 주문이 50건에 도달한 경우 경고 알림이 표시됨
- 주문 조회 성공 후 탭3 "최근 조회 이력"에 해당 스냅샷이 추가됨
- 10회 초과 조회 시 가장 오래된 스냅샷이 삭제됨

**보안 검증**
- `.env.local`이 `git status`에 뜨지 않는지 배포 전 확인
- 소스 코드 어디에도 Access Key / Secret Key 평문 하드코딩 없음 (`process.env.*`만 참조)
- GitHub에 push된 후 전체 파일 텍스트 검색으로 키 일부 문자열 유출 여부 재확인
