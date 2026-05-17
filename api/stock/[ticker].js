const https = require('https');
const yahooFinance = require('yahoo-finance2').default;

// 메모리 캐시 (Serverless는 인스턴스 재사용 시 유효)
const cache = new Map();
const pendingRequests = new Map();
const CACHE_TTL = 60 * 60 * 1000;

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
        const uas = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'
        ];
        const options = {
            headers: {
                'User-Agent': uas[Math.floor(Math.random() * uas.length)],
                'Accept': 'application/json',
                'Connection': 'keep-alive'
            },
            timeout: 10000
        };
        const req = https.get(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        const parsed = JSON.parse(data);
                        if (!parsed.chart || !parsed.chart.result || parsed.chart.result.length === 0) {
                            return reject(new Error(`Direct fetch: empty result for ${ticker}`));
                        }
                        resolve(parsed);
                    } else {
                        reject(new Error(`Direct fetch HTTP ${res.statusCode}`));
                    }
                } catch (e) {
                    reject(new Error('JSON Parse Error during Direct Fetch'));
                }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('Direct fetch timeout')); });
        req.on('error', (err) => { reject(err); });
    });
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { ticker } = req.query;
    const { interval = '1d', range = '1y' } = req.query;
    const cacheKey = `${ticker}-${interval}-${range}`;

    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    }

    if (pendingRequests.has(cacheKey)) {
        try { return res.json(await pendingRequests.get(cacheKey)); }
        catch (error) { return res.status(500).json({ error: 'Failed', details: error.message }); }
    }

    const fetchPromise = (async () => {
        let result = null;
        try {
            const period1 = getPeriod1FromRange(range);
            result = await yahooFinance.chart(ticker, { period1, interval });
        } catch (err1) {
            try {
                const raw = await fetchDirectYahoo(ticker, interval, range, true);
                result = raw.chart.result[0];
            } catch (err2) {
                console.warn(`[Fallback] query1 failed: ${err2.message}`);
                const raw = await fetchDirectYahoo(ticker, interval, range, false);
                result = raw.chart.result[0];
            }
        }

        let timestamp = [], open = [], high = [], low = [], close = [], volume = [], adjclose = [];

        if (result && result.quotes && result.quotes.length > 0) {
            result.quotes.forEach(q => {
                timestamp.push(Math.floor(new Date(q.date).getTime() / 1000));
                open.push(q.open !== undefined ? q.open : null);
                high.push(q.high !== undefined ? q.high : null);
                low.push(q.low !== undefined ? q.low : null);
                close.push(q.close !== undefined ? q.close : null);
                volume.push(q.volume !== undefined ? q.volume : null);
                adjclose.push(q.adjclose !== undefined ? q.adjclose : (q.close !== undefined ? q.close : null));
            });
        } else if (result && result.timestamp && result.indicators && result.indicators.quote) {
            timestamp = result.timestamp;
            const q = result.indicators.quote[0];
            open = q.open; high = q.high; low = q.low; close = q.close; volume = q.volume;
            adjclose = (result.indicators.adjclose && result.indicators.adjclose[0])
                ? result.indicators.adjclose[0].adjclose
                : close;
        } else {
            throw new Error('Data empty or blocked');
        }

        return {
            chart: {
                result: [{ meta: result.meta || {}, timestamp, indicators: { quote: [{ open, high, low, close, volume }], adjclose: [{ adjclose }] } }]
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
        if (cache.has(cacheKey)) return res.json(cache.get(cacheKey).data);
        res.status(500).json({ error: 'Chart data load failed', details: error.message });
    }
};
