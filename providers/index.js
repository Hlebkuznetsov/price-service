// providers/index.js
// Реестр всех провайдеров цен

const binanceCom = require('./binanceCom');
const binanceUS = require('./binanceUS');

const providers = {
    binance_com: binanceCom,
    binance_us: binanceUS,
};

module.exports = { providers };
