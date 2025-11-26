// providers/binanceUs.js
// Провайдер цен для Binance US

const BASE_URL = 'https://api.binance.us';

async function getLastPrice(symbol) {
    const url = `${BASE_URL}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;

    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`Binance US error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const price = Number(data.price);

    if (!Number.isFinite(price)) {
        throw new Error(`Binance US returned invalid price for ${symbol}`);
    }

    return price;
}

module.exports = { getLastPrice };
