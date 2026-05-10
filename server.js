const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const yahooFinance = require('yahoo-finance2').default;

const app = express();
// Render는 자동으로 PORT 환경변수를 주입합니다.
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname)));

const cache = new Map();
const pendingRequests = new Map();
const CACHE_TTL = 10 * 60 * 1000; 

// 캐시 청소 인터벌
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
        if (now - value.timestamp >= CACHE_TTL) {
            cache.delete(key);
        }
    }
}, 60 * 1000);

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

function fetchDirectYahoo(ticker, interval, range, useQuery1 = true) {
    return new Promise((resolve, reject) => {
        const subdomain = useQuery1 ? 'query1' : 'query2';
        const url = `https://${subdomain}.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;

        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            },
            timeout: 10000 // 10초 타임아웃
        };

        const req = https.get(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(JSON.parse(data));
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}`));
                    }
                } catch (e) {
                    reject(new Error('JSON Parse Error'));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request Timeout'));
        });

        req.on('error', (err) => {
            reject(err);
        });
    });
}

app.get('/api/stock/:ticker', async (req, res) => {
    const { ticker } = req.params;
    const { interval = '1d', range = '1y' } = req.query;
    const cacheKey = `${ticker}-${interval}-${range}`;

    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    }

    if (pendingRequests.has(cacheKey)) {
        try { return res.json(await pendingRequests.get(cacheKey)); } 
        catch (error) { return res.status(500).json({ error: "Processing Error" }); }
    }

    const fetchPromise = (async () => {
        let result = null;
        try {
            const period1 = getPeriod1FromRange(range);
            result = await yahooFinance.chart(ticker, { period1: period1, interval: interval });
        } catch (err) {
            try {
                const raw = await fetchDirectYahoo(ticker, interval, range, true);
                result = raw.chart.result[0];
            } catch (err2) {
                const raw = await fetchDirectYahoo(ticker, interval, range, false);
                result = raw.chart.result[0];
            }
        }

        if (!result) throw new Error("Data retrieval failed");

        let timestamp = [], open =[], high = [], low = [], close = [], volume = [], adjclose =[];

        if (result.quotes && result.quotes.length > 0) {
            result.quotes.forEach(q => {
                timestamp.push(Math.floor(new Date(q.date).getTime() / 1000));
                open.push(q.open ?? null);
                high.push(q.high ?? null);
                low.push(q.low ?? null);
                close.push(q.close ?? null);
                volume.push(q.volume ?? null);
                adjclose.push(q.adjclose ?? (q.close ?? null));
            });
        } 
        else if (result.timestamp && result.indicators?.quote) {
            timestamp = result.timestamp;
            const q = result.indicators.quote[0];
            open = q.open; high = q.high; low = q.low; close = q.close; volume = q.volume;
            adjclose = result.indicators.adjclose?.[0]?.adjclose || close;
        } 

        return {
            chart: { 
                result:[{ 
                    meta: result.meta || {}, 
                    timestamp, 
                    indicators: { 
                        quote: [{ open, high, low, close, volume }],
                        adjclose: [{ adjclose }] 
                    } 
                }] 
            }, 
            error: null 
        };
    })();

    pendingRequests.set(cacheKey, fetchPromise);

    try {
        const responseData = await fetchPromise;
        cache.set(cacheKey, { timestamp: Date.now(), data: responseData });
        pendingRequests.delete(cacheKey);
        res.json(responseData);
    } catch (error) {
        pendingRequests.delete(cacheKey);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/fundamentals/:ticker', async (req, res) => {
    const { ticker } = req.params;
    try {
        const summary = await yahooFinance.quoteSummary(ticker, {
            modules:['defaultKeyStatistics', 'summaryDetail', 'assetProfile', 'fundProfile', 'topHoldings']
        });
        res.json({ quoteSummary: { result: [summary], error: null } });
    } catch (error) {
        res.json({ quoteSummary: { result: [null], error: "Limited" } });
    }
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// 0.0.0.0으로 바인딩하여 Render 외부 접속 허용
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is running on port ${PORT}`);
});
