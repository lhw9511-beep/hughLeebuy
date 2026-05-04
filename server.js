const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
// Render는 process.env.PORT를 통해 포트를 할당합니다.
const PORT = process.env.PORT || 3000;

app.use(cors());

// [해결책 1] 정적 파일 제공 경로를 현재 폴더(__dirname)로 확실히 고정
app.use(express.static(path.join(__dirname)));

const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://finance.yahoo.com',
    'Referer': 'https://finance.yahoo.com/'
};

// API 요청 함수
async function fetchYahoo(url, params) {
    try {
        return await axios.get(url, { 
            params, 
            headers: commonHeaders, 
            timeout: 10000 
        });
    } catch (error) {
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
        res.status(500).json({ error: "Chart data load failed" });
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

// [해결책 2] 사용자가 "/" (루트)로 접속하면 무조건 index.html을 보내주도록 설정
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// [해결책 3] 그 외 모든 잘못된 경로 접속 시에도 index.html로 리다이렉트 (SPA 방식)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`✅ Server is running on port ${PORT}`);
    console.log(`📂 Serving files from: ${__dirname}`);
});
