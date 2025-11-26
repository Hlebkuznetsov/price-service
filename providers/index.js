
const binanceCom = require('./binanceCom');
const binanceUs = require('./binanceUs');  // 👈 имя файла и регистра

const providers = {
    binance_com: binanceCom,
    binance_us: binanceUs,
};

module.exports = { providers };
