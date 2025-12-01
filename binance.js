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

module.exports = { getLastPrice };
