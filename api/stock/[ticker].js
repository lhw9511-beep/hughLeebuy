const https = require('https');
const yahooFinance = require('yahoo-finance2').default;

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

function getPeriod1FromRange(range) {
    const now = new Date();
    switch(range) {
        case '1mo': now.setMonth(now.getMonth() - 1); break;
        case '3mo': now.setMonth(now.getMonth() - 3); break;
        case '6mo': now.setMonth(now.getMonth() - 6); break;
        case '1y':  now.setFullYear(now.getFullYear() - 1); break;
        case '2y':  now.setFullYear(now.getFullYear() - 2); break;
        case '5y':  now.setFullYear(now.getFullYear() - 5); break;
        case '10y': now.setFullYear(now.getFullYear() - 10); break;
        case 'max': return new Date('1970-01-01');
        default:    now.setFullYear(now.getFullYear() - 1);
    }
    return now;
}

function fetchDirectYahoo(ticker, interval, range, useQuery1 = true) {
    return new Promise((resolve, reject) => {
        const subdomain = useQuery1 ? 'query1' : 'query2';
        const url = `https://${subdomain}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
        const uas = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15'
        ];
        const options = {
            headers: { 'User-Agent': uas[Math.floor(Math.random() * uas.length)], 'Accept': 'application/json' },
            timeout: 8000
        };
        const req = https.get(url, options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        const parsed = JSON.parse(data);
                        if (!parsed.chart?.result?.length) return reject(new Error('empty result'));
                        resolve(parsed);
                    } else reject(new Error(`HTTP ${res.statusCode}`));
                } catch(e) { reject(e); }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
    });
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // URL 직접 파싱: /api/stock/AAPL -> AAPL
    const urlPath = req.url.split('?')[0];  // 쿼리스트링 제거
    const parts = urlPath.split('/');
    const tickerFromUrl = parts[parts.length - 1];

    // req.query.ticker 폴백
    const ticker = (tickerFromUrl || req.query.ticker || '').toUpperCase().trim();
    const interval = req.query.interval || '1d';
    const range = req.query.range || '1y';

    if (!ticker) return res.status(400).json({ error: 'ticker is required' });

    const cacheKey = `${ticker}-${interval}-${range}`;
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    }

    try {
        let result = null;
        try {
            result = await yahooFinance.chart(ticker, { period1: getPeriod1FromRange(range), interval });
        } catch (err1) {
            try {
                const raw = await fetchDirectYahoo(ticker, interval, range, true);
                result = raw.chart.result[0];
            } catch (err2) {
                const raw = await fetchDirectYahoo(ticker, interval, range, false);
                result = raw.chart.result[0];
            }
        }

        let timestamp = [], open = [], high = [], low = [], close = [], volume = [], adjclose = [];

        if (result?.quotes?.length > 0) {
            result.quotes.forEach(q => {
                timestamp.push(Math.floor(new Date(q.date).getTime() / 1000));
                open.push(q.open ?? null);
                high.push(q.high ?? null);
                low.push(q.low ?? null);
                close.push(q.close ?? null);
                volume.push(q.volume ?? null);
                adjclose.push(q.adjclose ?? q.close ?? null);
            });
        } else if (result?.timestamp && result?.indicators?.quote) {
            timestamp = result.timestamp;
            const q = result.indicators.quote[0];
            open = q.open; high = q.high; low = q.low; close = q.close; volume = q.volume;
            adjclose = result.indicators.adjclose?.[0]?.adjclose ?? close;
        } else {
            throw new Error('Data empty or blocked');
        }

        const responseData = {
            chart: { result: [{ meta: result.meta || {}, timestamp, indicators: { quote: [{ open, high, low, close, volume }], adjclose: [{ adjclose }] } }] },
            error: null
        };
        cache.set(cacheKey, { timestamp: Date.now(), data: responseData });
        return res.json(responseData);

    } catch (error) {
        console.error(`[stock/${ticker}] ${error.message}`);
        if (cache.has(cacheKey)) return res.json(cache.get(cacheKey).data);
        return res.status(500).json({ error: 'Chart data load failed', details: error.message });
    }
};
