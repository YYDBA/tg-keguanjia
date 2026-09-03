'use strict';

// ============================================================
// TG客管家 · 到期提醒推送
// sender: 具备 send(chatId, text) 能力的对象（bot.telegram / Telegram 实例）
// ============================================================

const db = require('./db');

// 用户每次互动时补发其到期提醒
async function flushDueFor(ownerId, sender) {
  const due = await db.scanDueForOwner(ownerId, new Date());
  for (const r of due) {
    try {
      await sender.send(
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
        await sender.send(
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

module.exports = { flushDueFor, scanAllDue };
