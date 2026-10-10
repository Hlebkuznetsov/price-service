// slMonitor.js
const WebSocket = require('ws');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REFRESH_INTERVAL_MS = 30_000;

const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
};

let positionsBySymbol = {};
const closing = new Set();
let ws = null;
let reconnectTimer = null;
let currentSymbolSet = '';

async function fetchPositions() {
    try {
        const entryRes = await fetch(
            `${SUPABASE_URL}/rest/v1/tournament_entries?select=id&status=eq.active`,
            { headers }
        );
        if (!entryRes.ok) {
            console.error('[SL] fetch entries failed:', entryRes.status, await entryRes.text());
            return;
        }
        const entries = await entryRes.json();
        if (!entries.length) {
            positionsBySymbol = {};
            return;
        }

        const entryIds = entries.map((e) => e.id).join(',');

        const posRes = await fetch(
            `${SUPABASE_URL}/rest/v1/tournament_positions` +
            `?select=id,entry_id,symbol,side,sl_price,tp_price` +
            `&entry_id=in.(${entryIds})` +
            `&or=(sl_price.not.is.null,tp_price.not.is.null)`,
            { headers }
        );
        if (!posRes.ok) {
            console.error('[SL] fetch positions failed:', posRes.status, await posRes.text());
            return;
        }

        const positions = await posRes.json();
        const bySymbol = {};
        for (const pos of positions) {
            const sym = pos.symbol.toUpperCase();
            (bySymbol[sym] = bySymbol[sym] || []).push(pos);
        }

        positionsBySymbol = bySymbol;
        console.log(`[SL] ${positions.length} positions with SL/TP across ${Object.keys(bySymbol).length} symbols`);
        reconnectIfSymbolsChanged();
    } catch (err) {
        console.error('[SL] fetchPositions error:', err);
    }
}

async function closePosition(entryId, symbol, price, reason) {
    const key = `${entryId}:${symbol}`;
    if (closing.has(key)) return;
    closing.add(key);

    console.log(`[SL] Closing ${symbol} entry=${entryId} — ${reason}`);

    try {
        // upsert актуальной цены чтобы RPC закрыл именно по этой цене
        await fetch(`${SUPABASE_URL}/rest/v1/instrument_prices`, {
            method: 'POST',
            headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({
                symbol: symbol.toUpperCase(),
                last_price: price,
                updated_at: new Date().toISOString(),
            }),
        });

        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/close_tournament_position`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ p_entry_id: entryId, p_symbol: symbol }),
        });

        if (!res.ok) {
            const text = await res.text();
            console.error(`[SL] Close failed ${symbol}/${entryId}: ${res.status} ${text}`);
            closing.delete(key);
            return;
        }

        console.log(`[SL] Closed ${symbol} entry=${entryId} (${reason})`);

        if (positionsBySymbol[symbol]) {
            positionsBySymbol[symbol] = positionsBySymbol[symbol].filter((p) => p.entry_id !== entryId);
            if (!positionsBySymbol[symbol].length) delete positionsBySymbol[symbol];
        }
    } catch (err) {
        console.error('[SL] closePosition error:', err);
        closing.delete(key);
    }
}

function checkPrice(symbol, price) {
    const positions = positionsBySymbol[symbol];
    if (!positions) return;

    for (const pos of positions) {
        if (closing.has(`${pos.entry_id}:${symbol}`)) continue;

        const sl = pos.sl_price != null ? Number(pos.sl_price) : null;
        const tp = pos.tp_price != null ? Number(pos.tp_price) : null;

        if (pos.side === 'long') {
            if (sl !== null && price <= sl)
                closePosition(pos.entry_id, symbol, price, `SL long price=${price} sl=${sl}`);
            else if (tp !== null && price >= tp)
                closePosition(pos.entry_id, symbol, price, `TP long price=${price} tp=${tp}`);
        } else if (pos.side === 'short') {
            if (sl !== null && price >= sl)
                closePosition(pos.entry_id, symbol, price, `SL short price=${price} sl=${sl}`);
            else if (tp !== null && price <= tp)
                closePosition(pos.entry_id, symbol, price, `TP short price=${price} tp=${tp}`);
        }
    }
}

function buildStreamUrl() {
    const symbols = Object.keys(positionsBySymbol);
    if (!symbols.length) return null;
    return `wss://stream.binance.com:9443/stream?streams=${symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join('/')}`;
}

function reconnectIfSymbolsChanged() {
    const newKey = Object.keys(positionsBySymbol).sort().join(',');
    if (newKey === currentSymbolSet && ws && ws.readyState === WebSocket.OPEN) return;
    currentSymbolSet = newKey;
    connect();
}

function connect() {
    if (ws) {
        try { ws.terminate(); } catch (_) { }
        ws = null;
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    const url = buildStreamUrl();
    if (!url) {
        console.log('[SL] No SL/TP positions — WebSocket idle');
        return;
    }

    console.log(`[SL] Connecting to ${Object.keys(positionsBySymbol).length} symbol(s)`);
    ws = new WebSocket(url);

    ws.on('open', () => console.log('[SL] WebSocket connected'));

    ws.on('message', (raw) => {
        try {
            const { data } = JSON.parse(raw.toString());
            if (!data?.s) return;
            const price = Number(data.c);
            if (!Number.isFinite(price) || price <= 0) return;
            checkPrice(data.s.toUpperCase(), price);
        } catch (_) { }
    });

    ws.on('close', (code) => {
        console.log(`[SL] WebSocket closed (code=${code}), reconnecting in 3s`);
        ws = null;
        reconnectTimer = setTimeout(connect, 3000);
    });

    ws.on('error', (err) => {
        console.error('[SL] WebSocket error:', err.message);
        try { ws?.terminate(); } catch (_) { }
    });
}

function start() {
    console.log('[SL] SL/TP monitor starting');
    fetchPositions();
    setInterval(fetchPositions, REFRESH_INTERVAL_MS);
}

function getStatus() {
    return {
        wsState: ws ? ws.readyState : -1, // 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED -1=null
        symbolsWatched: Object.keys(positionsBySymbol),
        positionCount: Object.values(positionsBySymbol).flat().length,
        positions: positionsBySymbol,
        closing: [...closing],
    };
}

module.exports = { start, getStatus };

