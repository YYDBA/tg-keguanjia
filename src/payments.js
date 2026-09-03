'use strict';

// ============================================================
// TG客管家 · 收款
//  - Telegram Stars（兼容，受地区限制时不可用）
//  - TON / USDT(TON链) 自动到账：扫码转账 → bot 检测入账 → 自动开通 Pro
// ============================================================

const db = require('./db');
const core = require('./core');
let Address = null;
try { ({ Address } = require('@ton/core')); } catch (e) { /* 可选依赖 */ }

// 统一成友好可读地址（EQ/UQ 开头），对 Tonkeeper 链接更稳
function toFriendly(addr) {
  if (!addr) return addr;
  try {
    if (Address) return Address.parse(addr).toString();
  } catch (e) { /* 保持原样 */ }
  return addr;
}

const PRICES = {
  month: { stars: 300, label: 'TG客管家 Pro（月度）', months: 1 },
  year: { stars: 2900, label: 'TG客管家 Pro（年度）', months: 12 },
};

const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'; // Tether USD on TON

async function getJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---- Stars 发票（保留兼容，地区受限时不可用） ----
async function sendUpgradeInvoice(ctx, period = 'month') {
  const p = PRICES[period] || PRICES.month;
  const payload = JSON.stringify({ plan: 'pro', period });
  await ctx.replyWithInvoice({
    title: p.label,
    description: '解锁全部额度（客户 2000 / 订单 5000 / 提醒 200）＋ CSV 导出。支付后自动开通。',
    payload,
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: p.label, amount: p.stars }],
  });
}

// ---- Stars 支付回调（保留兼容；Stars 不可用时不会被触发） ----
async function onPreCheckout(ctx) {
  await ctx.answerPreCheckoutQuery(true);
}

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

// ---- 从链上拉最近入账 ----
async function fetchIncomingTon(wallet) {
  const j = await getJson(
    `https://tonapi.io/v2/blockchain/accounts/${encodeURIComponent(wallet)}/transactions?limit=30`
  );
  const out = [];
  for (const tx of j.transactions || []) {
    const m = tx.in_msg;
    if (!m || !m.source || !m.destination) continue;
    if (tx.success === false) continue;
    const valueTon = Number(m.value || 0) / 1e9;
    if (valueTon <= 0) continue;
    const comment =
      tx.decoded_op_name === 'text_comment' && tx.decoded_body && tx.decoded_body.text
        ? String(tx.decoded_body.text)
        : '';
    out.push({ asset: 'TON', amount: valueTon, comment, txHash: tx.hash, ts: tx.utime, from: m.source.address });
  }
  return out;
}

async function fetchIncomingUsdt(wallet) {
  const url =
    `https://toncenter.com/api/v3/jetton/transfers` +
    `?owner_address=${encodeURIComponent(wallet)}` +
    `&jetton_master=${USDT_MASTER}` +
    `&direction=in&limit=30&sort=desc`;
  const j = await getJson(url);
  const out = [];
  for (const t of j.jetton_transfers || []) {
    if (t.transaction_aborted) continue;
    const amountUsdt = Number(t.amount || 0) / 1e6; // USDT decimals = 6
    if (amountUsdt <= 0) continue;
    let comment = '';
    const fp = t.decoded_forward_payload;
    if (typeof fp === 'string') comment = fp;
    else if (fp && fp.text) comment = String(fp.text);
    out.push({ asset: 'USDT', amount: amountUsdt, comment, txHash: t.transaction_hash, ts: t.transaction_now, from: t.source });
  }
  return out;
}

// ---- 扫描入账 → 匹配 → 自动开通 ----
async function scanIncomingPayments(sender) {
  const wallet = (await db.getSetting('wallet_address')) || process.env.TON_WALLET || '';
  if (!wallet) return;
  const pending = await db.listPendingPayRequests();
  if (!pending.length) return;
  const usedTx = await db.listUsedPayTxHashes();
  const nowSec = Date.now() / 1000;
  const windowSec = 24 * 3600;
  let incoming = [];
  try {
    incoming = incoming.concat(await fetchIncomingTon(wallet));
  } catch (e) {
    console.error('ton fetch fail', e.message);
  }
  try {
    incoming = incoming.concat(await fetchIncomingUsdt(wallet));
  } catch (e) {
    console.error('usdt fetch fail', e.message);
  }
  for (const pay of incoming) {
    if (usedTx.has(pay.txHash)) continue;
    if (nowSec - pay.ts > windowSec) continue;
    const req = core.matchPayment(pay, pending);
    if (!req) continue;
    const paid = await db.markPayRequestPaid(req.id, pay.txHash);
    if (!paid) continue; // 已被并发处理
    usedTx.add(pay.txHash);
    const code = core.generateCode(10);
    const rec = await db.createActivationCode({ code, durationDays: req.plan_months * 30, createdBy: req.owner_id });
    await db.useActivationCode(rec.code, req.buyer_tg);
    const until = new Date(Date.now() + rec.duration_days * 86400000);
    await db.setPlan(req.buyer_tg, 'pro', until);
    try {
      await sender.sendMessage(
        Number(req.buyer_tg),
        `✅ <b>已到账，Pro 已开通！</b>\n` +
          `金额：${core.fmtAmount(pay.amount, pay.asset)}\n` +
          `套餐：Pro ${req.plan_months} 个月（至 ${until.toISOString().slice(0, 10)}）\n\n` +
          `感谢支持，祝生意兴隆！🎉`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('notify buyer fail', req.buyer_tg, e.message);
    }
    if (Number(req.owner_id) !== Number(req.buyer_tg)) {
      try {
        await sender.sendMessage(
          Number(req.owner_id),
          `💰 <b>新到账</b>\n${pay.amount} ${pay.asset}（订单 ${req.memo}）\n已自动为买家开通 Pro ${req.plan_months} 个月。`,
          { parse_mode: 'HTML' }
        );
      } catch (e) {
        /* 忽略通知失败 */
      }
    }
    console.log('payment resolved', req.memo, pay.asset, pay.amount, pay.txHash);
  }
}

// ---- 买家发起支付请求 ----
async function createPayRequest({ buyerTg, months, asset }) {
  const wallet = (await db.getSetting('wallet_address')) || process.env.TON_WALLET || '';
  const ownerId = Number(process.env.OWNER_ID || 0);
  const plan = core.PAY_PLANS[months] || core.PAY_PLANS[1];
  let amount;
  if (asset === 'TON') {
    let rate = 1;
    try {
      const j = await getJson('https://tonapi.io/v2/rates?tokens=ton&currencies=usd');
      rate = Number(j.rates.TON.prices.USD) || 1;
    } catch (e) {
      console.error('rate fail', e.message);
    }
    amount = Math.round((plan.usdt / rate) * 100) / 100;
  } else {
    amount = plan.usdt;
  }
  const memo = core.generateMemo();
  const req = await db.createPayRequest({
    memo,
    ownerId,
    buyerTg,
    asset,
    amount: String(amount),
    planMonths: plan.months,
  });
  return { req, wallet, plan, amount, memo };
}

// ---- 一键支付深链 ----
// 通过 USDT 主合约的 get_wallet_address get 方法计算收款方的 USDT 子钱包地址
// （纯计算，钱包未收过 USDT 也能返回正确地址；Tether 自定义实现不可用本地推导）
async function getUsdtJettonWallet(owner) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(
        `https://tonapi.io/v2/blockchain/accounts/${encodeURIComponent(USDT_MASTER)}/methods/get_wallet_address`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ args: [{ type: 'slice', value: owner }] }),
          signal: ctrl.signal,
        }
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const addr = j && j.decoded && j.decoded.jetton_wallet_address;
      return addr || null;
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    console.error('getUsdtJettonWallet fail', e.message);
    return null;
  }
}

// 生成一键支付深链（Tonkeeper HTTPS 链接，可放按钮；另返回 ton:// 原文作兜底）
// 返回 { url, raw }，失败时 url 为 null
async function buildPayLink({ asset, wallet, amount, memo }) {
  const text = encodeURIComponent(memo);
  const friendlyWallet = toFriendly(wallet);
  if (asset === 'TON') {
    const nano = String(Math.round(amount * 1e9));
    const url = `https://app.tonkeeper.com/transfer/${encodeURIComponent(friendlyWallet)}?amount=${nano}&text=${text}`;
    const raw = `ton://transfer/${encodeURIComponent(friendlyWallet)}?amount=${nano}&text=${text}`;
    return { url, raw };
  }
  // USDT：需要收款方 USDT 子钱包地址
  const jw = await getUsdtJettonWallet(friendlyWallet);
  if (!jw) return { url: null, raw: '' };
  const nano = String(Math.round(amount * 1e6));
  const url =
    `https://app.tonkeeper.com/transfer/${encodeURIComponent(toFriendly(jw))}` +
    `?jetton=${encodeURIComponent(USDT_MASTER)}&amount=${nano}&text=${text}`;
  return { url, raw: '' };
}

module.exports = {
  PRICES,
  USDT_MASTER,
  sendUpgradeInvoice,
  onPreCheckout,
  onSuccessfulPayment,
  fetchIncomingTon,
  fetchIncomingUsdt,
  scanIncomingPayments,
  createPayRequest,
  getUsdtJettonWallet,
  buildPayLink,
};
