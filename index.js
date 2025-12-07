// ======================================================
// ===============  IMPORTS & SETUP  ====================
// ======================================================

const Fastify = require('fastify');
const { WebSocketServer } = require('ws');
const { getLastPrice } = require('./binance');

const { placeTournamentOrder, closeTournamentPosition } = require('./supabaseClient');
const { subscribeClient } = require('./priceStream');

const fastify = Fastify({ logger: true });




// ======================================================
// =====================  HEALTH  =======================
// ======================================================
// Простой тестовый endpoint — проверить, что сервер жив

fastify.get('/health', async () => {
    return { status: 'ok' };
});


// ======================================================
// ============  BINANCE REST PROXY (Railway) ===========
// ======================================================
// 1) Прокси для /api/v3/klines
//    Flutter будет вызывать: https://price-service.../api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000

fastify.get('/api/v3/klines', async (req, reply) => {
    try {
        // raw.url = "/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000"
        const upstreamUrl = 'https://api.binance.com' + req.raw.url;

        req.log.info({ upstreamUrl }, '[REST PROXY] /klines → Binance');

        const res = await fetch(upstreamUrl);
        const bodyText = await res.text();

        // Прокидываем статус и тело как есть
        reply
            .code(res.status)
            .header('content-type', res.headers.get('content-type') || 'application/json')
            .send(bodyText);
    } catch (err) {
        req.log.error(err, '[REST PROXY ERROR] /klines');

        reply.code(500).send({
            error: 'Railway /api/v3/klines proxy error',
            details: err.message,
        });
    }
});

// 2) Прокси для /api/v3/ticker/24hr
//    (можно и с ?symbol=BTCUSDT — всё уйдёт в Binance)

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

        reply.code(500).send({
            error: 'Railway /api/v3/ticker/24hr proxy error',
            details: err.message,
        });
    }
});


// ======================================================
// ====================== PRICE =========================
// ======================================================
// Тестовый endpoint, чтобы проверить подключение провайдеров

fastify.get('/price', async (req, reply) => {
    try {
        const symbol = req.query.symbol || 'BTCUSDT';
        const price = await getLastPrice(symbol);

        return {
            symbol,
            price,
        };

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
            provider: 'binance_com',   // можешь оставить как инфу или удалить
            executed_price: executedPrice,
            order: rpcResult.order,
        });

    } catch (err) {
        request.log.error(err);

        return reply.status(500).send({
            error: 'Internal error',
            details: err.message
        });
    }
});


// ======================================================
// ==================== START SERVER ====================
// ======================================================
// Railway потребует host: 0.0.0.0
// PORT будет автоматически браться из переменных Railway

const port = Number(process.env.PORT || 3000);

fastify
    .listen({ port, host: '0.0.0.0' })
    .then(() => {
        console.log(`Server running on port ${port}`);

        // 👇 Поднимаем WebSocket сервер на том же HTTP-сервере Fastify
        const wss = new WebSocketServer({
            server: fastify.server,
            path: '/ws', // тот самый путь
        });

        wss.on('connection', (ws, req) => {
            try {
                // req.url, например: "/ws?symbol=btcusdt&interval=1m"
                const urlObj = new URL(req.url, 'http://localhost');
                const symbol = urlObj.searchParams.get('symbol');
                const interval = urlObj.searchParams.get('interval');

                if (!symbol || !interval) {
                    ws.send(
                        JSON.stringify({
                            type: 'error',
                            message: 'symbol and interval query params are required',
                        }),
                    );
                    ws.close();
                    return;
                }

                console.log(
                    '[WS] New client:',
                    'symbol=',
                    symbol,
                    'interval=',
                    interval
                );

                // 👈 Передаём САМ WebSocket из 'ws' в твой стрим-менеджер
                subscribeClient(ws, symbol, interval);
            } catch (err) {
                console.error('[WS] handler error:', err);
                try {
                    ws.close();
                } catch (_) { }
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
// Для Supabase: принимает { symbols: ["BTCUSDT", "ETHUSDT", ...] }
// и возвращает { prices: { BTCUSDT: 12345.67, ETHUSDT: 2345.89, ... } }

fastify.post('/last-prices', async (req, reply) => {
    try {
        const body = req.body || {};
        const symbols = Array.isArray(body.symbols) ? body.symbols : [];

        if (!symbols.length) {
            return reply.code(400).send({
                error: 'Field "symbols" (non-empty array) is required',
            });
        }

        // уберём дубли и приведём к строкам
        const uniqueSymbols = [...new Set(symbols.map((s) => String(s).trim().toUpperCase()))];

        const prices = {};
        // можно сделать параллельно через Promise.all
        await Promise.all(
            uniqueSymbols.map(async (sym) => {
                try {
                    const p = await getLastPrice(sym);
                    prices[sym] = p;
                } catch (e) {
                    // если по какому-то символу ошибка — просто пишем null
                    req.log.error(e, `[LAST-PRICES] Failed to fetch price for ${sym}`);
                    prices[sym] = null;
                }
            }),
        );

        return reply.send({ prices });
    } catch (err) {
        req.log.error(err, '[LAST-PRICES] Internal error');
        return reply.code(500).send({
            error: 'Internal error in /last-prices',
            details: err.message,
        });
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

        // Берём текущую цену так же, как при открытии ордера
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
            // при желании можно вернуть и это:
            // position: rpcResult.position,
            // portfolio: rpcResult.portfolio,
        });
    } catch (err) {
        request.log.error(err);

        return reply.status(500).send({
            error: 'Internal error',
            details: err.message,
        });
    }
});