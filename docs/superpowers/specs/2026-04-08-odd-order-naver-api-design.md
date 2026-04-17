# ODD Order — 네이버 커머스 API 주문 자동 가져오기 설계

## 요약
스마트스토어에서 수동으로 주문 엑셀을 다운로드하는 대신, 네이버 커머스 API를 통해 주문을 자동으로 가져오는 기능. Vercel 서버리스 함수를 프록시로 사용.

## 워크플로우
1. 탭1에서 "주문 가져오기" 버튼 클릭
2. `/api/orders` 서버리스 함수 호출
3. 서버에서 네이버 API 인증 → PAYED 상태 주문 조회
4. 프론트엔드에서 주문 목록 표시
5. 기존 변환 로직으로 발주서 엑셀 생성 → 다운로드

## 서버리스 함수: api/orders.js

### 인증 흐름
1. `client_id + "_" + timestamp(ms)` 문자열 생성
2. `client_secret`을 키로 HMAC-SHA256 해시 → Base64 인코딩 = `client_secret_sign`
3. POST `https://api.commerce.naver.com/external/v1/oauth2/token`
   - body: client_id, timestamp, client_secret_sign, grant_type=client_credentials, type=SELF
4. 응답에서 access_token 획득 (3시간 유효)

### 주문 조회
- GET `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/last-changed-statuses`
- 파라미터: lastChangedFrom (24시간 전), lastChangedType=PAYED, limitCount=300
- 커서 기반 페이지네이션 (moreSequence)

### 응답 매핑
| 네이버 API 필드 | 앱 내부 필드 |
|---|---|
| productOrderId | 상품주문번호 |
| shippingAddress.name | 수취인명 |
| shippingAddress.tel1 | 핸드폰 |
| shippingAddress.tel2 | 기타연락처 |
| shippingAddress.baseAddress + detailedAddress | 주소 |
| product.productName | 상품명 |
| product.productOption | 옵션정보 |
| product.quantity | 수량 |
| shippingAddress.deliveryMemo | 배송메세지 |
| totalPaymentAmount | 결제금액 |

## 프론트엔드 변경 (탭1)
- 엑셀 업로드 영역 위에 "주문 가져오기" 버튼 추가
- 버튼 클릭 → fetch('/api/orders') → 응답 데이터를 기존 파싱 로직과 동일한 형태로 변환
- 기존 엑셀 업로드 기능은 폴백으로 유지

## 파일 구조
```
odd-order/
  index.html
  api/
    orders.js
  .env.local
  vercel.json
```

## 환경변수
- NAVER_CLIENT_ID
- NAVER_CLIENT_SECRET
