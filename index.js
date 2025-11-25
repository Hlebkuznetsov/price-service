// ======================================================
// ===============  IMPORTS & SETUP  ====================
// ======================================================

const Fastify = require('fastify');
const { providers } = require('./providers');
const { placeTournamentOrder } = require('./supabaseClient');
// ↑ Этот файл ты создашь (supabaseClient.js)

// Создаём сервер
const fastify = Fastify({ logger: true });


// ======================================================
// =====================  HEALTH  =======================
// ======================================================

// Простой тестовый endpoint — проверить, что сервер жив
fastify.get('/health', async () => {
    return { status: 'ok' };
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

fastify.listen({ port, host: '0.0.0.0' })
    .then(() => {
        console.log(`Server running on port ${port}`);
    })
    .catch((err) => {
        fastify.log.error(err);
        process.exit(1);
    });

