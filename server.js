```javascript
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname)));

// 야후 우회 인증용 전역 변수
let globalCookie = '';
let globalCrumb = '';

const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://finance.yahoo.com',
    'Referer': 'https://finance.yahoo.com/'
};

// [핵심] 야후 인증 토큰(Crumb) 발급 함수
async function getYahooCrumb() {
    if (globalCookie && globalCrumb) return { cookie: globalCookie, crumb: globalCrumb };
    try {
        // 1. 야후 쿠키 획득
        const cookieRes = await axios.get('https://fc.yahoo.com/', {
            headers: commonHeaders,
            validateStatus: () => true, // 에러 코드 무시하고 헤더 캡처
            timeout: 5000
        });
        const setCookie = cookieRes.headers['set-cookie'];
        if (setCookie) {
            globalCookie = setCookie.map(c => c.split(';')[0]).join('; ');
        }
        
        // 2. 크럼브(Crumb) 토큰 획득
        const crumbRes = await axios.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
            headers: { ...commonHeaders, 'Cookie': globalCookie },
            timeout: 5000
        });
        globalCrumb = crumbRes.data;
        return { cookie: globalCookie, crumb: globalCrumb };
    } catch (e) {
        console.error("Yahoo Crumb 발급 실패:", e.message);
        return { cookie: '', crumb: '' };
    }
}

// 인증 토큰을 동봉하여 안전하게 통신
async function fetchYahoo(url, params) {
    let { cookie, crumb } = await getYahooCrumb();
    if (crumb) params.crumb = crumb;

    const headers = { ...commonHeaders };
    if (cookie) headers['Cookie'] = cookie;

    try {
        return await axios.get(url, { params, headers, timeout: 10000 });
    } catch (error) {
        // Render 서버가 차단당했거나 토큰이 만료되었을 경우 캐시 초기화
        if (error.response && (error.response.status === 401 || error.response.status === 403 || error.response.status === 429)) {
            globalCookie = ''; 
            globalCrumb = '';
        }
        throw error;
    }
}

// 1. 주가 데이터 API
app.get('/api/stock/:ticker', async (req, res) => {
    const { ticker } = req.params;
    let { interval = '1d', range = '1y' } = req.query;
    try {
        const response = await fetchYahoo(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`, { interval, range });
        res.json(response.data);
    } catch (error) {
        console.error(`[API Error] ${ticker}:`, error.message);
        res.status(500).json({ error: "Chart data load failed", details: error.message });
    }
});

// 2. 펀더멘털 데이터 API
app.get('/api/fundamentals/:ticker', async (req, res) => {
    const { ticker } = req.params;
    try {
        const response = await fetchYahoo(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}`, {
            modules: 'defaultKeyStatistics,summaryDetail,assetProfile,fundProfile,topHoldings'
        });
        res.json(response.data);
    } catch (error) {
        res.json({ quoteSummary: { result: [null], error: "Limited" } });
    }
});

// 라우팅 (SPA 처리)
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

app.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
    console.log(`📂 Serving files from: ${__dirname}`);
});
