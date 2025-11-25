const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// имя функции в Postgres
const RPC_FUNCTION = 'place_tournament_order';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('WARNING: SUPABASE_URL или SUPABASE_SERVICE_KEY не заданы');
}

/**
 * Вызывает RPC place_tournament_order в Supabase
 * params: { entry_id, symbol, side, size_usd, executed_price }
 */
async function placeTournamentOrder(params) {
    const url = `${SUPABASE_URL}/rest/v1/rpc/${RPC_FUNCTION}`;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            apikey: SUPABASE_SERVICE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            p_entry_id: params.entry_id,
            p_symbol: params.symbol,
            p_side: params.side,
            p_size_usd: params.size_usd,
            p_executed_price: params.executed_price,
        }),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase RPC error: ${res.status} ${res.statusText} - ${text}`);
    }

    // функция возвращает jsonb: {"order": {...}}
    return await res.json();
}

module.exports = { placeTournamentOrder };
