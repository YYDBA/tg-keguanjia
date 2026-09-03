'use strict';

// ============================================================
// Vercel Serverless 入口：到期提醒扫描 + 每日/每周推送 + TON/USDT 到账检测
// 由免费 cron-job.org 每分钟触发一次
// ============================================================

const { Telegram } = require('telegraf');
const reminders = require('../src/reminders');
const payments = require('../src/payments');

let sender = null;

module.exports = async function handler(req, res) {
  try {
    if (!sender) sender = new Telegram(process.env.BOT_TOKEN);
    await reminders.scanAllDue(sender);
    await reminders.maybeSendDailyDigest(sender);
    await reminders.maybeSendWeeklyReport(sender);
    await payments.scanIncomingPayments(sender);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('tick error:', e);
    res.status(500).json({ ok: false });
  }
};
