// ======================================================
// ===============  IMPORTS & SETUP  ====================
// ======================================================

const Fastify = require('fastify');
const { WebSocketServer } = require('ws');
const { getLastPrice, getLastBar1m } = require('./binance');
const { placeTournamentOrder, closeTournamentPosition } = require('./supabaseClient');
const { subscribeClient } = require('./priceStream');

const fastify = Fastify({ logger: true });

// Supabase credentials для server-side валидации
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabaseHeaders = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
};


// ======================================================
// =====================  HEALTH  =======================
// ======================================================

fastify.get('/health', async () => {
    return { status: 'ok' };
});


// ======================================================
// ============  BINANCE REST PROXY (Railway) ===========
// ======================================================

fastify.get('/api/v3/klines', async (req, reply) => {
    try {
        const upstreamUrl = 'https://api.binance.com' + req.raw.url;
        req.log.info({ upstreamUrl }, '[REST PROXY] /klines → Binance');
        const res = await fetch(upstreamUrl);
        const bodyText = await res.text();
        reply
            .code(res.status)
            .header('content-type', res.headers.get('content-type') || 'application/json')
            .send(bodyText);
    } catch (err) {
        req.log.error(err, '[REST PROXY ERROR] /klines');
        reply.code(500).send({ error: 'Railway /api/v3/klines proxy error', details: err.message });
    }
});

fastify.get('/api/v3/ticker/24hr', async (req, reply) => {
    try {
        const upstreamUrl = 'https://api.binance.com' + req.raw.url;
        req.log.info({ upstreamUrl }, '[REST PROXY] /ticker/24hr → Binance');
        const res = await fetch(upstreamUrl);
        const bodyText = await res.text();
        reply
            .code(res.status)
            .header('content-type', res.headers.get('content-type') || 'application/json')
            .send(bodyText);
    } catch (err) {
        req.log.error(err, '[REST PROXY ERROR] /ticker/24hr');
        reply.code(500).send({ error: 'Railway /api/v3/ticker/24hr proxy error', details: err.message });
    }
});


// ======================================================
// ====================== PRICE =========================
// ======================================================

fastify.get('/price', async (req, reply) => {
    try {
        const symbol = req.query.symbol || 'BTCUSDT';
        const price = await getLastPrice(symbol);
        return { symbol, price };
    } catch (err) {
        return reply.status(500).send({ error: err.message });
    }
});


// ======================================================
// ============   TOURNAMENT ORDER ENDPOINT   ===========
// ======================================================

fastify.post('/tournament/order', async (request, reply) => {
    try {
        const { entry_id, symbol, side, size_usd } = request.body || {};

        if (!entry_id || !symbol || !side || !size_usd) {
            return reply.status(400).send({ error: 'Missing required fields' });
        }

        if (typeof size_usd !== 'number' || size_usd <= 0) {
            return reply.status(400).send({ error: 'Invalid size_usd' });
        }

        // ── SERVER-SIDE LEVERAGE VALIDATION ──────────────────────────

        // 1. Проверяем что запись активна
        const entryRes = await fetch(
            `${SUPABASE_URL}/rest/v1/tournament_entries?id=eq.${entry_id}&select=status,tournament_id`,
            { headers: supabaseHeaders }
        );
        const [entry] = await entryRes.json();

        if (!entry) {
            return reply.status(400).send({ error: 'Entry not found' });
        }
        if (entry.status !== 'active') {
            return reply.status(400).send({ error: `Entry is ${entry.status}, cannot trade` });
        }

        // 2. Получаем cash из портфеля
        const portRes = await fetch(
            `${SUPABASE_URL}/rest/v1/tournament_portfolio?entry_id=eq.${entry_id}&select=cash`,
            { headers: supabaseHeaders }
        );
        const [portfolio] = await portRes.json();

        if (!portfolio) {
            return reply.status(400).send({ error: 'Portfolio not found' });
        }
        const cash = Number(portfolio.cash);

        // 3. Получаем leverage из турнира
        const tournRes = await fetch(
            `${SUPABASE_URL}/rest/v1/tournaments?id=eq.${entry.tournament_id}&select=leverage`,
            { headers: supabaseHeaders }
        );
        const [tournament] = await tournRes.json();
        const leverage = Number(tournament?.leverage ?? 50);

        // 4. Считаем экспозицию по направлениям
        const posRes = await fetch(
            `${SUPABASE_URL}/rest/v1/tournament_positions?entry_id=eq.${entry_id}&select=size_usd,side`,
            { headers: supabaseHeaders }
        );
        const positions = await posRes.json();

        const orderIsLong = side === 'buy'; // buy = long, sell = short

        let sameDirectionExposure = 0;
        let oppositeDirectionExposure = 0;

        for (const p of positions ?? []) {
            const posSize = Math.abs(Number(p.size_usd) || 0);
            const posIsLong = p.side === 'long';
            if (posIsLong === orderIsLong) {
                sameDirectionExposure += posSize;
            } else {
                oppositeDirectionExposure += posSize;
            }
        }

        // 5. Проверяем лимит
        //    Максимальная экспозиция = cash * leverage
        //    * 2 — разрешаем разворот позиции (закрыть лонг + открыть шорт)
        const maxExposure = cash * leverage;
        const allowedOrderSize = oppositeDirectionExposure + (maxExposure - sameDirectionExposure);


        if (size_usd > allowedOrderSize + 0.01) {
            request.log.warn(
                `[ORDER BLOCKED] entry=${entry_id} requested=${size_usd} allowed=${allowedOrderSize.toFixed(2)} cash=${cash} leverage=${leverage}`
            );
            return reply.status(400).send({
                error: `Order size $${size_usd} exceeds maximum allowed $${allowedOrderSize.toFixed(2)}`,
            });
        }

        // ── EXECUTE ORDER ─────────────────────────────────────────────

        const executedPrice = await getLastPrice(symbol);

        const rpcResult = await placeTournamentOrder({
            entry_id,
            symbol,
            side,
            size_usd,
            executed_price: executedPrice,
        });

        return reply.send({
            status: 'filled',
            symbol,
            provider: 'binance_com',
            executed_price: executedPrice,
            order: rpcResult.order,
        });

    } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: 'Internal error', details: err.message });
    }
});


// ======================================================
// ==================== START SERVER ====================
// ======================================================

const port = Number(process.env.PORT || 3000);

fastify
    .listen({ port, host: '0.0.0.0' })
    .then(() => {
        console.log(`Server running on port ${port}`);

        const wss = new WebSocketServer({
            server: fastify.server,
            path: '/ws',
        });

        wss.on('connection', (ws, req) => {
            try {
                const urlObj = new URL(req.url, 'http://localhost');
                const symbol = urlObj.searchParams.get('symbol');
                const interval = urlObj.searchParams.get('interval');

                if (!symbol || !interval) {
                    ws.send(JSON.stringify({ type: 'error', message: 'symbol and interval query params are required' }));
                    ws.close();
                    return;
                }

                console.log('[WS] New client:', 'symbol=', symbol, 'interval=', interval);
                subscribeClient(ws, symbol, interval);
            } catch (err) {
                console.error('[WS] handler error:', err);
                try { ws.close(); } catch (_) { }
            }
        });
    })
    .catch((err) => {
        fastify.log.error(err);
        process.exit(1);
    });


// ======================================================
// =============  BATCH LAST PRICES ENDPOINT  ===========
// ======================================================

fastify.post('/last-prices', async (req, reply) => {
    try {
        const body = req.body || {};
        const symbols = Array.isArray(body.symbols) ? body.symbols : [];

        if (!symbols.length) {
            return reply.code(400).send({ error: 'Field "symbols" (non-empty array) is required' });
        }

        const uniqueSymbols = [...new Set(symbols.map((s) => String(s).trim().toUpperCase()))];
        const prices = {};

        await Promise.all(
            uniqueSymbols.map(async (sym) => {
                try {
                    const bar = await getLastBar1m(sym);
                    prices[sym] = bar;
                } catch (e) {
                    req.log.error(e, `[LAST-PRICES] Failed to fetch 1m bar for ${sym}`);
                    prices[sym] = null;
                }
            }),
        );

        return reply.send({ prices });
    } catch (err) {
        req.log.error(err, '[LAST-PRICES] Internal error');
        return reply.code(500).send({ error: 'Internal error in /last-prices', details: err.message });
    }
});


// ======================================================
// ============   CLOSE TOURNAMENT POSITION   ===========
// ======================================================

fastify.post('/tournament/close-position', async (request, reply) => {
    try {
        const { entry_id, symbol } = request.body || {};

        if (!entry_id || !symbol) {
            return reply.status(400).send({ error: 'Missing required fields (entry_id, symbol)' });
        }

        const executedPrice = await getLastPrice(symbol);

        const rpcResult = await closeTournamentPosition({
            entry_id,
            symbol,
            executed_price: executedPrice,
        });

        return reply.send({
            status: 'filled',
            symbol,
            provider: 'binance_com',
            executed_price: executedPrice,
            order: rpcResult.order,
        });
    } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: 'Internal error', details: err.message });
    }
});
