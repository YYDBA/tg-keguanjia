'use strict';

// ============================================================
// TG客管家 · 核心逻辑单元测试（node:test 内置，无需装依赖）
// 运行：npm test   （或 node --test test/）
// ============================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');

test('parseCustomerAdd：名字 + 标签 + 备注', () => {
  const r = core.parseCustomerAdd('/customer 添加 Lily #VIP 美国站大客户');
  assert.equal(r.name, 'Lily');
  assert.deepEqual(r.tags, ['VIP']);
  assert.equal(r.note, '美国站大客户');
});

test('parseCustomerAdd：无标签仅名字', () => {
  const r = core.parseCustomerAdd('/customer 添加 Tom');
  assert.equal(r.name, 'Tom');
  assert.deepEqual(r.tags, []);
  assert.equal(r.note, null);
});

test('parseCustomerAdd：空输入返回 null', () => {
  assert.equal(core.parseCustomerAdd(''), null);
  assert.equal(core.parseCustomerAdd('/customer'), null);
});

test('parseOrderAdd：USD 金额', () => {
  const r = core.parseOrderAdd('/order 添加 Lily 陶瓷杯×120 USD 2400');
  assert.equal(r.customer, 'Lily');
  assert.equal(r.product, '陶瓷杯×120');
  assert.equal(r.amount, 2400);
  assert.equal(r.currency, 'USD');
});

test('parseOrderAdd：$ 符号与小数', () => {
  const r = core.parseOrderAdd('/order 添加 Tom 数据线 $1,299.50');
  assert.equal(r.customer, 'Tom');
  assert.equal(r.product, '数据线');
  assert.equal(r.amount, 1299.5);
  assert.equal(r.currency, 'USD');
});

test('parseOrderAdd：无币种默认 USD', () => {
  const r = core.parseOrderAdd('/order 添加 Tom 样品 50');
  assert.equal(r.currency, 'USD');
  assert.equal(r.amount, 50);
});

test('parseOrderAdd：非法返回 null', () => {
  assert.equal(core.parseOrderAdd('/order 添加 Tom'), null);
  assert.equal(core.parseOrderAdd('/order 添加 Tom 苹果 abc'), null);
});

test('parseStatusChange', () => {
  const r = core.parseStatusChange('/order 状态 KJ-0001 待发货');
  assert.equal(r.orderNo, 'KJ-0001');
  assert.equal(r.status, '待发货');
});

test('状态机：允许/禁止流转', () => {
  assert.equal(core.isAllowedTransition('待付款', '待发货'), true);
  assert.equal(core.isAllowedTransition('待付款', '已取消'), true);
  assert.equal(core.isAllowedTransition('待发货', '已发货'), true);
  assert.equal(core.isAllowedTransition('已发货', '已完成'), true);
  assert.equal(core.isAllowedTransition('待付款', '已完成'), false);
  assert.equal(core.isAllowedTransition('已完成', '待付款'), false);
  assert.equal(core.isAllowedTransition('已取消', '已发货'), false);
});

test('parseRemind：按天', () => {
  const before = Date.now();
  const r = core.parseRemind('/remind Lily 3天 催款');
  const after = Date.now();
  assert.equal(r.customer, 'Lily');
  assert.equal(r.content, '催款');
  assert.ok(r.remindAt.getTime() >= before + 2 * 86400000);
  assert.ok(r.remindAt.getTime() <= after + 4 * 86400000);
});

test('parseRemind：按日期', () => {
  const r = core.parseRemind('/remind Lily 2026-09-10 发货后确认');
  const p = (n) => String(n).padStart(2, '0');
  const local =
    r.remindAt.getFullYear() + '-' + p(r.remindAt.getMonth() + 1) + '-' + p(r.remindAt.getDate());
  assert.equal(local, '2026-09-10');
  assert.equal(r.content, '发货后确认');
});

test('parseRemind：非法日期返回 null', () => {
  assert.equal(core.parseRemind('/remind Lily 2026-13-99 x'), null);
  assert.equal(core.parseRemind('/remind'), null);
});

test('套餐额度与邀请奖励', () => {
  assert.deepEqual(core.planLimits('free'), { customers: 20, orders: 30, reminders: 5, exportCsv: false });
  assert.equal(core.effectiveLimit('free', 10, 'customers'), 30);
  const check = core.canCreate('free', 0, 'customers', 20);
  assert.equal(check.ok, false);
  assert.equal(check.limit, 20);
  const check2 = core.canCreate('free', 20, 'customers', 39);
  assert.equal(check2.ok, true);
  assert.equal(check2.limit, 40);
});

test('订单号格式化', () => {
  assert.equal(core.nextOrderNo(1), 'KJ-0001');
  assert.equal(core.nextOrderNo(1234), 'KJ-1234');
});

test('金额格式化', () => {
  assert.equal(core.fmtAmount(2400, 'USD'), '$2,400.00');
  assert.equal(core.fmtAmount(1299.5, 'CNY'), '¥1,299.50');
});

test('escapeHtml 防注入', () => {
  assert.equal(core.escapeHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');
});

test('generateCode：长度与字符集（去掉易混淆字符）', () => {
  const c = core.generateCode();
  assert.match(c, /^[A-HJ-NP-Z2-9]{10}$/);
  const c8 = core.generateCode(8);
  assert.equal(c8.length, 8);
  assert.match(c8, /^[A-HJ-NP-Z2-9]{8}$/);
});
