/**
 * ====================================================
 * 실검증 백테스트 엔진 (Real Verified Backtest Engine)
 * ====================================================
 * 모든 포트폴리오 전략을 Yahoo Finance 실데이터 기반으로 계산합니다.
 * - 배당 반영 수정주가(adjclose) 사용
 * - 연 1회 리밸런싱 (정적 전략)
 * - 월 1회 리밸런싱 (동적 전략)
 * - KRW 환율 실데이터 반영
 * - 매매 수수료 0.1% 반영
 *
 * 전략 목록:
 * 1. 60/40 (SPY 60% + IEF 40%)
 * 2. 영구 포트폴리오 (SPY 25% + TLT 25% + GLD 25% + SGOV 25%)
 * 3. 올웨더 (VTI 30% + TLT 40% + IEF 15% + GLD 7.5% + PDBC 7.5%)
 * 4. 듀얼 모멘텀 (SPY vs EFA vs BIL 12개월 절대모멘텀)
 * 5. VAA (SPY/QQQ/IWM/VEA/VWO/BND/LQD/TLT/HYG/PDBC 모멘텀)
 * 6. DAA (카나리아 방어 + 공격 유니버스)
 * 7. BAA (카나리아 4개 + QQQ 몰빵 or 방어 3선)
 */

'use strict';

// ── 전략별 ETF 티커 정의 ──────────────────────────────────────────────
const BT_TICKERS = {
  '6040':       ['SPY', 'IEF'],
  'permanent':  ['SPY', 'TLT', 'GLD', 'SGOV'],
  'allweather': ['VTI', 'TLT', 'IEF', 'GLD', 'PDBC'],
  'dual':       ['SPY', 'EFA', 'BIL'],
  'vaa':        ['SPY', 'QQQ', 'IWM', 'VEA', 'VWO', 'BND', 'LQD', 'TLT', 'HYG', 'PDBC'],
  'daa':        ['SPY', 'QQQ', 'IWM', 'VEA', 'VWO', 'BND', 'LQD', 'TLT', 'HYG', 'PDBC', 'BIL', 'SGOV'],
  'baa':        ['SPY', 'VEA', 'VWO', 'BND', 'QQQ', 'TIP', 'PDBC', 'SGOV', 'IEF', 'TLT', 'LQD'],
  'krw':        ['KRW=X']
};

const BT_START_DATE = '2000-01-01';
const TRADING_FEE   = 0.001; // 0.1% 매매 수수료

// ── 글로벌 캐시 (이미 fetchStockData 캐시와 별도로 월봉 데이터 저장) ──────
const btMonthlyCache = new Map();

/**
 * 월봉 시계열 데이터를 가져옵니다.
 * adjclose 배당 반영 수정주가를 사용합니다.
 * @param {string} ticker
 * @returns {Promise<{dates: string[], prices: number[]}>}
 */
async function btFetchMonthly(ticker) {
  if (btMonthlyCache.has(ticker)) return btMonthlyCache.get(ticker);

  // fetchStockData는 index.html에 이미 정의되어 있음 (adjclose 지원)
  const raw = await fetchStockData(ticker, '1mo', 'max', 'M');
  const { dates, closes } = extractCleanData(raw);

  // BT_START_DATE 이후 데이터만 사용
  const startIdx = dates.findIndex(d => d >= BT_START_DATE);
  const slicedDates  = startIdx >= 0 ? dates.slice(startIdx)  : dates;
  const slicedPrices = startIdx >= 0 ? closes.slice(startIdx) : closes;

  const result = { dates: slicedDates, prices: slicedPrices };
  btMonthlyCache.set(ticker, result);
  return result;
}

/**
 * 여러 티커를 병렬로 fetch 후 날짜를 정렬·정합합니다.
 * @param {string[]} tickers
 * @returns {Promise<{dates: string[], matrix: Object<string, number[]>}>}
 */
async function btFetchMultiple(tickers) {
  const results = await Promise.all(tickers.map(t => btFetchMonthly(t)));

  // 공통 날짜 집합 계산 (교집합)
  let commonDates = results[0].dates.slice();
  for (let i = 1; i < results.length; i++) {
    const set = new Set(results[i].dates);
    commonDates = commonDates.filter(d => set.has(d));
  }

  // 각 티커 가격을 공통 날짜 기준으로 정렬
  const matrix = {};
  tickers.forEach((t, idx) => {
    const dateMap = new Map(results[idx].dates.map((d, i) => [d, results[idx].prices[i]]));
    matrix[t] = commonDates.map(d => dateMap.get(d));
  });

  return { dates: commonDates, matrix };
}

/**
 * 월간 수익률 배열을 계산합니다.
 * @param {number[]} prices
 * @returns {number[]}
 */
function btMonthlyReturns(prices) {
  const ret = [0];
  for (let i = 1; i < prices.length; i++) {
    ret.push(prices[i] / prices[i - 1] - 1);
  }
  return ret;
}

/**
 * n개월 모멘텀 점수 계산 (BAA/VAA/DAA 공통)
 * 점수 = (1개월×12) + (3개월×4) + (6개월×2) + (12개월×1)
 * @param {number[]} prices - 전체 월별 가격 배열
 * @param {number} idx     - 현재 인덱스
 * @returns {number}
 */
function btMomentumScore(prices, idx) {
  if (idx < 12) return -Infinity;
  const r1  = prices[idx] / prices[idx - 1]  - 1;
  const r3  = prices[idx] / prices[idx - 3]  - 1;
  const r6  = prices[idx] / prices[idx - 6]  - 1;
  const r12 = prices[idx] / prices[idx - 12] - 1;
  return r1 * 12 + r3 * 4 + r6 * 2 + r12;
}

/**
 * 절대 모멘텀 (듀얼 모멘텀용): 12개월 수익률
 * @param {number[]} prices
 * @param {number} idx
 * @returns {number}
 */
function btAbsoluteMomentum12(prices, idx) {
  if (idx < 12) return -Infinity;
  return prices[idx] / prices[idx - 12] - 1;
}

/**
 * NAV 시계열에서 CAGR / MDD 계산
 * @param {number[]} nav
 * @param {string[]} dates - YYYY-MM-DD
 * @returns {{ cagr: number, mdd: number }}
 */
function btCalcStats(nav, dates) {
  const years = (new Date(dates[dates.length - 1]) - new Date(dates[0])) / (1000 * 60 * 60 * 24 * 365.25);
  const cagr = years > 0 ? (Math.pow(nav[nav.length - 1] / nav[0], 1 / years) - 1) * 100 : 0;

  let peak = nav[0], mdd = 0;
  nav.forEach(v => {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak * 100;
    if (dd < mdd) mdd = dd;
  });

  return { cagr: parseFloat(cagr.toFixed(2)), mdd: parseFloat(mdd.toFixed(2)) };
}

/**
 * 연도별 NAV 스냅샷 (백테스트 연도 테이블용)
 * @param {number[]} nav
 * @param {string[]} dates
 * @returns {{ year: string, nav: number, ret: number }[]}
 */
function btYearlySnapshot(nav, dates) {
  const result = [];
  const byYear = new Map();
  dates.forEach((d, i) => {
    const y = d.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, { first: nav[i], last: nav[i] });
    else byYear.get(y).last = nav[i];
  });
  byYear.forEach((v, y) => {
    const prev = result.length > 0 ? result[result.length - 1].nav : v.first;
    result.push({
      year: y,
      nav:  parseFloat(v.last.toFixed(2)),
      ret:  parseFloat(((v.last / prev - 1) * 100).toFixed(2))
    });
  });
  return result;
}

// ────────────────────────────────────────────────────────────────────────
//  1. 정적 전략 공통 엔진
//     weights: { TICKER: 비율 } 예) { SPY: 0.6, IEF: 0.4 }
//     rebalancePeriod: 'annual' | 'monthly'
// ────────────────────────────────────────────────────────────────────────
async function btRunStatic(tickers, weights, rebalancePeriod = 'annual') {
  const { dates, matrix } = await btFetchMultiple(tickers);

  const n = dates.length;
  let nav = [100];
  let holdings = {}; // ticker → 보유 수량
  let lastRebalYear  = -1;
  let lastRebalMonth = -1;

  // 초기 매수 (0번 인덱스)
  let totalInvest = 100;
  tickers.forEach(t => {
    holdings[t] = (totalInvest * weights[t]) / matrix[t][0];
  });

  for (let i = 1; i < n; i++) {
    // 현재 포트폴리오 가치
    let portfolioVal = tickers.reduce((sum, t) => sum + holdings[t] * matrix[t][i], 0);
    nav.push(portfolioVal);

    // 리밸런싱 판단
    const yr  = parseInt(dates[i].slice(0, 4));
    const mo  = parseInt(dates[i].slice(5, 7));
    const shouldRebal = rebalancePeriod === 'monthly'
      ? (mo !== lastRebalMonth)
      : (yr !== lastRebalYear && mo === 1);

    if (shouldRebal) {
      // 매도 후 목표 비중으로 재매수 (수수료 반영)
      const cash = portfolioVal * (1 - TRADING_FEE);
      tickers.forEach(t => {
        holdings[t] = (cash * weights[t]) / matrix[t][i];
      });
      lastRebalYear  = yr;
      lastRebalMonth = mo;
    }
  }

  const stats    = btCalcStats(nav, dates);
  const yearly   = btYearlySnapshot(nav, dates);
  const mar      = stats.mdd !== 0 ? parseFloat((stats.cagr / Math.abs(stats.mdd)).toFixed(2)) : 0;

  return { nav, dates, yearly, ...stats, mar };
}

// ────────────────────────────────────────────────────────────────────────
//  2. 60/40 전략
// ────────────────────────────────────────────────────────────────────────
async function btRun6040() {
  return btRunStatic(['SPY', 'IEF'], { SPY: 0.6, IEF: 0.4 }, 'annual');
}

// ────────────────────────────────────────────────────────────────────────
//  3. 영구 포트폴리오 (25/25/25/25)
//     SPY: 주식, TLT: 장기채, GLD: 금, SGOV: 현금성
// ────────────────────────────────────────────────────────────────────────
async function btRunPermanent() {
  return btRunStatic(
    ['SPY', 'TLT', 'GLD', 'SGOV'],
    { SPY: 0.25, TLT: 0.25, GLD: 0.25, SGOV: 0.25 },
    'annual'
  );
}

// ────────────────────────────────────────────────────────────────────────
//  4. 올웨더 전략 (레이 달리오)
//     VTI 30%, TLT 40%, IEF 15%, GLD 7.5%, PDBC 7.5%
// ────────────────────────────────────────────────────────────────────────
async function btRunAllWeather() {
  return btRunStatic(
    ['VTI', 'TLT', 'IEF', 'GLD', 'PDBC'],
    { VTI: 0.30, TLT: 0.40, IEF: 0.15, GLD: 0.075, PDBC: 0.075 },
    'annual'
  );
}

// ────────────────────────────────────────────────────────────────────────
//  5. 듀얼 모멘텀 (Gary Antonacci)
//     - 절대 모멘텀: SPY 12개월 수익률 > 0이면 리스크온
//     - 상대 모멘텀: SPY vs EFA 중 12개월 수익 높은 것
//     - 리스크오프: BIL (단기채)
// ────────────────────────────────────────────────────────────────────────
async function btRunDualMomentum() {
  const tickers = ['SPY', 'EFA', 'BIL'];
  const { dates, matrix } = await btFetchMultiple(tickers);

  const n = dates.length;
  let nav = [100];
  let currentAsset = 'BIL';
  let shares = 100 / matrix['BIL'][0];

  for (let i = 1; i < n; i++) {
    let portfolioVal = shares * matrix[currentAsset][i];

    // 매월 말 모멘텀 계산 → 다음 달 포지션 결정
    const spyAbs = btAbsoluteMomentum12(matrix['SPY'], i);
    const efaAbs = btAbsoluteMomentum12(matrix['EFA'], i);

    let nextAsset;
    if (spyAbs <= 0 && efaAbs <= 0) {
      nextAsset = 'BIL'; // 둘 다 음수 → 방어
    } else {
      nextAsset = spyAbs >= efaAbs ? 'SPY' : 'EFA'; // 상대 모멘텀
    }

    if (nextAsset !== currentAsset) {
      const cash = portfolioVal * (1 - TRADING_FEE);
      currentAsset = nextAsset;
      shares = cash / matrix[currentAsset][i];
    }

    nav.push(portfolioVal);
  }

  const stats  = btCalcStats(nav, dates);
  const yearly = btYearlySnapshot(nav, dates);
  const mar    = stats.mdd !== 0 ? parseFloat((stats.cagr / Math.abs(stats.mdd)).toFixed(2)) : 0;
  return { nav, dates, yearly, ...stats, mar };
}

// ────────────────────────────────────────────────────────────────────────
//  6. VAA (Vigilant Asset Allocation)
//     공격 유니버스: SPY, QQQ, IWM, VEA, VWO (5개)
//     방어 유니버스: BND, LQD, TLT, HYG, PDBC (5개)
//     규칙: 공격 유니버스 중 모멘텀 점수 < 0인 것이 1개라도 있으면
//           방어 유니버스 중 모멘텀 1위 1개에 100% 투자
//           모두 양수이면 공격 유니버스 중 모멘텀 1위 1개에 100% 투자
// ────────────────────────────────────────────────────────────────────────
async function btRunVAA() {
  const offensive = ['SPY', 'QQQ', 'IWM', 'VEA', 'VWO'];
  const defensive = ['BND', 'LQD', 'TLT', 'HYG', 'PDBC'];
  const allTickers = [...offensive, ...defensive];

  const { dates, matrix } = await btFetchMultiple(allTickers);
  const n = dates.length;

  let nav = [100];
  let currentAsset = 'BND';
  let shares = 100 / matrix['BND'][0];

  for (let i = 1; i < n; i++) {
    let portfolioVal = shares * matrix[currentAsset][i];

    if (i >= 12) {
      // 공격 유니버스 모멘텀 점수
      const offScores = offensive.map(t => ({ t, score: btMomentumScore(matrix[t], i) }));
      const hasNegative = offScores.some(x => x.score <= 0);

      let nextAsset;
      if (hasNegative) {
        // 방어 모드: 방어 유니버스 중 1위
        const defScores = defensive.map(t => ({ t, score: btMomentumScore(matrix[t], i) }));
        defScores.sort((a, b) => b.score - a.score);
        nextAsset = defScores[0].t;
      } else {
        // 공격 모드: 공격 유니버스 중 1위
        offScores.sort((a, b) => b.score - a.score);
        nextAsset = offScores[0].t;
      }

      if (nextAsset !== currentAsset) {
        const cash = portfolioVal * (1 - TRADING_FEE);
        currentAsset = nextAsset;
        shares = cash / matrix[currentAsset][i];
      }
    }

    nav.push(portfolioVal);
  }

  const stats  = btCalcStats(nav, dates);
  const yearly = btYearlySnapshot(nav, dates);
  const mar    = stats.mdd !== 0 ? parseFloat((stats.cagr / Math.abs(stats.mdd)).toFixed(2)) : 0;
  return { nav, dates, yearly, ...stats, mar };
}

// ────────────────────────────────────────────────────────────────────────
//  7. DAA (Defensive Asset Allocation)
//     카나리아: SPY, VWO, VEA, BND (4개)
//     공격 유니버스: SPY, QQQ, IWM, VEA, VWO (5개)
//     방어 유니버스: TLT, LQD, BND, BIL, SGOV (현금 포함)
//     규칙:
//       - 카나리아 4개 모두 모멘텀 > 0 → 공격 유니버스 1위 1개 100%
//       - 카나리아 1~2개 음수 → 공격 50% + 방어 50%
//       - 카나리아 3~4개 음수 → 방어 유니버스 1위 100%
// ────────────────────────────────────────────────────────────────────────
async function btRunDAA() {
  const canaries  = ['SPY', 'VWO', 'VEA', 'BND'];
  const offensive = ['SPY', 'QQQ', 'IWM', 'VEA', 'VWO'];
  const defensive = ['TLT', 'LQD', 'BND', 'BIL', 'SGOV'];
  const allTickers = [...new Set([...canaries, ...offensive, ...defensive])];

  const { dates, matrix } = await btFetchMultiple(allTickers);
  const n = dates.length;

  let nav = [100];
  let holdings = { 'BND': 100 / matrix['BND'][0] };
  let currentAlloc = { 'BND': 1.0 };

  for (let i = 1; i < n; i++) {
    let portfolioVal = Object.entries(holdings)
      .reduce((sum, [t, sh]) => sum + sh * matrix[t][i], 0);

    if (i >= 12) {
      const negCount = canaries.filter(t => btMomentumScore(matrix[t], i) <= 0).length;

      const offScores = offensive.map(t => ({ t, score: btMomentumScore(matrix[t], i) })).sort((a, b) => b.score - a.score);
      const defScores = defensive.map(t => ({ t, score: btMomentumScore(matrix[t], i) })).sort((a, b) => b.score - a.score);

      let newAlloc = {};
      if (negCount === 0) {
        // 완전 공격
        newAlloc[offScores[0].t] = 1.0;
      } else if (negCount <= 2) {
        // 반반
        newAlloc[offScores[0].t] = 0.5;
        const defT = defScores[0].t;
        newAlloc[defT] = (newAlloc[defT] || 0) + 0.5;
      } else {
        // 완전 방어
        newAlloc[defScores[0].t] = 1.0;
      }

      // 리밸런싱 필요 여부
      const changed = JSON.stringify(newAlloc) !== JSON.stringify(currentAlloc);
      if (changed) {
        const cash = portfolioVal * (1 - TRADING_FEE);
        holdings = {};
        Object.entries(newAlloc).forEach(([t, w]) => {
          holdings[t] = (cash * w) / matrix[t][i];
        });
        currentAlloc = newAlloc;
      }
    }

    nav.push(portfolioVal);
  }

  const stats  = btCalcStats(nav, dates);
  const yearly = btYearlySnapshot(nav, dates);
  const mar    = stats.mdd !== 0 ? parseFloat((stats.cagr / Math.abs(stats.mdd)).toFixed(2)) : 0;
  return { nav, dates, yearly, ...stats, mar };
}

// ────────────────────────────────────────────────────────────────────────
//  8. BAA (Bold Asset Allocation) — Keller & Keuning 2022
//     카나리아: SPY, VEA, VWO, BND
//     공격 자산: QQQ (100% 몰빵)
//     방어 유니버스: TIP, PDBC, SGOV, IEF, TLT, LQD, BND
//     규칙: 카나리아 4개 모두 > 0 → QQQ 100%
//           1개라도 ≤ 0 → 방어 유니버스 모멘텀 1~3위를 33.3%씩
// ────────────────────────────────────────────────────────────────────────
async function btRunBAA() {
  const canaries  = ['SPY', 'VEA', 'VWO', 'BND'];
  const offense   = 'QQQ';
  const defensive = ['TIP', 'PDBC', 'SGOV', 'IEF', 'TLT', 'LQD', 'BND'];
  const allTickers = [...new Set([...canaries, offense, ...defensive])];

  const { dates, matrix } = await btFetchMultiple(allTickers);
  const n = dates.length;

  let nav = [100];
  let holdings = { 'BND': 100 / matrix['BND'][0] };
  let currentAllocKey = 'DEF:BND';

  for (let i = 1; i < n; i++) {
    let portfolioVal = Object.entries(holdings)
      .reduce((sum, [t, sh]) => sum + sh * matrix[t][i], 0);

    if (i >= 12) {
      const allPositive = canaries.every(t => btMomentumScore(matrix[t], i) > 0);

      let newAlloc = {};
      if (allPositive) {
        newAlloc[offense] = 1.0;
      } else {
        const defScores = defensive
          .map(t => ({ t, score: btMomentumScore(matrix[t], i) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        defScores.forEach(({ t }) => {
          newAlloc[t] = (newAlloc[t] || 0) + 1 / 3;
        });
      }

      const allocKey = Object.entries(newAlloc).sort().map(([t, w]) => `${t}:${w.toFixed(4)}`).join(',');
      if (allocKey !== currentAllocKey) {
        const cash = portfolioVal * (1 - TRADING_FEE);
        holdings = {};
        Object.entries(newAlloc).forEach(([t, w]) => {
          holdings[t] = (cash * w) / matrix[t][i];
        });
        currentAllocKey = allocKey;
      }
    }

    nav.push(portfolioVal);
  }

  const stats  = btCalcStats(nav, dates);
  const yearly = btYearlySnapshot(nav, dates);
  const mar    = stats.mdd !== 0 ? parseFloat((stats.cagr / Math.abs(stats.mdd)).toFixed(2)) : 0;
  return { nav, dates, yearly, ...stats, mar };
}

// ────────────────────────────────────────────────────────────────────────
//  9. KRW 환율 반영 NAV 변환
//     nav(USD) × KRW/USD 환율 → nav(KRW)
// ────────────────────────────────────────────────────────────────────────
async function btApplyKrw(navUSD, dates) {
  const krw = await btFetchMonthly('KRW=X');
  const krwMap = new Map(krw.dates.map((d, i) => [d, krw.prices[i]]));

  return dates.map((d, i) => {
    // 가장 가까운 환율 사용 (없으면 1350 기본값)
    const rate = krwMap.get(d) || currentExchangeRate || 1350;
    return navUSD[i] * rate / (krwMap.get(dates[0]) || rate);
  });
}

// ────────────────────────────────────────────────────────────────────────
//  10. 메인 진입점 — 모든 전략 실행 후 index.html의 UI 갱신
// ────────────────────────────────────────────────────────────────────────

/**
 * 백테스트 결과를 index.html 카드 UI에 반영합니다.
 * @param {string} key - pfDetails 키 (예: '6040')
 * @param {{ cagr, mdd, mar, nav, dates, yearly }} result
 */
function btUpdateCard(key, result) {
  const cagrEl = document.getElementById(`card-cagr-${key}`);
  const mddEl  = document.getElementById(`card-mdd-${key}`);
  const marEl  = document.getElementById(`card-mar-${key}`);

  if (cagrEl) cagrEl.textContent = `${result.cagr > 0 ? '+' : ''}${result.cagr}%`;
  if (mddEl)  mddEl.textContent  = `${result.mdd}%`;
  if (marEl)  marEl.textContent  = `가성비 ${result.mar}`;

  // ※ 표시 제거 — 실검증 완료
  const cards = document.querySelectorAll(`.pf-card`);
  cards.forEach(card => {
    if (card.getAttribute('onclick') === `showPfDetail('${key}')`) {
      const badge = card.querySelector('.text-rose-400');
      if (badge) badge.textContent = '✅ 실검증 백테스트';
    }
  });

  // pfDetails에 실데이터 저장 (showPfDetail 모달에서 사용)
  if (window.pfDetails && window.pfDetails[key]) {
    window.pfDetails[key]._btResult = result;
  }

  // 포트폴리오 차트 데이터도 갱신 (pfSimData 대체)
  if (window.pfSimData) {
    // dates → 연도 배열, nav → Base 100 배열로 변환
    window.pfSimData[key] = result.nav;
    window.pfSimYears = result.dates.map(d => d.slice(0, 4)).filter((v, i, a) => a.indexOf(v) === i);
  }
}

/**
 * 모든 전략 백테스트를 순차적으로 실행합니다.
 * 로딩 시간을 최소화하기 위해 순차 실행 (API rate limit 방어)
 */
async function btRunAll() {
  console.log('[백테스트 엔진] 전략 계산 시작...');

  const strategies = [
    { key: '6040',       fn: btRun6040       },
    { key: 'permanent',  fn: btRunPermanent  },
    { key: 'allweather', fn: btRunAllWeather },
    { key: 'dual',       fn: btRunDualMomentum },
    { key: 'vaa',        fn: btRunVAA        },
    { key: 'daa',        fn: btRunDAA        },
    { key: 'baa',        fn: btRunBAA        }
  ];

  for (const { key, fn } of strategies) {
    try {
      console.log(`[백테스트] ${key} 계산 중...`);
      const result = await fn();
      btUpdateCard(key, result);
      console.log(`[백테스트] ${key} 완료 — CAGR: ${result.cagr}%, MDD: ${result.mdd}%, MAR: ${result.mar}`);
    } catch (e) {
      console.error(`[백테스트] ${key} 실패:`, e.message);
    }
    // API 호출 간격 (rate limit 방어)
    await new Promise(r => setTimeout(r, 400));
  }

  console.log('[백테스트 엔진] 전체 완료 ✅');

  // 포트폴리오 전체 차트 갱신
  if (typeof renderPortfolioChart === 'function') {
    renderPortfolioChart();
  }
}

/**
 * showPfDetail 모달에서 실검증 연도별 테이블을 렌더링합니다.
 * index.html의 showPfDetail 함수에서 호출합니다.
 * @param {string} key
 */
function btRenderHistoricalTable(key) {
  const tbody = document.getElementById('pf-historical-tbody');
  if (!tbody) return;
  const result = window.pfDetails?.[key]?._btResult;
  if (!result) { tbody.innerHTML = '<tr><td colspan="3" class="text-center text-themeMuted py-4 text-xs">백테스트 데이터 로딩 중...</td></tr>'; return; }

  tbody.innerHTML = result.yearly.map(row => `
    <tr>
      <td>${row.year}</td>
      <td class="text-right font-mono">${row.nav.toFixed(1)}</td>
      <td class="text-right font-mono ${row.ret >= 0 ? 'text-up' : 'text-down'}">
        ${row.ret >= 0 ? '+' : ''}${row.ret.toFixed(1)}%
      </td>
    </tr>
  `).join('');
}

// ────────────────────────────────────────────────────────────────────────
//  초기화: 포트폴리오 탭 활성화 시 자동 실행
// ────────────────────────────────────────────────────────────────────────
(function initBacktestEngine() {
  // switchMainTab('portfolio') 호출 시 한 번만 실행
  let btExecuted = false;

  const origSwitchMainTab = window.switchMainTab;
  window.switchMainTab = function(tab) {
    if (origSwitchMainTab) origSwitchMainTab(tab);
    if ((tab === 'portfolio' || tab === 'baa') && !btExecuted) {
      btExecuted = true;
      // 약간의 딜레이 후 실행 (DOM 렌더링 완료 대기)
      setTimeout(btRunAll, 500);
    }
  };

  // showPfDetail 오버라이드: 모달 열 때 실검증 테이블 렌더링
  const origShowPfDetail = window.showPfDetail;
  window.showPfDetail = function(key) {
    if (origShowPfDetail) origShowPfDetail(key);
    setTimeout(() => btRenderHistoricalTable(key), 200);
  };

  console.log('[백테스트 엔진] 초기화 완료 — 포트폴리오 탭 클릭 시 자동 실행됩니다.');
})();
