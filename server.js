const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());

// 실제 브라우저와 거의 동일한 헤더 설정 (차단 방지)
const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://finance.yahoo.com',
    'Referer': 'https://finance.yahoo.com/'
};

/**
 * 1. 차트 데이터 API
 */
app.get('/api/stock/:ticker', async (req, res) => {
    const { ticker } = req.params;
    let { interval = '1d', range = '1y' } = req.query;

    // 잘못된 조합 방어 로직 (야후 API 제약 조건 대응)
    if (range === 'max' && interval === '1d') interval = '1mo'; 

    try {
        console.log(`[CHART] ${ticker} 요청: ${interval} / ${range}`);
        const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`, {
            params: { interval, range },
            headers: commonHeaders,
            timeout: 5000
        });

        if (response.data && response.data.chart.result) {
            res.json(response.data);
        } else {
            throw new Error("No chart result");
        }
    } catch (error) {
        console.error(`[ERR-CHART] ${ticker}:`, error.message);
        res.status(500).json({ error: "주가 데이터를 불러올 수 없습니다." });
    }
});

/**
 * 2. 펀더멘털 데이터 API (404 발생 시에도 빈 응답을 주어 앱 중단 방지)
 */
app.get('/api/fundamentals/:ticker', async (req, res) => {
    const { ticker } = req.params;
    try {
        console.log(`[FUND] ${ticker} 상세 정보 수집 중...`);
        const response = await axios.get(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}`, {
            params: { modules: 'defaultKeyStatistics,summaryDetail,assetProfile,fundProfile,topHoldings' },
            headers: commonHeaders,
            timeout: 5000
        });
        res.json(response.data);
    } catch (error) {
        console.warn(`[WARN-FUND] ${ticker} 상세 정보 차단됨:`, error.message);
        // 에러 시에도 형식을 맞춰서 보냄 (중요: 앱이 0.00으로 굳지 않게 함)
        res.status(200).json({ quoteSummary: { result: [null], error: "Blocked" } });
    }
});

app.listen(PORT, () => {
    console.log(`\n====================================================`);
    console.log(`✅ Trading Proxy Server 가동 완료! (포트: ${PORT})`);
    console.log(`🚀 이제 화면에서 0.00이 사라지고 데이터가 정상 표기됩니다.`);
    console.log(`====================================================\n`);
});