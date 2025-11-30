// priceStream.js
const WebSocket = require('ws');

// key: `${symbolLower}@${interval}`
// value: { ws, clients: Set<WebSocket>, lastPayload }
const streams = {};

function getKey(symbol, interval) {
    const symLower = String(symbol).toLowerCase().trim();
    const tf = String(interval).trim();
    return `${symLower}@${tf}`;
}

/**
 * Подписка клиента на общий стрим symbol+interval.
 * clientSocket - WebSocket клиента (Flutter)
 * symbol       - 'BTCUSDT'
 * interval     - '1m', '5m', '15m', '1h', ...
 */
function subscribeClient(clientSocket, symbol, interval) {
    const key = getKey(symbol, interval);

    // если стрима ещё нет — создаём
    if (!streams[key]) {
        streams[key] = createStream(symbol, interval);
    }

    const stream = streams[key];
    stream.clients.add(clientSocket);

    console.log(
        '[PRICE-STREAM] Client subscribed:',
        'symbol=', symbol,
        'interval=', interval,
        'clients=', stream.clients.size
    );

    // привет
    safeSend(clientSocket, {
        type: 'hello',
        symbol,
        interval,
        message: 'Charty shared price stream connected',
    });

    // если уже есть последняя свеча — можем сразу отдать
    if (stream.lastPayload) {
        safeSend(clientSocket, {
            type: 'snapshot',
            data: stream.lastPayload,
        });
    }

    // когда клиент закрывается
    clientSocket.on('close', () => {
        stream.clients.delete(clientSocket);
        console.log(
            '[PRICE-STREAM] Client disconnected:',
            'symbol=', symbol,
            'interval=', interval,
            'clients left=', stream.clients.size
        );

        if (stream.clients.size === 0) {
            console.log(
                '[PRICE-STREAM] No clients left, closing Binance WS for',
                symbol,
                interval
            );
            try {
                stream.ws.close();
            } catch (_) { }
            delete streams[key];
        }
    });

    clientSocket.on('error', (err) => {
        console.error('[PRICE-STREAM] Client socket error:', err);
        stream.clients.delete(clientSocket);

        if (stream.clients.size === 0) {
            console.log(
                '[PRICE-STREAM] No clients left (error), closing Binance WS for',
                symbol,
                interval
            );
            try {
                stream.ws.close();
            } catch (_) { }
            delete streams[key];
        }
    });
}

/**
 * Создаёт Binance WS для конкретного symbol+interval.
 */
function createStream(symbol, interval) {
    const symLower = String(symbol).toLowerCase().trim();
    const tf = String(interval).trim();

    const url = `wss://stream.binance.com:9443/ws/${encodeURIComponent(
        symLower
    )}@kline_${tf}`;

    console.log('[PRICE-STREAM] Creating Binance WS stream:', url);

    const clients = new Set();
    let lastPayload = null;
    let ws = null;

    function connect() {
        ws = new WebSocket(url);

        ws.on('open', () => {
            console.log('[PRICE-STREAM] Binance WS opened for', symLower, tf);
        });

        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());

                // одиночный stream: { e: "kline", s: "BTCUSDT", k: {...} }
                const k = msg?.k ?? msg?.data?.k;
                if (!k) return;

                const payload = {
                    type: 'kline',
                    symbol: k.s,          // "BTCUSDT"
                    interval: k.i,        // "1m"
                    openTime: k.t,
                    closeTime: k.T,
                    open: Number(k.o),
                    high: Number(k.h),
                    low: Number(k.l),
                    close: Number(k.c),
                    volume: Number(k.v),
                    isFinal: !!k.x,
                };

                // запоминаем последнюю свечу
                lastPayload = payload;

                // рассылаем всем клиентам
                const data = JSON.stringify(payload);
                for (const socket of clients) {
                    if (socket.readyState === WebSocket.OPEN || socket.readyState === 1) {
                        socket.send(data);
                    }
                }
            } catch (err) {
                console.error('[PRICE-STREAM] parse error:', err);
                const errMsg = JSON.stringify({
                    type: 'error',
                    source: 'binance_parse',
                    message: err.message,
                });
                for (const socket of clients) {
                    safeSendRaw(socket, errMsg);
                }
            }
        });

        ws.on('close', (code, reason) => {
            console.error(
                '[PRICE-STREAM] Binance WS closed:',
                symLower,
                tf,
                'code=',
                code,
                'reason=',
                reason?.toString()
            );

            // если ещё есть клиенты — пробуем переподключиться
            if (clients.size > 0) {
                console.log(
                    '[PRICE-STREAM] Clients still connected, reconnecting Binance WS in 3s'
                );
                setTimeout(connect, 3000);
            }
        });

        ws.on('error', (err) => {
            console.error('[PRICE-STREAM] Binance WS error:', err);
            try {
                ws.close();
            } catch (_) { }
        });
    }

    connect();

    return {
        ws,
        clients,
        get lastPayload() {
            return lastPayload;
        },
        set lastPayload(value) {
            lastPayload = value;
        },
    };
}

function safeSend(socket, payload) {
    try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === 1) {
            socket.send(JSON.stringify(payload));
        }
    } catch (e) {
        console.error('[PRICE-STREAM] safeSend error:', e);
    }
}

function safeSendRaw(socket, raw) {
    try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === 1) {
            socket.send(raw);
        }
    } catch (e) {
        console.error('[PRICE-STREAM] safeSendRaw error:', e);
    }
}

module.exports = {
    subscribeClient,
};
