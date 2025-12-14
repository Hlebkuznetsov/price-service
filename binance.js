const BASE_URL = 'https://api.binance.com';

async function getLastPrice(symbol) {
    const url = `${BASE_URL}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;

    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`Binance.com error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const price = Number(data.price);

    if (!Number.isFinite(price)) {
        throw new Error(`Invalid price from Binance for ${symbol}`);
    }

    return price;
}

//  для SL / liquidation
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
    const last = Number(k[4]); // close price

    if (![high, low, last].every(Number.isFinite)) {
        throw new Error(`Invalid kline numbers for ${sym}`);
    }

    return { last, high, low };
}

module.exports = {
    getLastPrice,
    getLastBar1m,
};