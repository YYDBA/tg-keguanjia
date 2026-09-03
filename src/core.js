'use strict';

// ============================================================
// TG客管家 · 纯业务逻辑（无 npm 外部依赖，可单元测试）
// ============================================================

const crypto = require('node:crypto');

// ---- 套餐额度 ----
const PLANS = {
  free: { customers: 20, orders: 30, reminders: 5, exportCsv: false },
  pro:  { customers: 2000, orders: 5000, reminders: 200, exportCsv: true },
};

const ORDER_STATUSES = ['待付款', '待发货', '已发货', '已完成', '已取消'];

// 状态机允许的流转
const TRANSITIONS = {
  '待付款': ['待发货', '已取消'],
  '待发货': ['已发货', '已取消'],
  '已发货': ['已完成', '已取消'],
  '已完成': [],
  '已取消': [],
};

// 订单停留超过该天数进入风险提示
const SLUG_DAYS = 7;

function planLimits(plan) {
  return PLANS[plan] || PLANS.free;
}

// 有效额度 = 套餐基础额度 + 邀请好友奖励额度
function effectiveLimit(plan, bonus, resource) {
  return planLimits(plan)[resource] + (bonus || 0);
}

function canCreate(plan, bonus, resource, current) {
  const limit = effectiveLimit(plan, bonus, resource);
  return { ok: current < limit, limit };
}

// ---- 客户解析：/customer 添加 名字 [#标签...] [备注] ----
function parseCustomerAdd(text) {
  let s = String(text || '').replace(/^\/customer\s*/i, '').trim();
  if (!s) return null;
  if (s.startsWith('添加')) s = s.slice(2).trim();
  if (!s) return null;
  const tags = [];
  const cleaned = s
    .split(/\s+/)
    .filter((tok) => {
      if (tok.startsWith('#')) {
        const t = tok.slice(1).trim();
        if (t) tags.push(t);
        return false;
      }
      return true;
    })
    .join(' ');
  const m = cleaned.match(/^(\S+)\s*([\s\S]*)$/);
  if (!m || !m[1]) return null;
  return { name: m[1], tags, note: m[2] ? m[2].trim() : null };
}

// ---- 订单解析：/order 添加 客户名 商品 金额 ----
function parseOrderAdd(text) {
  let s = String(text || '').replace(/^\/order\s+/i, '').trim();
  if (s.startsWith('添加')) s = s.slice(2).trim();
  if (!s) return null;
  // 末尾金额，可带币种：USD 1200 / $1200 / 1200 / ￥1200
  const m = s.match(/(?:([A-Za-z]{3})|([$￥€£]))?\s*(\d[\d,]*(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const amount = Number(m[3].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount < 0) return null;
  const currency = m[1]
    ? m[1].toUpperCase()
    : m[2] === '￥' ? 'CNY'
    : m[2] === '€' ? 'EUR'
    : m[2] === '£' ? 'GBP'
    : 'USD';
  const head = s.slice(0, s.length - m[0].length).trim();
  const parts = head.split(/\s+/);
  if (parts.length < 2) return null;
  return { customer: parts[0], product: parts.slice(1).join(' '), amount, currency };
}

// ---- 状态变更解析：/order 状态 单号 新状态 ----
function parseStatusChange(text) {
  let s = String(text || '').replace(/^\/order\s+/i, '').trim();
  if (s.startsWith('状态')) s = s.slice(2).trim();
  const parts = s.split(/\s+/);
  if (parts.length < 2) return null;
  return { orderNo: parts[0], status: parts.slice(1).join(' ') };
}

// ---- 提醒解析：/remind 客户名 N分钟|N小时|N天|YYYY-MM-DD 内容 ----
function parseRemind(text) {
  let s = String(text || '').replace(/^\/remind\s+/i, '').trim();
  const m = s.match(/^(\S+)\s+(?:(\d+)\s*分钟|(\d+)\s*小时|(\d+)\s*天|(\d{4}-\d{2}-\d{2}))\s*([\s\S]*)$/);
  if (!m) return null;
  const customer = m[1];
  const minutes = m[2] ? Number(m[2]) : null;
  const hours = m[3] ? Number(m[3]) : null;
  const days = m[4] ? Number(m[4]) : null;
  const dateStr = m[5] || null;
  const content = (m[6] || '').trim() || '跟进客户';
  let remindAt;
  if (minutes != null) {
    remindAt = new Date(Date.now() + minutes * 60000);
  } else if (hours != null) {
    remindAt = new Date(Date.now() + hours * 3600000);
  } else if (days != null) {
    remindAt = new Date(Date.now() + days * 86400000);
  } else {
    remindAt = new Date(dateStr + 'T00:00:00');
  }
  if (Number.isNaN(remindAt.getTime())) return null;
  return { customer, content, remindAt };
}

function isAllowedTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

function nextOrderNo(seq) {
  return 'KJ-' + String(seq).padStart(4, '0');
}

function fmtAmount(amount, currency) {
  const sym = currency === 'USD' ? '$'
    : currency === 'CNY' ? '¥'
    : currency === 'EUR' ? '€'
    : currency === 'GBP' ? '£'
    : currency + ' ';
  return sym + Number(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDateTime(d) {
  const dt = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

// 生成兑换码（去掉易混淆字符 I/L/0/O/1）
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode(length = 10) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

module.exports = {
  PLANS,
  ORDER_STATUSES,
  TRANSITIONS,
  SLUG_DAYS,
  planLimits,
  effectiveLimit,
  canCreate,
  parseCustomerAdd,
  parseOrderAdd,
  parseStatusChange,
  parseRemind,
  isAllowedTransition,
  nextOrderNo,
  fmtAmount,
  escapeHtml,
  fmtDateTime,
  generateCode,
};
