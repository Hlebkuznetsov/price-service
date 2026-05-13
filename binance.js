const BASE_URL = 'https://api.binance.com';

async function getLastPrice(symbol) {
    const [priceRes, statsRes] = await Promise.all([
        fetch(`${BASE_URL}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`),
        fetch(`${BASE_URL}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`),
    ]);

    if (!priceRes.ok) {
        throw new Error(`Binance price error: ${priceRes.status} ${priceRes.statusText}`);
    }
    if (!statsRes.ok) {
        throw new Error(`Binance 24hr error: ${statsRes.status} ${statsRes.statusText}`);
    }

    const priceData = await priceRes.json();
    const statsData = await statsRes.json();

    const price = Number(priceData.price);
    const high24 = Number(statsData.highPrice);
    const low24 = Number(statsData.lowPrice);

    if (!Number.isFinite(price)) {
        throw new Error(`Invalid price from Binance for ${symbol}`);
    }

    if (!Number.isFinite(high24) || !Number.isFinite(low24) || high24 <= 0 || low24 <= 0) {
        throw new Error(`Invalid 24hr stats from Binance for ${symbol}`);
    }

    if (price > high24 || price < low24) {
        throw new Error(`Price anomaly: ${symbol} price=${price} outside 24hr range [${low24}, ${high24}]`);
    }

    return price;
}

// для SL / liquidation
async function getLastBar1m(symbol) {
    const sym = String(symbol).trim().toUpperCase();
    const url =
        `${BASE_URL}/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=1m&limit=1`;

    const res = await fetch(url);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Binance klines error ${res.status}: ${text}`);
    }

    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) {
        throw new Error(`Empty kline for ${sym}`);
    }

    const k = arr[0];
    const high = Number(k[2]);
    const low = Number(k[3]);
    const last = Number(k[4]);

    if (![high, low, last].every(Number.isFinite)) {
        throw new Error(`Invalid kline numbers for ${sym}`);
    }

    return { last, high, low };
}

module.exports = {
    getLastPrice,
    getLastBar1m,
};
