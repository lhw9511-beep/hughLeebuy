const https = require('https');

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30분 캐시

function fetchFng() {
    return new Promise((resolve, reject) => {
        const url = 'https://api.alternative.me/fng/?limit=1&format=json';
        const options = {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
            timeout: 8000
        };
        const req = https.get(url, options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        const parsed = JSON.parse(data);
                        resolve(parsed);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}`));
                    }
                } catch (e) { reject(e); }
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

    const CACHE_KEY = 'fng';
    if (cache.has(CACHE_KEY)) {
        const cached = cache.get(CACHE_KEY);
        if (Date.now() - cached.timestamp < CACHE_TTL)
            return res.json(cached.data);
    }

    try {
        const data = await fetchFng();
        cache.set(CACHE_KEY, { timestamp: Date.now(), data });
        return res.json(data);
    } catch (error) {
        console.error(`[fng] ${error.message}`);
        // 캐시가 만료됐어도 에러보다 낫다 → 오래된 캐시 반환
        if (cache.has(CACHE_KEY)) return res.json(cache.get(CACHE_KEY).data);
        // 최후 fallback: 중립값 반환
        return res.json({
            data: [{ value: '50', value_classification: 'Neutral', timestamp: String(Math.floor(Date.now()/1000)) }]
        });
    }
};
