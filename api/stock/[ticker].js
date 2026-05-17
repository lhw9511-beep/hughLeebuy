const https = require('https');

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

function httpsGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const opts = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                ...headers
            },
            timeout: 15000
        };
        const req = https.get(url, opts, (res) => {
            // follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve({ data, headers: res.headers, status: res.statusCode });
                else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
            });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
    });
}

function getPeriod1FromRange(range) {
    const now = new Date();
    switch (range) {
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

// ── 방법 1: Yahoo Finance v8 (crumb + cookie 인증) ──────────────────────────
async function fetchYahooCrumb() {
    const { data, headers } = await httpsGet('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        'Cookie': 'A=o; B=o; GUC=AQE'
    });
    // 쿠키 추출
    const setCookie = Array.isArray(headers['set-cookie']) ? headers['set-cookie'].join(';') : (headers['set-cookie'] || '');
    const crumb = data.trim();
    return { crumb, cookie: setCookie };
}

async function fetchYahooWithCrumb(ticker, interval, range) {
    const { crumb, cookie } = await fetchYahooCrumb();
    const p1 = Math.floor(getPeriod1FromRange(range).getTime() / 1000);
    const p2 = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&period1=${p1}&period2=${p2}&crumb=${encodeURIComponent(crumb)}`;
    const { data } = await httpsGet(url, { 'Cookie': cookie });
    const parsed = JSON.parse(data);
    if (!parsed.chart?.result?.length) throw new Error('empty result');
    return parsed.chart.result[0];
}

// ── 방법 2: Yahoo Finance v8 직접 (crumb 없이) ─────────────────────────────
async function fetchYahooDirect(ticker, interval, range, subdomain = 'query1') {
    const url = `https://${subdomain}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
    const { data } = await httpsGet(url);
    const parsed = JSON.parse(data);
    if (!parsed.chart?.result?.length) throw new Error('empty result');
    return parsed.chart.result[0];
}

// ── 방법 3: Stooq (무료, 블록 없음) ────────────────────────────────────────
function intervalToStooq(interval, range) {
    // stooq interval: d=일봉, w=주봉, m=월봉, q=분기, y=연봉
    const imap = { '1d': 'd', '1wk': 'w', '1mo': 'm', '1y': 'y' };
    return imap[interval] || 'd';
}

async function fetchStooq(ticker, interval, range) {
    // ^VIX → %5EVIX, SPY → SPY.US
    let sym = ticker.startsWith('^') ? ticker.slice(1) : ticker;
    // stooq는 미국 주식에 .US 붙임. ^로 시작하는 지수는 그대로
    if (!ticker.startsWith('^') && !sym.includes('.')) sym = sym + '.US';
    const i = intervalToStooq(interval, range);
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym.toLowerCase())}&i=${i}`;
    const { data } = await httpsGet(url);
    // CSV 파싱: Date,Open,High,Low,Close,Volume
    const lines = data.trim().split('\n').filter(l => l && !l.startsWith('Date'));
    if (lines.length < 5) throw new Error('stooq insufficient data');
    const timestamps = [], opens = [], highs = [], lows = [], closes = [], volumes = [];
    for (const line of lines) {
        const cols = line.split(',');
        if (cols.length < 5) continue;
        const ts = Math.floor(new Date(cols[0]).getTime() / 1000);
        if (isNaN(ts)) continue;
        timestamps.push(ts);
        opens.push(parseFloat(cols[1]) || null);
        highs.push(parseFloat(cols[2]) || null);
        lows.push(parseFloat(cols[3]) || null);
        closes.push(parseFloat(cols[4]) || null);
        volumes.push(parseFloat(cols[5]) || 0);
    }
    if (closes.length < 5) throw new Error('stooq parse failed');
    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2] || lastClose;
    return {
        meta: { symbol: ticker, currency: 'USD', regularMarketPrice: lastClose, previousClose: prevClose },
        timestamp: timestamps,
        indicators: {
            quote: [{ open: opens, high: highs, low: lows, close: closes, volume: volumes }],
            adjclose: [{ adjclose: closes }]
        }
    };
}

// ── 방법 4: Yahoo Finance v7 (구버전) ──────────────────────────────────────
async function fetchYahooV7(ticker, interval, range) {
    const url = `https://query2.finance.yahoo.com/v7/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`;
    const { data } = await httpsGet(url, {
        'Referer': 'https://finance.yahoo.com',
        'Origin': 'https://finance.yahoo.com'
    });
    const parsed = JSON.parse(data);
    if (!parsed.chart?.result?.length) throw new Error('empty result v7');
    return parsed.chart.result[0];
}

// ── 결과 정규화 ─────────────────────────────────────────────────────────────
function buildResponse(result) {
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
        throw new Error('Data empty or unrecognized format');
    }
    return {
        chart: {
            result: [{
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
        if (Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);
    }

    const attempts = [
        { name: 'yahoo-crumb',   fn: () => fetchYahooWithCrumb(ticker, interval, range) },
        { name: 'yahoo-direct',  fn: () => fetchYahooDirect(ticker, interval, range, 'query1') },
        { name: 'yahoo-query2',  fn: () => fetchYahooDirect(ticker, interval, range, 'query2') },
        { name: 'stooq',         fn: () => fetchStooq(ticker, interval, range) },
        { name: 'yahoo-v7',      fn: () => fetchYahooV7(ticker, interval, range) },
    ];

    let lastErr = null;
    for (const { name, fn } of attempts) {
        try {
            const result = await fn();
            const responseData = buildResponse(result);
            cache.set(cacheKey, { timestamp: Date.now(), data: responseData });
            console.log(`[stock/${ticker}] success via ${name}`);
            return res.json(responseData);
        } catch (err) {
            console.warn(`[stock/${ticker}] ${name} failed: ${err.message}`);
            lastErr = err;
        }
    }

    // 모든 시도 실패 → 오래된 캐시라도 반환
    if (cache.has(cacheKey)) {
        console.warn(`[stock/${ticker}] all failed, returning stale cache`);
        return res.json(cache.get(cacheKey).data);
    }
    return res.status(500).json({ error: 'All data sources failed', details: lastErr?.message });
};
