const express = require('express');
const cors = require('cors');
const path = require('path');
const yahooFinance = require('yahoo-finance2').default;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname)));

// 프론트엔드의 문자열 range('1y', 'max' 등)를 yahoo-finance2가 인식할 수 있는 Date 객체로 변환하는 헬퍼 함수
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

// 1. 주가 및 코인 데이터 API
app.get('/api/stock/:ticker', async (req, res) => {
    const { ticker } = req.params;
    const { interval = '1d', range = '1y' } = req.query;
    
    try {
        const period1 = getPeriod1FromRange(range);
        const queryOptions = { period1: period1, interval: interval };
        
        // yahoo-finance2 라이브러리를 통해 과거 차트 데이터 안전하게 호출
        const result = await yahooFinance.chart(ticker, queryOptions);
        
        // 프론트엔드의 extractCleanData() 함수가 처리할 수 있도록
        // 기존 야후 파이낸스 원본 Raw JSON 구조로 변환하여 응답
        const timestamp = [];
        const open = [];
        const high = [];
        const low = [];
        const close = [];
        const volume = [];

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

        const formattedResponse = {
            chart: {
                result: [{
                    meta: result.meta || {},
                    timestamp: timestamp,
                    indicators: {
                        quote: [{
                            open: open,
                            high: high,
                            low: low,
                            close: close,
                            volume: volume
                        }]
                    }
                }],
                error: null
            }
        };
        
        res.json(formattedResponse);
    } catch (error) {
        console.error(`[API Error] ${ticker}:`, error.message);
        res.status(500).json({ error: "Chart data load failed", details: error.message });
    }
});

// 2. 펀더멘털 데이터 API
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
