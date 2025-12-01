// ======================================================
// ===============  IMPORTS & SETUP  ====================
// ======================================================

const Fastify = require('fastify');
const { WebSocketServer } = require('ws');          // 👈 ДОБАВИЛИ

const { providers } = require('./providers');
const { placeTournamentOrder } = require('./supabaseClient');
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
//    Flutter будет вызывать: https://price-service.../api/v3/ticker/24hr
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
// Позволяет вручную запросить цену по символу и провайдеру

fastify.get('/price', async (req, reply) => {
    try {
        const symbol = req.query.symbol || 'BTCUSDT';
        const providerName = req.query.provider || 'binance_com';

        const provider = providers[providerName];
        if (!provider) {
            return reply.status(400).send({ error: 'Unknown provider' });
        }

        const price = await provider.getLastPrice(symbol);

        return {
            symbol,
            provider: providerName,
            price
        };

    } catch (err) {
        return reply.status(500).send({ error: err.message });
    }
});


// ======================================================
// ============   TOURNAMENT ORDER ENDPOINT   ===========
// ======================================================
// Это основной endpoint, который будет:
//  1) принимать ордер от клиента
//  2) брать цену у провайдера (Binance / Coinbase и т.д.)
//  3) отправлять цену и параметры в Supabase (RPC)
//  4) возвращать клиенту JSON с реальным ордером

fastify.post('/tournament/order', async (request, reply) => {
    try {
        // --- входящие параметры ---
        const { entry_id, symbol, provider, side, size_usd } = request.body || {};

        // --- простая валидация ---
        if (!entry_id || !symbol || !provider || !side || !size_usd) {
            return reply.status(400).send({ error: 'Missing required fields' });
        }

        // --- выбираем провайдера цены ---
        const providerImpl = providers[provider];
        if (!providerImpl) {
            return reply.status(400).send({ error: `Unknown provider: ${provider}` });
        }

        // --- 1) получаем рыночную цену от провайдера ---
        const executedPrice = await providerImpl.getLastPrice(symbol);

        // --- 2) вызываем RPC функцию в Supabase ---
        const rpcResult = await placeTournamentOrder({
            entry_id,
            symbol,
            side,
            size_usd,
            executed_price: executedPrice,
        });

        // --- 3) возвращаем клиенту результат ---
        return reply.send({
            status: 'filled',
            symbol,
            provider,
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



