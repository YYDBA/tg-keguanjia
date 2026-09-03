'use strict';

// ============================================================
// Vercel Serverless 入口：到期提醒扫描
// 由免费 cron-job.org 每 15 分钟触发一次
// ============================================================

const { Telegram } = require('telegraf');
const reminders = require('../src/reminders');

let sender = null;

module.exports = async function handler(req, res) {
  try {
    if (!sender) sender = new Telegram(process.env.BOT_TOKEN);
    await reminders.scanAllDue(sender);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('tick error:', e);
    res.status(500).json({ ok: false });
  }
};
