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

// 货币符号 → 标准代码
const CURRENCY_MAP = { $: 'USD', '¥': 'CNY', '€': 'EUR', '£': 'GBP' };

// 智能速记常见误判词（"我打算买…"这类话里的主语不是客户名）
const NOTE_STOPWORDS = [
  '我', '你', '他', '她', '我们', '你们', '咱们', '这', '那', '今天', '明天', '昨天', '刚才',
  '准备', '想', '请问', '帮忙', '帮', '能不能', '可以', '一个', '一批', '一些', '大概', '估计',
];

// 智能速记：宽松文本识别一笔订单。要求：含金额 + 含订单动作词 + 能定位到客户。
function parseOrderNote(text, knownNames) {
  const s = String(text || '').trim();
  if (!s) return null;
  const hasVerb = /(?:订|买|要|下单|采购|需要|拿|拍|order|po|purchase)/i.test(s);
  if (!hasVerb) return null;
  const m = s.match(/(?:USD|CNY|EUR|GBP|\$|¥|€|£)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!m) return null;
  const sym = s.match(/(?:USD|CNY|EUR|GBP|\$|¥|€|£)/i)[0];
  const currency = (CURRENCY_MAP[sym] || sym).toUpperCase();
  const amountNum = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(amountNum) || amountNum <= 0) return null;

  // 1) 优先匹配已有客户名
  let customer = null;
  let matchedKnown = false;
  for (const n of knownNames || []) {
    if (n && s.toLowerCase().includes(String(n).toLowerCase())) {
      customer = String(n);
      matchedKnown = true;
      break;
    }
  }
  // 2) 否则取"订/买/要"前的主语，过滤常见误判词
  if (!customer) {
    const who = s.match(/^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9_.\-]{0,24})[\s:：]*(?:订|买|要|下单|采购|需要|拿|拍)/);
    if (who && !NOTE_STOPWORDS.includes(who[1])) customer = who[1];
  }
  if (!customer) return null;

  // 3) 产品 = 去掉客户名与金额后的剩余（再去掉动词/量词尾巴）
  const escRe = customer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let rest = s.replace(new RegExp(escRe, 'i'), '').replace(m[0], '').trim();
  const product =
    rest
      .replace(/^(?:订|买|要|下单|采购|需要|拿|拍)[了着]?/, '')
      .replace(/[订买要下单采购需要拿了着拍]+$/, '')
      .replace(/[，,。.；;\s]+$/, '')
      .trim() || '订单';

  return { customer, product, amount: m[0], currency, amountNum, matchedKnown };
}

// 状态机"下一步"（用于一键流转按钮）
function nextOrderStatus(status) {
  if (status === '待付款') return '待发货';
  if (status === '待发货') return '已发货';
  if (status === '已发货') return '已完成';
  return null;
}

// 发给海外客户的订单确认 / 发货通知（英文模板）
function buildOrderMessage(order, kind) {
  const amt = fmtAmount(order.amount, order.currency);
  const no = order.order_no;
  const name = order.customer_name || 'Customer';
  if (kind === 'ship') {
    return [
      `Dear ${name},`,
      ``,
      `Good news! Your order #${no} has been shipped.`,
      ``,
      `Product: ${order.product}`,
      `Total: ${amt}`,
      ``,
      `We will share the tracking number as soon as it is available. Thank you for your trust!`,
      ``,
      `Best regards`,
    ].join('\n');
  }
  return [
    `Dear ${name},`,
    ``,
    `Thank you for your order #${no}.`,
    ``,
    `Product: ${order.product}`,
    `Total: ${amt}`,
    ``,
    `We will process and ship your order as soon as possible. Please feel free to reply if you have any questions.`,
    ``,
    `Best regards`,
  ].join('\n');
}

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

// 北京时间部件（date=YYYY-MM-DD，hh/mm 为北京时区时分）
function beijingParts(d) {
  const b = new Date(d.getTime() + 8 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())}`,
    hh: b.getUTCHours(),
    mm: b.getUTCMinutes(),
  };
}

// 从转发/消息文本里宽松提取提示信息（金额/订单号），识别不到不返回
function extractHints(text) {
  const s = String(text || '');
  const hints = {};
  const cur = s.match(/(?:USD|CNY|EUR|GBP|\$|¥|€|£)\s*[\d,]+(?:\.\d{1,2})?/i);
  if (cur) hints.amount = cur[0];
  const ono = s.match(/(?:订单号|单号|PO|Order\s*No)[:\s#]*([A-Za-z0-9-]+)/i);
  if (ono) hints.orderNo = ono[1];
  return hints;
}

// 显示时间：默认按北京时间（UTC+8）输出，避免 Vercel 服务器 UTC 时区导致显示差 8 小时
function fmtDateTime(d, tzOffsetHours = 8) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const shifted = new Date(dt.getTime() + tzOffsetHours * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ` +
    `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}`
  );
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

// ---- TON/USDT 收款 ----
// 订阅套餐：月付 / 年付（USDT 价，TON 按实时汇率换算）
const PAY_PLANS = {
  1: { months: 1, usdt: 3 },
  12: { months: 12, usdt: 28 },
};

// 支付备注码：买家转账时尽量填入，用于精确匹配
function generateMemo() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'TGK-';
  for (let i = 0; i < 6; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

// 金额近似相等（允许少量误差，USDT 2 分 / TON 0.05 以内）
function amountsClose(a, b, asset) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const tol = asset === 'USDT' ? 0.02 : 0.05;
  return Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 0.01);
}

// 将一条链上入账匹配到待支付请求：先按备注码，再按金额唯一匹配
function matchPayment(payment, requests) {
  const pend = (requests || []).filter((r) => r.status === 'pending');
  if (payment.comment) {
    const c = String(payment.comment).toUpperCase();
    const byMemo = pend.find((r) => c.includes(r.memo));
    if (byMemo) return byMemo;
  }
  const cand = pend.filter((r) => r.asset === payment.asset && amountsClose(payment.amount, Number(r.amount), r.asset));
  return cand.length === 1 ? cand[0] : null;
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
  beijingParts,
  extractHints,
  parseOrderNote,
  nextOrderStatus,
  buildOrderMessage,
  PAY_PLANS,
  generateMemo,
  amountsClose,
  matchPayment,
};
