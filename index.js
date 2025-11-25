const Fastify = require('fastify');
const { providers } = require('./providers');

const fastify = Fastify({ logger: true });

// health
fastify.get('/health', async () => {
    return { status: 'ok' };
});

// price test
fastify.get('/price', async (req, reply) => {
    try {
        const symbol = req.query.symbol || 'BTCUSDT';
        const providerName = req.query.provider || 'binance_com';

        const provider = providers[providerName];
        if (!provider) {
            return reply.status(400).send({ error: 'Unknown provider' });
        }

        const price = await provider.getLastPrice(symbol);

        return { symbol, provider: providerName, price };

    } catch (err) {
        return reply.status(500).send({ error: err.message });
    }
});

// start server
const port = Number(process.env.PORT || 3000);
fastify.listen({ port, host: '0.0.0.0' }).then(() => {
    console.log(`Server running on port ${port}`);
});
