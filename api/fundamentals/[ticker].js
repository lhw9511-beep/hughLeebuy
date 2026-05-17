const yahooFinance = require('yahoo-finance2').default;

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // URL 직접 파싱: /api/fundamentals/AAPL -> AAPL
    const urlPath = req.url.split('?')[0];
    const parts = urlPath.split('/');
    const tickerFromUrl = parts[parts.length - 1];

    const ticker = (tickerFromUrl || req.query.ticker || '').toUpperCase().trim();
    if (!ticker) return res.status(400).json({ error: 'ticker is required' });

    try {
        const summary = await yahooFinance.quoteSummary(ticker, {
            modules: ['defaultKeyStatistics', 'summaryDetail', 'assetProfile', 'fundProfile', 'topHoldings']
        });
        return res.json({ quoteSummary: { result: [summary], error: null } });
    } catch (error) {
        console.error(`[fundamentals/${ticker}] ${error.message}`);
        return res.json({ quoteSummary: { result: [null], error: 'Limited' } });
    }
};
