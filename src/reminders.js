'use strict';

// ============================================================
// TG客管家 · 到期提醒推送
// sender: 具备 sendMessage(chatId, text) 能力的对象（bot.telegram / Telegram 实例）
// ============================================================

const db = require('./db');
const core = require('./core');

// 用户每次互动时补发其到期提醒
async function flushDueFor(ownerId, sender) {
  const due = await db.scanDueForOwner(ownerId, new Date());
  for (const r of due) {
    try {
      await sender.sendMessage(
        Number(ownerId),
        `⏰ 跟进提醒（${r.customer_name || '客户'}）\n${r.content}`
      );
      await db.markReminderDone(r.id);
    } catch (e) {
      console.error('remind send fail', ownerId, e.message);
    }
  }
}

// 定时扫描全部到期提醒（由 /api/tick 触发）
async function scanAllDue(sender) {
  const due = await db.scanDueAll(new Date());
  const byOwner = {};
  for (const r of due) {
    (byOwner[r.owner_id] = byOwner[r.owner_id] || []).push(r);
  }
  for (const ownerId of Object.keys(byOwner)) {
    for (const r of byOwner[ownerId]) {
      try {
        await sender.sendMessage(
          Number(ownerId),
          `⏰ 跟进提醒（${r.customer_name || '客户'}）\n${r.content}`
        );
        await db.markReminderDone(r.id);
      } catch (e) {
        console.error('remind scan send fail', ownerId, e.message);
      }
    }
  }
}

module.exports = { flushDueFor, scanAllDue, maybeSendDailyDigest, maybeSendWeeklyReport };

// ---- 每日待办摘要：北京时间 09:00 后，当天未发过则推送一次 ----
async function maybeSendDailyDigest(sender) {
  const bj = core.beijingParts(new Date());
  if (bj.hh * 60 + bj.mm < 9 * 60) return; // 北京时间 09:00 前不发
  const users = await db.listAllUsers();
  for (const u of users) {
    if (u.last_digest_date === bj.date) continue;
    try {
      const text = await buildDigest(u.telegram_id);
      if (!text) {
        await db.markDigestSent(u.telegram_id, bj.date);
        continue;
      }
      await sender.sendMessage(Number(u.telegram_id), text, { parse_mode: 'HTML' });
      await db.markDigestSent(u.telegram_id, bj.date);
    } catch (e) {
      console.error('digest fail', u.telegram_id, e.message);
    }
  }
}

async function buildDigest(ownerId) {
  const [orders, due] = await Promise.all([db.listOrders(ownerId), db.scanDueForOwner(ownerId, new Date())]);
  const esc = core.escapeHtml;
  const waitPay = orders.filter((o) => o.status === '待付款');
  const waitShip = orders.filter((o) => o.status === '待发货');
  const orderLine = (o) =>
    `  • ${esc(o.order_no)} ${esc(o.customer_name)} ${esc(o.product)} ${core.fmtAmount(o.amount, o.currency)}`;
  const parts = [];
  parts.push(`📋 <b>今日待办</b>`);
  if (waitPay.length) {
    parts.push(`\n💰 待催款 ${waitPay.length} 单：\n${waitPay.slice(0, 5).map(orderLine).join('\n')}`);
  }
  if (waitShip.length) {
    parts.push(`\n📦 待发货 ${waitShip.length} 单：\n${waitShip.slice(0, 5).map(orderLine).join('\n')}`);
  }
  if (due.length) {
    parts.push(
      `\n⏰ 超期跟进 ${due.length} 条：\n${due
        .slice(0, 5)
        .map((r) => `  • ${esc(r.content)}（${esc(r.customer_name || '客户')}）`)
        .join('\n')}`
    );
  }
  if (parts.length === 1) return ''; // 无事可做
  parts.push(`\n\n/reminders 查看全部 ｜ /stats 数据看板`);
  return parts.join('');
}

// ---- 每周经营周报：北京时间周一 09:00 后推一次 ----
async function maybeSendWeeklyReport(sender) {
  const bj = core.beijingParts(new Date());
  if (bj.hh * 60 + bj.mm < 9 * 60) return;
  const weekday = new Date(Date.now() + 8 * 3600000).getUTCDay(); // 0=周日
  if (weekday !== 1) return; // 仅周一
  const users = await db.listAllUsers();
  for (const u of users) {
    if (u.last_weekly_date === bj.date) continue;
    try {
      const text = await buildWeekly(u.telegram_id);
      if (!text) {
        await db.markWeeklySent(u.telegram_id, bj.date);
        continue;
      }
      await sender.sendMessage(Number(u.telegram_id), text, { parse_mode: 'HTML' });
      await db.markWeeklySent(u.telegram_id, bj.date);
    } catch (e) {
      console.error('weekly fail', u.telegram_id, e.message);
    }
  }
}

async function buildWeekly(ownerId) {
  const since = new Date(Date.now() - 7 * 86400000);
  const [orders, customers] = await Promise.all([db.listOrders(ownerId), db.listCustomers(ownerId)]);
  const week = orders.filter((o) => new Date(o.created_at) >= since);
  const newCust = customers.filter((c) => new Date(c.created_at) >= since);
  if (!week.length && !newCust.length) return '';
  const esc = core.escapeHtml;
  const byCur = {};
  for (const o of week) {
    const k = o.currency || 'USD';
    byCur[k] = (byCur[k] || 0) + Number(o.amount || 0);
  }
  const amtLine = Object.entries(byCur)
    .map(([c, v]) => `${c} ${Number(v).toLocaleString()}`)
    .join('、');
  const parts = [`📊 <b>上周经营周报</b>`];
  parts.push(`📦 新订单 ${week.length} 笔｜金额 ${amtLine}`);
  parts.push(`👤 新客户 ${newCust.length} 个`);
  const pay = week.filter((o) => o.status === '待付款').length;
  const ship = week.filter((o) => o.status === '待发货').length;
  if (pay || ship) parts.push(`⏳ 进行中：待付款 ${pay}｜待发货 ${ship}`);
  parts.push(`\n本周继续加油！<code>/stats</code> 看完整数据`);
  return parts.join('\n');
}
