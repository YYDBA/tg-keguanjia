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

test('parseRemind：按分钟与小时', () => {
  const before = Date.now();
  const rm = core.parseRemind('/remind 测试 1分钟 x');
  const rh = core.parseRemind('/remind 测试 2小时 x');
  const after = Date.now();
  assert.equal(rm.customer, '测试');
  assert.equal(rm.content, 'x');
  assert.ok(rm.remindAt.getTime() >= before + 0.9 * 60000);
  assert.ok(rm.remindAt.getTime() <= after + 1.2 * 60000);
  assert.ok(rh.remindAt.getTime() >= before + 1.9 * 3600000);
  assert.ok(rh.remindAt.getTime() <= after + 2.2 * 3600000);
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

test('fmtDateTime：默认按北京时间(UTC+8)显示', () => {
  assert.equal(core.fmtDateTime(new Date('2026-09-03T08:29:00Z')), '2026-09-03 16:29');
  assert.equal(core.fmtDateTime(new Date('2026-09-03T08:29:00Z'), 0), '2026-09-03 08:29');
});

test('beijingParts：UTC 换算为北京时间', () => {
  const p = core.beijingParts(new Date('2026-09-03T08:29:00Z'));
  assert.equal(p.date, '2026-09-03');
  assert.equal(p.hh, 16);
  assert.equal(p.mm, 29);
});

test('extractHints：识别金额与订单号', () => {
  assert.deepEqual(core.extractHints('Lily 定了 120 个马克杯 USD 2400'), { amount: 'USD 2400' });
  assert.deepEqual(core.extractHints('PO #ABC-123 请尽快发货'), { orderNo: 'ABC-123' });
  assert.deepEqual(core.extractHints('随便聊聊'), {});
});

test('parseOrderNote：智能速记识别订单', () => {
  const known = ['Lily', 'Tom'];
  const n = core.parseOrderNote('Lily 订了 100 个陶瓷马克杯 USD 2400', known);
  assert.equal(n.customer, 'Lily');
  assert.equal(n.amountNum, 2400);
  assert.equal(n.currency, 'USD');
  assert.equal(n.matchedKnown, true);
  assert.match(n.product, /陶瓷马克杯/);

  // 未知客户 + 主语识别
  const n2 = core.parseOrderNote('Jack 需要 500 件 T 恤 ¥8000', []);
  assert.equal(n2.customer, 'Jack');
  assert.equal(n2.currency, 'CNY');
  assert.equal(n2.amountNum, 8000);

  // 非订单（无金额 / 闲聊）→ null
  assert.equal(core.parseOrderNote('杯子多少钱', known), null);
  assert.equal(core.parseOrderNote('我打算买一批杯子', known), null);
  assert.equal(core.parseOrderNote('', known), null);
});

test('nextOrderStatus：状态机下一步', () => {
  assert.equal(core.nextOrderStatus('待付款'), '待发货');
  assert.equal(core.nextOrderStatus('待发货'), '已发货');
  assert.equal(core.nextOrderStatus('已发货'), '已完成');
  assert.equal(core.nextOrderStatus('已完成'), null);
  assert.equal(core.nextOrderStatus('已取消'), null);
});

test('buildOrderMessage：订单确认/发货通知英文模板', () => {
  const o = { order_no: 'KJ-0001', customer_name: 'Lily', product: '陶瓷马克杯×120', amount: 2400, currency: 'USD' };
  const confirm = core.buildOrderMessage(o, 'confirm');
  assert.match(confirm, /Dear Lily/);
  assert.match(confirm, /KJ-0001/);
  assert.match(confirm, /2,400/);
  const ship = core.buildOrderMessage(o, 'ship');
  assert.match(ship, /has been shipped/);
});

test('generateMemo：支付备注码格式', () => {
  assert.match(core.generateMemo(), /^TGK-[A-Z2-9]{6}$/);
  assert.notEqual(core.generateMemo(), core.generateMemo());
});

test('matchPayment：按备注码 / 按金额唯一匹配', () => {
  const requests = [
    { id: 'a', memo: 'TGK-ABC123', asset: 'USDT', amount: '3', status: 'pending' },
    { id: 'b', memo: 'TGK-DFG456', asset: 'TON', amount: '2.24', status: 'pending' },
  ];
  // 备注码命中
  assert.equal(core.matchPayment({ asset: 'USDT', amount: 3, comment: 'TGK-ABC123', txHash: 't1', ts: 0 }, requests).id, 'a');
  // 无备注，金额唯一命中
  assert.equal(core.matchPayment({ asset: 'TON', amount: 2.25, comment: '', txHash: 't2', ts: 0 }, requests).id, 'b');
  // 金额不匹配 → null
  assert.equal(core.matchPayment({ asset: 'USDT', amount: 9.99, comment: '', txHash: 't3', ts: 0 }, requests), null);
  // 两个同金额 USDT 待付 → 金额无法唯一匹配 → null
  const dup = requests.concat([{ id: 'c', memo: 'TGK-XYZ789', asset: 'USDT', amount: '3', status: 'pending' }]);
  assert.equal(core.matchPayment({ asset: 'USDT', amount: 3, comment: '', txHash: 't4', ts: 0 }, dup), null);
  // 已支付的不参与匹配
  const paid = requests.map((r) => ({ ...r, status: 'paid' }));
  assert.equal(core.matchPayment({ asset: 'USDT', amount: 3, comment: '', txHash: 't5', ts: 0 }, paid), null);
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
