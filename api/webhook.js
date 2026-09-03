'use strict';

// ============================================================
// Vercel Serverless 入口：Telegram Webhook
// ============================================================

const { createBot } = require('../src/bot');

let bot = null;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('ok');
  }
  if (!bot) bot = createBot();
  try {
    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('webhook error:', e);
    res.status(200).json({ ok: false });
  }
};
