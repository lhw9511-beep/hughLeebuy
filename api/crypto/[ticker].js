const https = require('https');

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5분 캐시 (코인은 자주 변동)

function fetchBinance(symbol, interval, limit) {
    return new Promise((resolve, reject) => {
        // BTC-USD → BTCUSDT 변환
        const binanceSymbol = symbol
            .replace('-USD', 'USDT')
            .replace('-USDT', 'USDT')
            .toUpperCase();

        const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`;

        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json'
            },
            timeout: 12000
        };

        const req = https.get(url, options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        const parsed = JSON.parse(data);
                        if (!Array.isArray(parsed) || parsed.length === 0)
                            return reject(new Error('empty result'));
                        resolve({ symbol: binanceSymbol, klines: parsed });
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
                    }
                } catch (e) { reject(e); }
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
    });
}

// interval + range → binance interval + limit 변환
function toBindanceParams(interval, range) {
    const map = {
        '1d':  { bi: '1d',  limit: 365 },
        '1wk': { bi: '1w',  limit: 104 },
        '1mo': { bi: '1M',  limit: 120 },
        '1y':  { bi: '1M',  limit: 120 },
    };
    const rangeLimit = {
        '1y':   { '1d': 365,  '1wk': 52,  '1mo': 12,  '1y': 12 },
        '2y':   { '1d': 730,  '1wk': 104, '1mo': 24,  '1y': 24 },
        '5y':   { '1d': 500,  '1wk': 260, '1mo': 60,  '1y': 60 },
        'max':  { '1d': 500,  '1wk': 500, '1mo': 500, '1y': 500 },
    };
    const base = map[interval] || { bi: '1d', limit: 365 };
    const limit = (rangeLimit[range] || {})[interval] || base.limit;
    return { bi: base.bi, limit: Math.min(limit, 1000) };
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const urlPath = req.url.split('?')[0];
    const parts = urlPath.split('/');
    let tickerFromUrl = '';
    try { tickerFromUrl = decodeURIComponent(parts[parts.length - 1]); }
    catch (e) { tickerFromUrl = parts[parts.length - 1]; }

    const ticker = (tickerFromUrl || req.query.ticker || '').toUpperCase().trim();
    const interval = req.query.interval || '1d';
    const range = req.query.range || '1y';

    if (!ticker) return res.status(400).json({ error: 'ticker is required' });

    const cacheKey = `${ticker}-${interval}-${range}`;
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL)
            return res.json(cached.data);
    }

    try {
        const { bi, limit } = toBindanceParams(interval, range);
        const { symbol, klines } = await fetchBinance(ticker, bi, limit);

        // Binance kline 포맷 → Yahoo Finance 포맷과 동일하게 변환
        // kline: [openTime, open, high, low, close, volume, closeTime, ...]
        const timestamps = [];
        const opens = [], highs = [], lows = [], closes = [], volumes = [];

        for (const k of klines) {
            timestamps.push(Math.floor(Number(k[0]) / 1000));
            opens.push(parseFloat(k[1]));
            highs.push(parseFloat(k[2]));
            lows.push(parseFloat(k[3]));
            closes.push(parseFloat(k[4]));
            volumes.push(parseFloat(k[5]));
        }

        const responseData = {
            chart: {
                result: [{
                    meta: {
                        symbol,
                        currency: 'USD',
                        regularMarketPrice: closes[closes.length - 1],
                        previousClose: closes[closes.length - 2] || closes[closes.length - 1],
                    },
                    timestamp: timestamps,
                    indicators: {
                        quote: [{ open: opens, high: highs, low: lows, close: closes, volume: volumes }],
                        adjclose: [{ adjclose: closes }]
                    }
                }]
            },
            error: null
        };

        cache.set(cacheKey, { timestamp: Date.now(), data: responseData });
        return res.json(responseData);

    } catch (error) {
        console.error(`[crypto/${ticker}] ${error.message}`);
        if (cache.has(cacheKey)) return res.json(cache.get(cacheKey).data);
        return res.status(500).json({ error: 'Crypto data load failed', details: error.message });
    }
};
