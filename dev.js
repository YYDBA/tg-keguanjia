'use strict';

// ============================================================
// 本地开发：长轮询模式（无需 webhook）
// 运行：npm install && npm run dev
// ============================================================

require('dotenv').config();
const { createBot } = require('./src/bot');
const reminders = require('./src/reminders');

const bot = createBot();
bot.launch();

// 本地也每 60 秒扫一次到期提醒
setInterval(() => {
  reminders.scanAllDue(bot.telegram).catch((e) => console.error('tick err', e.message));
}, 60 * 1000);

console.log('🤖 TG客管家 本地运行中（长轮询）…');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
