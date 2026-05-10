const express = require('express');
const cors = require('cors');
const path = require('path');
const yahooFinance = require('yahoo-finance2').default;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname)));

// ✅ 1. 인메모리 캐시 및 중복 요청 방지(Deduplication) 설정
const cache = new Map();
const pendingRequests = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5분 유지 (트래픽 대폭 감소)

function getPeriod1FromRange(range) {
    const now = new Date();
    switch(range) {
        case '1mo': now.setMonth(now.getMonth() - 1); break;
        case '3mo': now.setMonth(now.getMonth() - 3); break;
        case '6mo': now.setMonth(now.getMonth() - 6); break;
        case '1y': now.setFullYear(now.getFullYear() - 1); break;
        case '2y': now.setFullYear(now.getFullYear() - 2); break;
        case '5y': now.setFullYear(now.getFullYear() - 5); break;
        case '10y': now.setFullYear(now.getFullYear() - 10); break;
        case 'max': return new Date('1970-01-01');
        default: now.setFullYear(now.getFullYear() - 1);
    }
    return now;
}

app.get('/api/stock/:ticker', async (req, res) => {
    const { ticker } = req.params;
    const { interval = '1d', range = '1y' } = req.query;
    
    const cacheKey = `${ticker}-${interval}-${range}`;

    // ✅ 2. 유효한 캐시가 있다면 즉시 반환 (API 호출 안 함)
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) {
            return res.json(cached.data);
        }
    }

    // ✅ 3. 이미 동일한 요청이 진행 중이면, 해당 Promise를 기다렸다가 결과만 공유받음 (동시 호출 방지)
    if (pendingRequests.has(cacheKey)) {
        try {
            const responseData = await pendingRequests.get(cacheKey);
            return res.json(responseData);
        } catch (error) {
            return res.status(500).json({ error: "Chart data load failed", details: error.message });
        }
    }

    // ✅ 4. 실제 API 호출을 Promise로 감싸서 pendingRequests에 등록
    const fetchPromise = (async () => {
        const period1 = getPeriod1FromRange(range);
        const result = await yahooFinance.chart(ticker, { period1: period1, interval: interval });
        
        const timestamp = [];
        const open = []; const high = []; const low = []; const close = []; const volume = [];

        if (result && result.quotes && result.quotes.length > 0) {
            result.quotes.forEach(q => {
                timestamp.push(Math.floor(new Date(q.date).getTime() / 1000));
                open.push(q.open !== undefined ? q.open : null);
                high.push(q.high !== undefined ? q.high : null);
                low.push(q.low !== undefined ? q.low : null);
                close.push(q.close !== undefined ? q.close : null);
                volume.push(q.volume !== undefined ? q.volume : null);
            });
        }

        return {
            chart: {
                result: [{
                    meta: result.meta || {},
                    timestamp: timestamp,
                    indicators: { quote: [{ open, high, low, close, volume }] }
                }],
                error: null
            }
        };
    })();

    pendingRequests.set(cacheKey, fetchPromise);

    try {
        const responseData = await fetchPromise;
        // 성공 시 캐시에 저장하고 대기열에서 삭제
        cache.set(cacheKey, { timestamp: Date.now(), data: responseData });
        pendingRequests.delete(cacheKey);
        res.json(responseData);
    } catch (error) {
        console.error(`[API Error] ${ticker}:`, error.message);
        pendingRequests.delete(cacheKey);
        
        // ✅ 5. 에러 발생 시 서비스 다운을 막기 위해 만료된 캐시라도 있다면 반환 (Fallback)
        if (cache.has(cacheKey)) {
            console.log(`[Cache Fallback] ${ticker} 임시 데이터 반환`);
            return res.json(cache.get(cacheKey).data);
        }
        res.status(500).json({ error: "Chart data load failed", details: error.message });
    }
});

app.get('/api/fundamentals/:ticker', async (req, res) => {
    const { ticker } = req.params;
    try {
        const summary = await yahooFinance.quoteSummary(ticker, {
            modules: ['defaultKeyStatistics', 'summaryDetail', 'assetProfile', 'fundProfile', 'topHoldings']
        });
        res.json({ quoteSummary: { result: [summary], error: null } });
    } catch (error) {
        res.json({ quoteSummary: { result: [null], error: "Limited" } });
    }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

app.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
});
