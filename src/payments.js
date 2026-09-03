'use strict';

// ============================================================
// TG客管家 · Telegram Stars 付费（零收款成本）
// ============================================================

const db = require('./db');

const PRICES = {
  month: { stars: 300, label: 'TG客管家 Pro（月度）', months: 1 },
  year:  { stars: 2900, label: 'TG客管家 Pro（年度）', months: 12 },
};

// 发送 Stars 发票
async function sendUpgradeInvoice(ctx, period = 'month') {
  const p = PRICES[period] || PRICES.month;
  const payload = JSON.stringify({ plan: 'pro', period });
  await ctx.replyWithInvoice({
    title: p.label,
    description:
      '解锁全部额度（客户 2000 / 订单 5000 / 提醒 200）＋ CSV 导出。支付后自动开通。',
    payload,
    provider_token: '', // Stars 必须为空字符串
    currency: 'XTR',
    prices: [{ label: p.label, amount: p.stars }],
  });
}

// 支付前确认
async function onPreCheckout(ctx) {
  await ctx.answerPreCheckoutQuery(true);
}

// 支付成功 → 开通 Pro
async function onSuccessfulPayment(ctx) {
  const payload = ctx.message.successful_payment
    ? ctx.message.successful_payment.invoice_payload || ''
    : '';
  let period = 'month';
  try {
    const parsed = JSON.parse(payload);
    if (parsed && parsed.period === 'year') period = 'year';
  } catch (e) { /* 忽略非法 payload */ }
  const p = PRICES[period];
  const until = new Date(Date.now() + p.months * 30 * 86400000);
  await db.setPlan(ctx.from.id, 'pro', until);
  await ctx.reply(
    `✅ 已升级为 <b>Pro</b>（${p.label}）！\n有效期至：${until.toISOString().slice(0, 10)}\n现在可以享受全部额度与导出功能。`,
    { parse_mode: 'HTML' }
  );
}

module.exports = { PRICES, sendUpgradeInvoice, onPreCheckout, onSuccessfulPayment };
