# ODD 공구 발주서 자동화 - 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스마트스토어 ↔ 3PL(한아원) 발주서 변환 + 송장 변환 + 대시보드를 단일 HTML 웹앱으로 구현

**Architecture:** 단일 HTML 파일에 CSS/JS 내장. SheetJS CDN으로 엑셀 처리. localStorage로 공구 회차별 데이터 보관. Vercel 정적 배포.

**Tech Stack:** HTML + 바닐라 JS + SheetJS (xlsx) CDN + localStorage + Vercel

**Spec:** `docs/superpowers/specs/2026-03-31-odd-order-automation-design.md`
**Design Preview:** `C:\Users\admin\Desktop\공구발주서-디자인.html`

---

## 파일 구조

```
rossehan-projects/
├── odd-order/
│   └── index.html          # 전체 앱 (단일 파일)
├── docs/superpowers/
│   ├── specs/2026-03-31-odd-order-automation-design.md
│   └── plans/2026-03-31-odd-order-automation.md (이 파일)
```

단일 HTML 파일이지만 내부적으로 명확한 섹션 구분:
- `<style>` — 전체 CSS (디자인 프리뷰 HTML 기반)
- `<script>` 상단 — 설정값, 매핑 테이블, localStorage 헬퍼
- `<script>` 중단 — 탭 1/2/3 로직
- `<script>` 하단 — UI 유틸 (토스트, 탭 전환, 이벤트 바인딩)

---

## Task 1: 프로젝트 셋업 + HTML 뼈대

**Files:**
- Create: `odd-order/index.html`

- [ ] **Step 1: 프로젝트 폴더 생성**

```bash
mkdir -p rossehan-projects/odd-order
```

- [ ] **Step 2: HTML 뼈대 작성**

`odd-order/index.html` 생성. 포함 내용:
- DOCTYPE, meta charset, viewport
- SheetJS CDN: `<script src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"></script>`
- 3탭 네비게이션 구조 (발주서 변환 / 송장 변환 / 대시보드)
- 활성 공구 배너 (상단 고정)
- 각 탭 빈 컨테이너 (`<div id="tab1">`, `<div id="tab2">`, `<div id="tab3">`)
- 토스트 컨테이너
- 기본 CSS (디자인 프리뷰 HTML에서 가져오기)

- [ ] **Step 3: 탭 전환 JS 구현**

```javascript
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  document.querySelector(`[data-tab="${tabId}"]`).classList.add('active');
}
```

- [ ] **Step 4: 브라우저에서 열어 확인**

`odd-order/index.html`을 브라우저에서 열기. 3탭 전환이 정상 동작하는지 확인.

- [ ] **Step 5: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat: odd-order 프로젝트 셋업 및 HTML 뼈대"
```

---

## Task 2: 설정값 + 매핑 테이블 + localStorage 헬퍼

**Files:**
- Modify: `odd-order/index.html` (script 섹션)

- [ ] **Step 1: 설정값 상수 정의**

```javascript
const CONFIG = {
  sender: { name: '한아원', phone: '010-7701-2732', address: '서초대로 60길 18, 한아원 9층' },
  email: { to: 'gogo@gogochango.com', from: 'rossehan@hanah1.com' },
  shipping: { method: '택배,등기,소포', courier: 'CJ대한통운' },
  validOrderStatuses: ['결제완료', '발주확인']
};
```

- [ ] **Step 2: 상품 매핑 테이블 정의**

긴 문자열 우선 매칭 순서:
```javascript
const PRODUCT_MAP = [
  { match: '30일분 3개 + 5일분 4개(110개입)', name: '리필팩 3개 + 스타터키트 4개', code: '' },
  { match: '30일분 2개 + 5일분 3개(75개입)', name: '리필팩 2개 + 스타터키트 3개', code: '' },
  { match: '30일분 1개 + 5일분 2개(40개입)', name: '리필팩 1개 + 스타터키트 2개', code: '' },
  { match: '5일분 3개(15개입)', name: '스타터키트 5일분 3개', code: '' },
  { match: '5일분 1개', name: '오드 M-01 스타터키트 5일분', code: 'P00300280' }
];

function mapProduct(optionText) {
  const trimmed = (optionText || '').trim();
  for (const item of PRODUCT_MAP) {
    if (trimmed.includes(item.match)) return item;
  }
  return null;
}
```

- [ ] **Step 3: localStorage 헬퍼 함수 구현**

```javascript
const STORAGE_KEY = 'odd-orders';

function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : { activeRoundId: null, rounds: [] };
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getActiveRound() {
  const data = loadData();
  return data.rounds.find(r => r.id === data.activeRoundId) || null;
}

function saveSnapshot() {
  localStorage.setItem(STORAGE_KEY + '-undo', localStorage.getItem(STORAGE_KEY));
}

function undoLastChange() {
  const snapshot = localStorage.getItem(STORAGE_KEY + '-undo');
  if (snapshot) {
    localStorage.setItem(STORAGE_KEY, snapshot);
    showToast('되돌리기 완료');
    refreshUI();
  }
}
```

- [ ] **Step 4: 토스트 메시지 함수 구현**

```javascript
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.getElementById('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
```

- [ ] **Step 5: 브라우저 콘솔에서 헬퍼 함수 테스트**

```javascript
// 콘솔에서 실행:
mapProduct('ODD. M-01 오드 혈당 영양제 관리 케어 5일분 1개')
// 기대 결과: { match: '5일분 1개', name: '오드 M-01 스타터키트 5일분', code: 'P00300280' }

mapProduct('ODD. M-01 오드 혈당 영양제 관리 케어 30일분 1개 + 5일분 2개(40개입)')
// 기대 결과: { match: '30일분 1개 + 5일분 2개(40개입)', ... }
```

- [ ] **Step 6: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat: 설정값, 상품 매핑 테이블, localStorage 헬퍼 추가"
```

---

## Task 3: 공구 회차 관리 (생성/선택/배너)

**Files:**
- Modify: `odd-order/index.html`

- [ ] **Step 1: 공구 생성 모달 HTML 추가**

모달에 입력 필드: 회차명, 시작일, 종료일, 인플루언서명(선택)

- [ ] **Step 2: 공구 생성 JS 구현**

```javascript
function createRound(name, startDate, endDate, influencer) {
  const data = loadData();
  const id = 'round-' + Date.now();
  data.rounds.push({ id, name, startDate, endDate, influencer, orders: [] });
  data.activeRoundId = id;
  saveData(data);
  refreshUI();
  showToast(`${name} 생성 완료`);
}
```

- [ ] **Step 3: 활성 공구 배너 렌더링**

```javascript
function renderRoundBanner() {
  const round = getActiveRound();
  const banner = document.getElementById('round-banner');
  if (!round) {
    banner.innerHTML = '<span>공구를 먼저 만들어주세요</span><button onclick="openCreateRoundModal()">새 공구 만들기</button>';
    return;
  }
  banner.innerHTML = `<span>현재: ${round.name} (${round.startDate}~${round.endDate}${round.influencer ? ' | ' + round.influencer : ''})</span>
    <select onchange="switchRound(this.value)">${renderRoundOptions()}</select>`;
}
```

- [ ] **Step 4: 공구 전환 기능 구현**

```javascript
function switchRound(roundId) {
  const data = loadData();
  data.activeRoundId = roundId;
  saveData(data);
  refreshUI();
}
```

- [ ] **Step 5: 빈 상태 처리**

공구 미생성 시 탭 1/2에 "먼저 공구를 만들어주세요" + 버튼 표시. 업로드 영역 비활성화.

- [ ] **Step 6: 브라우저에서 테스트**

1. 첫 진입 → "공구를 먼저 만들어주세요" 표시 확인
2. 공구 생성 → 배너에 회차 정보 표시 확인
3. 두 번째 공구 생성 → 드롭다운 전환 확인

- [ ] **Step 7: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat: 공구 회차 생성/선택/배너 구현"
```

---

## Task 4: 탭 1 — 엑셀 업로드 + 파싱 + 변환 로직

**Files:**
- Modify: `odd-order/index.html`

- [ ] **Step 1: 파일 업로드 UI 구현**

드래그앤드롭 + 클릭 선택 업로드 영역. 워크플로우 진행 표시기 포함: `엑셀 업로드 → 변환 확인 → 다운로드 → Gmail 발송`

- [ ] **Step 2: 엑셀 파싱 함수 구현**

```javascript
function parseSmartStoreExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      // trim 모든 헤더명
      const cleaned = rows.map(row => {
        const obj = {};
        for (const [key, val] of Object.entries(row)) {
          obj[key.trim()] = val;
        }
        return obj;
      });
      resolve(cleaned);
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
```

- [ ] **Step 3: 주문 상태 필터링 + 상품 매핑 변환**

```javascript
function convertOrders(rows) {
  const results = [];
  let excludedCount = 0;

  rows.forEach((row, i) => {
    const status = (row['주문상태'] || '').trim();
    if (!CONFIG.validOrderStatuses.includes(status)) {
      excludedCount++;
      return;
    }
    const product = mapProduct(row['옵션정보']);
    results.push({
      seq: results.length + 1,
      recipientName: row['수취인명'] || '',
      productName: product ? product.name : '',
      productCode: product ? product.code : '',
      mappingFailed: !product,
      quantity: row['수량'] || 1,
      phone: row['수취인연락처1'] || '',
      phone2: row['수취인연락처2'] || '',
      address: ((row['기본배송지'] || '') + ' ' + (row['상세배송지'] || '')).trim(),
      message: row['배송메세지'] || '',
      productOrderNo: row['상품주문번호'] || '',
      amount: Number(row['최종 상품별 총 주문금액']) || 0,
      option: row['옵션정보'] || '',
      orderedAt: row['주문일시'] || ''
    });
  });

  return { results, excludedCount };
}
```

- [ ] **Step 4: 중복 주문 감지 로직**

```javascript
function checkDuplicates(orders) {
  const round = getActiveRound();
  if (!round) return [];
  const existing = new Set(round.orders.map(o => o.productOrderNo));
  return orders.filter(o => existing.has(o.productOrderNo));
}
```

- [ ] **Step 5: 변환 완료 토스트 + 미리보기 테이블 렌더링**

변환 완료 후 토스트 표시:
```javascript
// 업로드 핸들러에서 convertOrders() 호출 후:
const { results, excludedCount } = convertOrders(rows);
if (excludedCount > 0) {
  showToast(`총 ${rows.length}건 중 취소/환불 ${excludedCount}건 제외, ${results.length}건 변환됨`);
} else {
  showToast(`${results.length}건 변환 완료!`);
}
```

변환 결과를 3PL 양식 컬럼 순서로 테이블 표시. 매핑 실패 행 빨간 하이라이트. 자동 채움 값 파란 이탤릭.

- [ ] **Step 6: 워크플로우 진행 표시기 업데이트**

업로드 완료 시 "엑셀 업로드" 스텝에 체크, "변환 확인" 스텝 활성화.

- [ ] **Step 7: 실제 스마트스토어 엑셀로 테스트**

`C:\Users\admin\Desktop\스마트스토어_전체주문발주발송관리.xlsx`를 업로드하여 파싱 + 변환 결과 확인.

- [ ] **Step 8: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat: 탭1 엑셀 업로드, 파싱, 변환, 미리보기 구현"
```

---

## Task 5: 탭 1 — 엑셀 다운로드 + Gmail 연동

**Files:**
- Modify: `odd-order/index.html`

- [ ] **Step 1: 3PL 발주서 엑셀 생성 + 다운로드**

```javascript
function downloadOrderExcel(orders) {
  const today = new Date().toISOString().slice(0, 10);
  const wsData = [
    ['보내는분', '보내는분 연락처', '주소', '번호', '수취인명', '상품명', '수량', '핸드폰', '기타연락처', '주소', '배송메세지', '', '상품고유코드', '배송방식', '운송장번호', '택배사']
  ];
  orders.forEach(o => {
    wsData.push([
      CONFIG.sender.name, CONFIG.sender.phone, CONFIG.sender.address,
      o.seq, o.recipientName, o.productName, o.quantity,
      o.phone, o.phone2, o.address, o.message,
      o.productOrderNo, o.productCode, '', '', ''
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '1차');
  XLSX.writeFile(wb, `${today} 한아원 발주서.xlsx`);
  showToast(`${today} 한아원 발주서.xlsx 다운로드 완료`);
}
```

- [ ] **Step 2: localStorage에 주문 데이터 저장**

```javascript
function saveOrdersToStorage(orders) {
  saveSnapshot(); // undo용 스냅샷
  const data = loadData();
  const round = data.rounds.find(r => r.id === data.activeRoundId);
  orders.forEach(o => {
    const existing = round.orders.findIndex(e => e.productOrderNo === o.productOrderNo);
    const orderData = {
      productOrderNo: o.productOrderNo,
      recipientName: o.recipientName,
      phone: o.phone,
      option: o.option,
      threePLProductName: o.productName,
      quantity: o.quantity,
      amount: o.amount,
      address: o.address,
      status: 'pending',
      trackingNo: '',
      orderedAt: o.orderedAt,
      shippedAt: ''
    };
    if (existing >= 0) {
      round.orders[existing] = { ...round.orders[existing], ...orderData };
    } else {
      round.orders.push(orderData);
    }
  });
  saveData(data);
}
```

- [ ] **Step 3: Gmail compose URL 생성**

```javascript
function openGmail() {
  const today = new Date();
  const dateStr = today.toLocaleDateString('ko-KR', { year: '2-digit', month: '2-digit', day: '2-digit' }).replace(/\. /g, '.').replace('.', '');
  // "26.03.31" 형식 생성
  const yy = String(today.getFullYear()).slice(-2);
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const formatted = `${yy}.${mm}.${dd}`;

  const subject = `[한아원] ${formatted} 한아원 발주서 전달의 건`;
  const body = `안녕하세요,\n한아원 한로제입니다.\n\n${formatted} 한아원 발주서 전달드립니다.\n확인 후 송장번호 공유 부탁드리겠습니다.\n\n\n감사합니다!\n한로제 드림`;

  const url = `https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(CONFIG.email.to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.open(url, '_blank');
}
```

- [ ] **Step 4: 다운로드/Gmail 버튼 연결 + 진행 표시기 업데이트**

다운로드 클릭 시 → "다운로드" 스텝 체크. Gmail 클릭 시 → "Gmail 발송" 스텝 체크.

- [ ] **Step 5: 되돌리기 버튼 추가**

탭 1 하단에 "되돌리기" 버튼. `undoLastChange()` 호출.

- [ ] **Step 6: 실제 엑셀로 전체 흐름 테스트**

업로드 → 미리보기 → 다운로드 → Gmail 열기 → 생성된 발주서 엑셀 열어서 양식 확인.

- [ ] **Step 7: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat: 탭1 엑셀 다운로드, localStorage 저장, Gmail 연동 구현"
```

---

## Task 6: 탭 2 — 송장 변환

**Files:**
- Modify: `odd-order/index.html`

- [ ] **Step 1: 송장 업로드 UI + 워크플로우 표시기**

탭 2에 파일 업로드 영역 + 진행 표시기: `엑셀 업로드 → 변환 확인 → 다운로드`

- [ ] **Step 2: 3PL 회신 엑셀 파싱 + 변환**

```javascript
function parseTrackingExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const wb = XLSX.read(e.target.result, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
      // 헤더 행 스킵 (1행), 데이터는 2행부터
      const results = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;
        const productOrderNo = String(row[11] || '').trim(); // L열 (인덱스 11)
        const trackingNo = String(row[14] || '').trim();      // O열 (인덱스 14)
        if (!productOrderNo) { skippedNoOrderNo++; continue; }
        if (!trackingNo) { skippedNoTracking++; continue; }
        results.push({ productOrderNo, trackingNo });
      }
      resolve({ results, skippedNoOrderNo, skippedNoTracking });
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
```

- [ ] **Step 3: 스킵 건수 경고 + 미리보기 테이블 렌더링**

파싱 후 스킵 건수가 있으면 경고 토스트:
```javascript
// parseTrackingExcel 호출 후:
const { results, skippedNoOrderNo, skippedNoTracking } = await parseTrackingExcel(file);
if (skippedNoOrderNo > 0 || skippedNoTracking > 0) {
  showToast(`주문번호 없음 ${skippedNoOrderNo}건, 송장번호 없음 ${skippedNoTracking}건 제외됨`, 'warning');
}
```

4컬럼 테이블: 상품주문번호, 배송방법(고정), 택배사(고정), 송장번호

- [ ] **Step 4: 스마트스토어 송장 엑셀 생성 + 다운로드**

```javascript
function downloadTrackingExcel(trackingData) {
  const wsData = [['상품주문번호', '배송방법', '택배사', '송장번호']];
  trackingData.forEach(t => {
    wsData.push([t.productOrderNo, CONFIG.shipping.method, CONFIG.shipping.courier, t.trackingNo]);
  });
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  // .xls 형식으로 출력 (스마트스토어 요구)
  XLSX.writeFile(wb, '스마트스토어_송장업로드.xls', { bookType: 'xls' });
  showToast('스마트스토어_송장업로드.xls 다운로드 완료');
}
```

- [ ] **Step 5: localStorage 발송상태 업데이트**

```javascript
function updateShippingStatus(trackingData) {
  saveSnapshot();
  const data = loadData();
  const round = data.rounds.find(r => r.id === data.activeRoundId);
  if (!round) return;
  let updated = 0;
  const today = new Date().toISOString().slice(0, 10);
  trackingData.forEach(t => {
    const order = round.orders.find(o => o.productOrderNo === t.productOrderNo);
    if (order) {
      order.status = 'shipped';
      order.trackingNo = t.trackingNo;
      order.shippedAt = today;
      updated++;
    }
  });
  saveData(data);
  const total = round.orders.length;
  const shipped = round.orders.filter(o => o.status === 'shipped').length;
  const pct = total > 0 ? Math.round((shipped / total) * 100) : 0;
  showToast(`${updated}건 송장 반영 완료! 발송완료율 ${pct}%`);
}
```

- [ ] **Step 6: 실제 한아원 발주서 회신 엑셀로 테스트**

기존 `발주서` 폴더의 엑셀 파일을 사용하여 테스트. (공란) 컬럼에 데이터가 있는지 확인. 없으면 Task 4에서 생성한 발주서를 수동으로 수정하여 테스트.

- [ ] **Step 7: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat: 탭2 송장 변환 (3PL→스마트스토어) 구현"
```

---

## Task 7: 탭 3 — 대시보드 (요약 카드 + 옵션별 분석)

**Files:**
- Modify: `odd-order/index.html`

- [ ] **Step 1: 요약 카드 렌더링**

```javascript
function renderDashboard() {
  const round = getActiveRound();
  if (!round || round.orders.length === 0) {
    document.getElementById('dashboard-content').innerHTML = '<p class="empty-state">아직 주문 데이터가 없습니다. 발주서를 변환하면 여기에 현황이 표시됩니다.</p>';
    return;
  }
  const total = round.orders.length;
  const shipped = round.orders.filter(o => o.status === 'shipped').length;
  const pending = total - shipped;
  const revenue = round.orders.reduce((sum, o) => sum + o.amount, 0);
  // 요약 카드 HTML 렌더링
}
```

- [ ] **Step 2: 옵션별 매출 분석 테이블**

옵션별 그룹화 → 주문 수, 금액 합계 계산. 합계 행 포함.

- [ ] **Step 3: 옵션 필터 칩 구현**

"전체" + 각 옵션별 칩. 클릭 시 테이블 필터링.

- [ ] **Step 4: CSS 가로 막대 차트**

```javascript
function renderChart(optionData, maxAmount) {
  return optionData.map(d => `
    <div class="chart-row">
      <span class="chart-label">${d.option}</span>
      <div class="chart-bar-bg">
        <div class="chart-bar" style="width: ${(d.amount / maxAmount * 100)}%"></div>
      </div>
      <span class="chart-value">${d.amount.toLocaleString()}원</span>
    </div>
  `).join('');
}
```

CSS:
```css
.chart-bar-bg { flex: 1; background: #f3f4f6; border-radius: 4px; height: 24px; }
.chart-bar { background: linear-gradient(90deg, #4f46e5, #7c3aed); height: 100%; border-radius: 4px; transition: width 0.3s; }
```

- [ ] **Step 5: 브라우저에서 대시보드 확인**

Task 4-5에서 저장된 데이터로 대시보드 렌더링 확인. 필터 칩 동작 확인. 차트 표시 확인.

- [ ] **Step 6: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat: 탭3 대시보드 요약카드, 옵션별 분석, 차트 구현"
```

---

## Task 8: 탭 3 — 주문 검색 + 공구 회차 관리 + 엑셀 다운로드

**Files:**
- Modify: `odd-order/index.html`

- [ ] **Step 1: 주문 검색 UI + 로직**

```javascript
function searchOrders(query) {
  const round = getActiveRound();
  if (!round) return [];
  const q = query.trim().toLowerCase();
  return round.orders.filter(o =>
    o.recipientName.toLowerCase().includes(q) ||
    o.phone.includes(q)
  );
}
```

검색 결과 테이블: 수취인명, 연락처, 옵션, 주소, 발송상태(배지), 송장번호

- [ ] **Step 2: 공구 회차 선택 UI (대시보드 내)**

회차 태그 목록 + "+" 버튼으로 새 공구 생성.

- [ ] **Step 3: 전체 주문 엑셀 다운로드**

```javascript
function downloadAllOrdersExcel() {
  const round = getActiveRound();
  if (!round) return;
  const wsData = [['수취인명', '연락처', '옵션', '수량', '금액', '주소', '발송상태', '송장번호', '주문일시']];
  round.orders.forEach(o => {
    wsData.push([o.recipientName, o.phone, o.option, o.quantity, o.amount, o.address,
      o.status === 'shipped' ? '발송완료' : '발송대기', o.trackingNo, o.orderedAt]);
  });
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '전체주문');
  XLSX.writeFile(wb, `${round.name}_전체주문.xlsx`);
}
```

- [ ] **Step 4: 옵션별 매출 엑셀 다운로드**

옵션별 집계 데이터를 엑셀로 내보내기: 옵션명, 주문 수, 금액, 비중(%)

- [ ] **Step 5: 전체 테스트**

검색 → 수취인명 입력 → 결과 확인. 엑셀 다운로드 2종 확인.

- [ ] **Step 6: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat: 탭3 주문검색, 공구회차 관리, 엑셀 다운로드 구현"
```

---

## Task 9: 데이터 백업/복원 + 마무리

**Files:**
- Modify: `odd-order/index.html`

- [ ] **Step 1: 데이터 백업 (JSON 다운로드)**

```javascript
function backupData() {
  const data = localStorage.getItem(STORAGE_KEY);
  if (!data) { showToast('백업할 데이터가 없습니다', 'error'); return; }
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `odd-order-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('데이터 백업 완료');
}
```

- [ ] **Step 2: 데이터 복원 (JSON 업로드)**

```javascript
function restoreData(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      JSON.parse(e.target.result); // 유효성 검사
      saveSnapshot();
      localStorage.setItem(STORAGE_KEY, e.target.result);
      refreshUI();
      showToast('데이터 복원 완료');
    } catch {
      showToast('올바른 백업 파일이 아닙니다', 'error');
    }
  };
  reader.readAsText(file);
}
```

- [ ] **Step 3: 대시보드 하단에 백업/복원 버튼 배치**

- [ ] **Step 4: refreshUI() 통합 함수 구현**

모든 UI를 다시 렌더링하는 통합 함수:
```javascript
function refreshUI() {
  renderRoundBanner();
  renderDashboard();
  // 현재 탭에 따라 필요한 UI 갱신
}
```

- [ ] **Step 5: 엑셀 파일 형식 에러 처리 + 빈 상태 최종 점검**

모든 엑셀 파싱 함수에 try-catch 추가:
```javascript
// parseSmartStoreExcel, parseTrackingExcel 호출부에:
try {
  const rows = await parseSmartStoreExcel(file);
  // ... 처리
} catch (e) {
  showToast('올바른 엑셀 파일을 업로드해주세요', 'error');
}
```

추가 확인:
- 공구 미생성 시 탭 1/2 빈 상태 확인
- 잘못된 엑셀 업로드 시 에러 메시지 확인
- 매핑 실패 행 하이라이트 확인
- 중복 경고 팝업 확인

- [ ] **Step 6: 반응형 CSS 최종 점검**

모바일 화면에서 레이아웃 깨지는 부분 수정. 테이블 가로 스크롤 적용.

- [ ] **Step 7: 커밋**

```bash
git add odd-order/index.html
git commit -m "feat: 데이터 백업/복원, 빈상태, 반응형 마무리"
```

---

## Task 10: Vercel 배포

**Files:**
- Create: `odd-order/vercel.json` (선택)

- [ ] **Step 1: Vercel 배포 설정**

`odd-order` 폴더를 Vercel에 배포. `index.html` 하나만 있으므로 별도 설정 불필요.

```bash
cd rossehan-projects/odd-order
npx vercel --prod
```

또는 GitHub 연동으로 자동 배포.

- [ ] **Step 2: 배포된 URL에서 전체 플로우 테스트**

1. 공구 생성
2. 스마트스토어 엑셀 업로드 → 발주서 다운로드 → Gmail 열기
3. 송장 엑셀 업로드 → 송장 엑셀 다운로드
4. 대시보드 확인 → 검색 → 엑셀 다운로드
5. 데이터 백업/복원

- [ ] **Step 3: 최종 커밋**

```bash
git add .
git commit -m "feat: odd-order 공구 발주서 자동화 웹앱 완성 및 배포"
```
