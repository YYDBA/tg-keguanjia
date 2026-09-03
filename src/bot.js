'use strict';

// ============================================================
// TG客管家 · Telegram Bot 主逻辑（telegraf 4）
// ============================================================

const { Telegraf, Markup } = require('telegraf');
const core = require('./core');
const db = require('./db');
const payments = require('./payments');
const reminders = require('./reminders');

const esc = core.escapeHtml;

// 管理员（能生成兑换码）的 telegram_id，在 .env 里配置 OWNER_ID
const OWNER_ID = process.env.OWNER_ID ? Number(process.env.OWNER_ID) : null;

// 提取命令后的 payload
function payload(ctx) {
  const t = ctx.message && ctx.message.text ? ctx.message.text : '';
  return t.replace(/^\/[^\s]+/, '').trim();
}

function getPlanLabel(plan) {
  return plan === 'pro' ? 'Pro' : '免费版';
}

function customerLine(c) {
  const tags = (c.tags || []).map((t) => '#' + esc(t)).join(' ');
  const note = c.note ? `｜${esc(c.note)}` : '';
  return `👤 <b>${esc(c.name)}</b> ${tags ? tags + ' ' : ''}${note}`;
}

function orderLine(o) {
  return (
    `📦 <code>${esc(o.order_no)}</code> ${esc(o.customer_name || '-')}｜${esc(o.product)}｜` +
    `<b>${core.fmtAmount(o.amount, o.currency)}</b>｜${esc(o.status)}｜${core.fmtDateTime(o.created_at)}`
  );
}

function createBot() {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('缺少 BOT_TOKEN');

  const bot = new Telegraf(token);

  // 中间件：建档 + 补发到期提醒
  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.chat && ctx.chat.type === 'private') {
      try {
        await db.upsertUser({
          telegramId: ctx.from.id,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
        });
        await reminders.flushDueFor(ctx.from.id, bot.telegram);
      } catch (e) {
        console.error('middleware error:', e.message);
      }
    }
    return next();
  });

  // ---- /start（含邀请裂变 ref_）----
  bot.start(async (ctx) => {
    try {
      const sp = ctx.startPayload || '';
      const user = await db.getUser(ctx.from.id);
      if (sp.startsWith('ref_')) {
        const inviter = Number(sp.slice(4));
        if (inviter && inviter !== ctx.from.id && user && !user.referrer_id) {
          await db.setReferrer(ctx.from.id, inviter);
          await db.applyReferral(inviter);
        }
      }
      const plan = user && user.plan === 'pro' ? 'Pro' : '免费版';
      await ctx.reply(
        `👋 欢迎使用 <b>TG客管家</b>！\n\n` +
          `我是你 Telegram 上的<b>客户订单管家</b>：记客户、管订单、跟进提醒，都在聊天里完成，不用切换任何 App。\n\n` +
          `当前套餐：<b>${plan}</b>\n\n` +
          `<b>3 步上手：</b>\n` +
          `1️⃣ 记客户：<code>/customer 添加 Lily #VIP 美国站大客户</code>\n` +
          `2️⃣ 记订单：<code>/order 添加 Lily 陶瓷马克杯×120 USD 2400</code>\n` +
          `3️⃣ 设跟进：<code>/remind Lily 3天 催款</code>\n\n` +
          `查看全部命令：<code>/help</code>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('📖 命令清单', 'help'),
              Markup.button.callback('⬆️ 升级 Pro', 'upgrade'),
            ],
          ]),
        }
      );
    } catch (e) {
      console.error('/start error', e.message);
      await ctx.reply('出错了，请稍后再试。').catch(() => {});
    }
  });

  bot.action('help', (ctx) => {
    ctx.answerCbQuery();
    return sendHelp(ctx);
  });
  bot.action('upgrade', (ctx) => {
    ctx.answerCbQuery();
    return sendUpgrade(ctx);
  });

  async function sendHelp(ctx) {
    await ctx.reply(
      `<b>📖 命令清单</b>\n\n` +
        `👤 <b>客户</b>\n` +
        `<code>/customer 添加 名字 #标签 备注</code>\n` +
        `<code>/tag 名字 #标签…</code>\n` +
        `<code>/note 名字 备注</code>\n` +
        `<code>/customers</code> 客户列表\n` +
        `<code>/search 关键词</code> 搜索\n\n` +
        `📦 <b>订单</b>\n` +
        `<code>/order 添加 客户名 商品 金额</code>\n` +
        `<code>/order 状态 单号 新状态</code>\n` +
        `<code>/orders 状态</code> 按状态筛选\n` +
        `<code>/order 单号</code> 订单详情\n\n` +
        `⏰ <b>提醒</b>\n` +
        `<code>/remind 客户名 N分钟|N小时|N天|日期 内容</code>\n` +
        `<code>/reminders</code> 待办提醒\n\n` +
        `📊 <b>统计 / 导出</b>\n` +
        `<code>/stats</code> 数据看板\n` +
        `<code>/export</code> 导出订单 CSV（Pro）\n\n` +
        `💰 <b>账户</b>\n` +
        `<code>/plan</code> 我的套餐\n` +
        `<code>/upgrade</code> 升级 Pro\n` +
        `<code>/redeem 兑换码</code> 用兑换码开通\n` +
        `<code>/invite</code> 邀请好友解锁额度`,
      { parse_mode: 'HTML' }
    );
  }
  bot.help((ctx) => sendHelp(ctx));

  // ---- 客户 ----
  bot.command('customer', async (ctx) => {
    try {
      const text = payload(ctx);
      if (!text) {
        return ctx.reply(
          '用法：<code>/customer 添加 名字 #标签 备注</code>\n例：<code>/customer 添加 Lily #VIP 美国站大客户</code>',
          { parse_mode: 'HTML' }
        );
      }
      if (!/^添加/.test(text)) {
        return ctx.reply('请以"添加"开头：<code>/customer 添加 …</code>', { parse_mode: 'HTML' });
      }
      const parsed = core.parseCustomerAdd(text);
      if (!parsed) {
        return ctx.reply('格式不对。示例：<code>/customer 添加 Lily #VIP 美国站大客户</code>', {
          parse_mode: 'HTML',
        });
      }
      const user = await db.getUser(ctx.from.id);
      const count = await db.countCustomers(ctx.from.id);
      const check = core.canCreate(user.plan, user.referral_bonus || 0, 'customers', count);
      if (!check.ok) {
        return ctx.reply(
          `⚠️ 免费版最多 ${check.limit} 个客户。升级 Pro 或邀请好友解锁额度。\n` +
            `<code>/upgrade</code> 升级 ｜ <code>/invite</code> 邀请`,
          { parse_mode: 'HTML' }
        );
      }
      const c = await db.addCustomer(ctx.from.id, parsed);
      const tags = (c.tags || []).map((t) => '#' + esc(t)).join(' ');
      await ctx.reply(
        `✅ 已记录客户 <b>${esc(c.name)}</b>\n${tags ? '标签：' + tags + '\n' : ''}` +
          `${c.note ? '备注：' + esc(c.note) + '\n' : ''}` +
          `（已用 ${count + 1}/${check.limit}）`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('/customer', e);
      await ctx.reply('保存失败：' + esc(e.message)).catch(() => {});
    }
  });

  bot.command('customers', async (ctx) => {
    try {
      const list = await db.listCustomers(ctx.from.id);
      if (!list.length) {
        return ctx.reply('还没有客户。用 <code>/customer 添加 …</code> 开始记录。', {
          parse_mode: 'HTML',
        });
      }
      const lines = list.map(customerLine);
      await ctx.reply(`👥 <b>客户列表（${list.length}）</b>\n\n` + lines.join('\n'), {
        parse_mode: 'HTML',
      });
    } catch (e) {
      await ctx.reply('查询失败：' + esc(e.message)).catch(() => {});
    }
  });

  bot.command('search', async (ctx) => {
    try {
      const q = payload(ctx);
      if (!q) return ctx.reply('用法：<code>/search 关键词</code>（匹配名字/标签/备注）', { parse_mode: 'HTML' });
      const list = await db.findCustomers(ctx.from.id, q);
      if (!list.length) return ctx.reply(`没有找到与 <b>${esc(q)}</b> 匹配的客户。`, { parse_mode: 'HTML' });
      const lines = list.map(customerLine);
      await ctx.reply(`🔍 <b>搜索"${esc(q)}"（${list.length}）</b>\n\n` + lines.join('\n'), {
        parse_mode: 'HTML',
      });
    } catch (e) {
      await ctx.reply('搜索失败：' + esc(e.message)).catch(() => {});
    }
  });

  bot.command('tag', async (ctx) => {
    try {
      const text = payload(ctx);
      const m = text.match(/^(\S+)\s+(.+)$/);
      if (!m) return ctx.reply('用法：<code>/tag 客户名 #标签1 #标签2</code>', { parse_mode: 'HTML' });
      const name = m[1];
      const newTags = (m[2].match(/#([^\s#]+)/g) || []).map((t) => t.slice(1));
      if (!newTags.length) return ctx.reply('请用 # 号加标签，如：<code>/tag Lily #VIP</code>', { parse_mode: 'HTML' });
      const found = await db.findCustomers(ctx.from.id, name);
      const c = found.find((x) => x.name === name);
      if (!c) return ctx.reply(`未找到客户 <b>${esc(name)}</b>`, { parse_mode: 'HTML' });
      const merged = Array.from(new Set([...(c.tags || []), ...newTags]));
      await db.addTags(ctx.from.id, name, merged);
      const tags = merged.map((t) => '#' + esc(t)).join(' ');
      await ctx.reply(`✅ <b>${esc(name)}</b> 标签：${tags}`, { parse_mode: 'HTML' });
    } catch (e) {
      await ctx.reply('操作失败：' + esc(e.message)).catch(() => {});
    }
  });

  bot.command('note', async (ctx) => {
    try {
      const text = payload(ctx);
      const m = text.match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) return ctx.reply('用法：<code>/note 客户名 备注内容</code>', { parse_mode: 'HTML' });
      const name = m[1];
      const found = await db.findCustomers(ctx.from.id, name);
      const c = found.find((x) => x.name === name);
      if (!c) return ctx.reply(`未找到客户 <b>${esc(name)}</b>`, { parse_mode: 'HTML' });
      await db.setNote(ctx.from.id, name, m[2].trim());
      await ctx.reply(`✅ 已更新 <b>${esc(name)}</b> 备注：${esc(m[2].trim())}`, { parse_mode: 'HTML' });
    } catch (e) {
      await ctx.reply('操作失败：' + esc(e.message)).catch(() => {});
    }
  });

  // ---- 订单 ----
  bot.command('order', async (ctx) => {
    try {
      const text = payload(ctx);
      if (!text) {
        return ctx.reply(
          '用法：\n<code>/order 添加 客户名 商品 金额</code> 新建\n<code>/order 状态 单号 新状态</code> 改状态\n<code>/order 单号</code> 查详情',
          { parse_mode: 'HTML' }
        );
      }
      if (/^添加/.test(text)) {
        const parsed = core.parseOrderAdd(text);
        if (!parsed) {
          return ctx.reply('格式不对。示例：<code>/order 添加 Lily 陶瓷马克杯×120 USD 2400</code>', {
            parse_mode: 'HTML',
          });
        }
        const user = await db.getUser(ctx.from.id);
        const count = await db.countOrders(ctx.from.id);
        const check = core.canCreate(user.plan, user.referral_bonus || 0, 'orders', count);
        if (!check.ok) {
          return ctx.reply(
            `⚠️ 免费版最多 ${check.limit} 笔订单。升级 Pro 或邀请好友解锁。\n` +
              `<code>/upgrade</code> ｜ <code>/invite</code>`,
            { parse_mode: 'HTML' }
          );
        }
        const seq = await db.nextOrderSeq(ctx.from.id);
        const orderNo = core.nextOrderNo(seq);
        const o = await db.addOrder(ctx.from.id, {
          orderNo,
          customerName: parsed.customer,
          product: parsed.product,
          amount: parsed.amount,
          currency: parsed.currency,
        });
        await ctx.reply(
          `✅ 订单已创建\n` +
            `单号：<code>${esc(o.order_no)}</code>\n` +
            `客户：${esc(o.customer_name)}\n` +
            `商品：${esc(o.product)}\n` +
            `金额：<b>${core.fmtAmount(o.amount, o.currency)}</b>\n` +
            `状态：待付款\n` +
            `（已用 ${count + 1}/${check.limit}）`,
          { parse_mode: 'HTML' }
        );
        return;
      }
      if (/^状态/.test(text)) {
        const parsed = core.parseStatusChange(text);
        if (!parsed) {
          return ctx.reply('用法：<code>/order 状态 单号 新状态</code>，可选状态：' + core.ORDER_STATUSES.join(' / '), {
            parse_mode: 'HTML',
          });
        }
        const o = await db.getOrder(ctx.from.id, parsed.orderNo);
        if (!o) return ctx.reply(`未找到订单 <code>${esc(parsed.orderNo)}</code>`, { parse_mode: 'HTML' });
        if (!core.isAllowedTransition(o.status, parsed.status)) {
          return ctx.reply(
            `⚠️ 不能从"${esc(o.status)}"变更为"${esc(parsed.status)}"。\n` +
              `可选：${(core.TRANSITIONS[o.status] || []).map(esc).join(' / ') || '（无）'}`,
            { parse_mode: 'HTML' }
          );
        }
        const updated = await db.updateOrderStatus(ctx.from.id, parsed.orderNo, parsed.status);
        await ctx.reply(
          `✅ <code>${esc(updated.order_no)}</code> 状态已更新：${esc(updated.status)}\n` +
            `商品：${esc(updated.product)}｜${core.fmtAmount(updated.amount, updated.currency)}`,
          { parse_mode: 'HTML' }
        );
        return;
      }
      // 订单详情
      const o = await db.getOrder(ctx.from.id, text);
      if (!o) return ctx.reply(`未找到订单 <code>${esc(text)}</code>`, { parse_mode: 'HTML' });
      await ctx.reply(
        `📦 <b>订单详情</b>\n` +
          `单号：<code>${esc(o.order_no)}</code>\n` +
          `客户：${esc(o.customer_name || '-')}\n` +
          `商品：${esc(o.product)}\n` +
          `金额：<b>${core.fmtAmount(o.amount, o.currency)}</b>\n` +
          `状态：${esc(o.status)}\n` +
          `创建：${core.fmtDateTime(o.created_at)}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('/order', e);
      await ctx.reply('操作失败：' + esc(e.message)).catch(() => {});
    }
  });

  bot.command('orders', async (ctx) => {
    try {
      const status = payload(ctx);
      const valid = core.ORDER_STATUSES.includes(status) ? status : null;
      if (status && !valid) {
        return ctx.reply('可选状态：' + core.ORDER_STATUSES.join(' / '), { parse_mode: 'HTML' });
      }
      const list = await db.listOrders(ctx.from.id, valid);
      if (!list.length) {
        return ctx.reply(valid ? `没有"${esc(valid)}"状态的订单。` : '还没有订单。用 <code>/order 添加 …</code> 创建。', {
          parse_mode: 'HTML',
        });
      }
      const lines = list.map(orderLine);
      await ctx.reply(`📦 <b>${valid ? '「' + esc(valid) + '」' : '全部'}订单（${list.length}）</b>\n\n` + lines.join('\n'), {
        parse_mode: 'HTML',
      });
    } catch (e) {
      await ctx.reply('查询失败：' + esc(e.message)).catch(() => {});
    }
  });

  // ---- 提醒 ----
  bot.command('remind', async (ctx) => {
    try {
      const parsed = core.parseRemind('/remind ' + payload(ctx));
      if (!parsed) {
        return ctx.reply(
          '用法：<code>/remind 客户名 N分钟|N小时|N天|YYYY-MM-DD 内容</code>\n例：<code>/remind Lily 3天 催款</code>',
          { parse_mode: 'HTML' }
        );
      }
      const user = await db.getUser(ctx.from.id);
      const count = await db.countReminders(ctx.from.id);
      const check = core.canCreate(user.plan, user.referral_bonus || 0, 'reminders', count);
      if (!check.ok) {
        return ctx.reply(
          `⚠️ 免费版最多 ${check.limit} 条提醒。升级 Pro 或邀请好友解锁。\n<code>/upgrade</code> ｜ <code>/invite</code>`,
          { parse_mode: 'HTML' }
        );
      }
      const r = await db.addReminder(ctx.from.id, parsed);
      await ctx.reply(
        `⏰ 已设置提醒\n客户：${esc(parsed.customer)}\n内容：${esc(parsed.content)}\n时间：${core.fmtDateTime(r.remind_at)}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      await ctx.reply('设置失败：' + esc(e.message)).catch(() => {});
    }
  });

  bot.command('reminders', async (ctx) => {
    try {
      const list = await db.listReminders(ctx.from.id);
      if (!list.length) return ctx.reply('当前没有待办提醒。');
      const lines = list.map((r, i) => {
        const btn = Markup.button.callback('✅ 完成', 'done:' + r.id);
        return `${i + 1}. ${esc(r.content)}（${esc(r.customer_name || '客户')}）→ ${core.fmtDateTime(r.remind_at)}`;
      });
      // 逐条带完成按钮
      await ctx.reply(`⏰ <b>待办提醒（${list.length}）</b>`, { parse_mode: 'HTML' });
      for (const r of list) {
        await ctx.reply(
          `• ${esc(r.content)}\n客户：${esc(r.customer_name || '-')}\n时间：${core.fmtDateTime(r.remind_at)}`,
          { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ 已完成', 'done:' + r.id)]]) }
        ).catch(() => {});
      }
    } catch (e) {
      await ctx.reply('查询失败：' + esc(e.message)).catch(() => {});
    }
  });

  bot.action(/^done:(\d+)/, async (ctx) => {
    try {
      const id = Number(ctx.match[1]);
      await db.markReminderDone(id);
      await ctx.answerCbQuery('已标记完成 ✅');
      await ctx.editMessageText('✅ 已完成的提醒').catch(() => {});
    } catch (e) {
      await ctx.answerCbQuery('操作失败').catch(() => {});
    }
  });

  // ---- 统计 / 导出 ----
  bot.command('stats', async (ctx) => {
    try {
      const s = await db.orderStats(ctx.from.id);
      const ccount = await db.countCustomers(ctx.from.id);
      const activeMoney = core.fmtAmount(s.activeAmount, 'USD');
      const risk = ['待付款', '待发货', '已发货']
        .filter((k) => s.slugCount[k] > 0)
        .map((k) => `${k}${s.slugCount[k]}单`)
        .join('、');
      await ctx.reply(
        `📊 <b>数据看板</b>\n\n` +
          `👥 客户：<b>${ccount}</b>\n` +
          `📦 订单：<b>${s.total}</b>（进行中 ${s.activeCount}）\n` +
          `💰 进行中金额：<b>${activeMoney}</b>\n\n` +
          `— 状态分布 —\n` +
          core.ORDER_STATUSES.map((k) => `· ${k}：${s.byStatus[k] || 0}`).join('\n') +
          (risk ? `\n\n⚠️ 停留超 7 天待跟进：${esc(risk)}` : '\n\n✅ 暂无超期订单') +
          `\n\n<code>/export</code> 导出 CSV（Pro）`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      await ctx.reply('统计失败：' + esc(e.message)).catch(() => {});
    }
  });

  bot.command('export', async (ctx) => {
    try {
      const user = await db.getUser(ctx.from.id);
      if (!core.planLimits(user.plan).exportCsv) {
        return ctx.reply('CSV 导出是 Pro 功能。\n<code>/upgrade</code> 升级后可用。', { parse_mode: 'HTML' });
      }
      const list = await db.listOrders(ctx.from.id, null);
      const head = '订单号,客户,商品,金额,币种,状态,创建时间\n';
      const rows = list
        .map((o) =>
          [o.order_no, o.customer_name || '', o.product, o.amount, o.currency, o.status, o.created_at]
            .map((v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"')
            .join(',')
        )
        .join('\n');
      await ctx.replyWithDocument(
        { source: Buffer.from('\uFEFF' + head + rows, 'utf8'), filename: 'orders.csv' },
        { caption: `已导出 ${list.length} 笔订单` }
      );
    } catch (e) {
      await ctx.reply('导出失败：' + esc(e.message)).catch(() => {});
    }
  });

  // ---- 套餐 / 升级 / 邀请 ----
  async function sendUpgrade(ctx) {
    const user = await db.getUser(ctx.from.id).catch(() => null);
    const plan = user ? user.plan : 'free';
    if (plan === 'pro') {
      return ctx.reply(
        `✅ 你已是 <b>Pro</b>（有效期至 ${user.plan_until ? String(user.plan_until).slice(0, 10) : '—'}）`,
        { parse_mode: 'HTML' }
      );
    }
    await ctx.reply(
      `⬆️ <b>升级 Pro</b>\n\n` +
        `免费版：20 客户 / 30 订单 / 5 提醒\n` +
        `Pro：2000 客户 / 5000 订单 / 200 提醒 ＋ CSV 导出\n\n` +
        `· 月度：300 Stars（≈¥21/月）\n` +
        `· 年度：2900 Stars（≈¥200/年，8 折）\n\n` +
        `支付走 Telegram Stars，即时到账；如你的地区 Stars 不可用，可联系作者获取<b>兑换码</b>，发送 <code>/redeem 兑换码</code> 开通。`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💎 Pro 月度 300★', 'pay:month')],
          [Markup.button.callback('💎 Pro 年度 2900★', 'pay:year')],
        ]),
      }
    );
  }

  bot.command('upgrade', (ctx) => sendUpgrade(ctx));
  bot.action('pay:month', async (ctx) => {
    await ctx.answerCbQuery('正在发起支付…').catch(() => {});
    try {
      await payments.sendUpgradeInvoice(ctx, 'month');
    } catch (e) {
      await ctx
        .reply('Stars 支付暂不可用（可能为地区限制）。可联系作者获取兑换码，发送 <code>/redeem 兑换码</code> 开通。', {
          parse_mode: 'HTML',
        })
        .catch(() => {});
    }
  });
  bot.action('pay:year', async (ctx) => {
    await ctx.answerCbQuery('正在发起支付…').catch(() => {});
    try {
      await payments.sendUpgradeInvoice(ctx, 'year');
    } catch (e) {
      await ctx
        .reply('Stars 支付暂不可用（可能为地区限制）。可联系作者获取兑换码，发送 <code>/redeem 兑换码</code> 开通。', {
          parse_mode: 'HTML',
        })
        .catch(() => {});
    }
  });

  bot.command('plan', async (ctx) => {
    try {
      const user = await db.getUser(ctx.from.id);
      const plan = user.plan === 'pro' ? 'Pro' : '免费版';
      const bonus = user.referral_bonus || 0;
      const limits = core.planLimits(user.plan);
      const eff = {
        customers: limits.customers + bonus,
        orders: limits.orders + bonus,
        reminders: limits.reminders + bonus,
      };
      await ctx.reply(
        `💰 <b>我的套餐</b>\n\n` +
          `套餐：<b>${plan}</b>${user.plan === 'pro' && user.plan_until ? `（至 ${String(user.plan_until).slice(0, 10)}）` : ''}\n` +
          `邀请奖励额度：+${bonus}\n\n` +
          `额度：客户 ${eff.customers}｜订单 ${eff.orders}｜提醒 ${eff.reminders}\n` +
          `CSV 导出：${limits.exportCsv ? '✅' : '❌（Pro）'}\n\n` +
          `<code>/upgrade</code> 升级 ｜ <code>/invite</code> 邀请好友`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      await ctx.reply('查询失败：' + esc(e.message)).catch(() => {});
    }
  });

  bot.command('invite', async (ctx) => {
    try {
      const username = ctx.botInfo && ctx.botInfo.username;
      const link = `https://t.me/${username}?start=ref_${ctx.from.id}`;
      await ctx.reply(
        `🤝 <b>邀请好友，解锁额度</b>\n\n` +
          `每邀请 1 位好友通过你的链接使用，你的客户/订单/提醒额度各 <b>+10</b>。\n\n` +
          `你的专属链接：\n<code>${esc(link)}</code>\n\n` +
          `直接发给好友或发到群里即可。`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      await ctx.reply('生成链接失败：' + esc(e.message)).catch(() => {});
    }
  });

  // ---- 兑换码收款（Stars 不可用地区的替代方案）----
  // 管理员生成兑换码：/gencode 30  → 30 天 Pro 兑换码
  bot.command('gencode', async (ctx) => {
    try {
      if (!OWNER_ID || ctx.from.id !== OWNER_ID) {
        return ctx.reply('仅管理员可生成兑换码。').catch(() => {});
      }
      const days = Number(payload(ctx) || 30);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        return ctx.reply('天数无效（1-3650）。用法：<code>/gencode 30</code>', { parse_mode: 'HTML' });
      }
      const code = core.generateCode();
      await db.createActivationCode({ code, durationDays: days, createdBy: ctx.from.id });
      await ctx.reply(
        `已生成 <b>${days} 天 Pro</b> 兑换码：\n<code>${code}</code>\n\n` +
          `发给用户，让他发送 <code>/redeem ${code}</code> 即可开通。`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('/gencode', e);
      await ctx.reply('生成失败：' + esc(e.message)).catch(() => {});
    }
  });

  // 查看已生成的兑换码及使用状态：/codes
  bot.command('codes', async (ctx) => {
    try {
      if (!OWNER_ID || ctx.from.id !== OWNER_ID) return ctx.reply('仅管理员可用。').catch(() => {});
      const list = await db.listActivationCodes(ctx.from.id);
      if (!list.length) return ctx.reply('还没有生成过兑换码。用 <code>/gencode 30</code> 生成。', { parse_mode: 'HTML' });
      const lines = list.map((c) => {
        const state = c.used_by ? `已用（${c.used_at ? String(c.used_at).slice(0, 10) : ''}）` : '未使用';
        return `<code>${esc(c.code)}</code> ${c.duration_days}天 · ${state}`;
      });
      await ctx.reply(`🎟️ <b>兑换码（${list.length}）</b>\n\n` + lines.join('\n'), { parse_mode: 'HTML' });
    } catch (e) {
      await ctx.reply('查询失败：' + esc(e.message)).catch(() => {});
    }
  });

  // 用户兑换：/redeem CODE
  bot.command('redeem', async (ctx) => {
    try {
      const code = payload(ctx).trim().toUpperCase();
      if (!code) return ctx.reply('用法：<code>/redeem 兑换码</code>', { parse_mode: 'HTML' });
      const rec = await db.getActivationCode(code);
      if (!rec) return ctx.reply('兑换码不存在或格式错误。');
      if (rec.used_by) return ctx.reply('该兑换码已被使用。');
      const used = await db.useActivationCode(code, ctx.from.id);
      if (!used) return ctx.reply('该兑换码已被使用。');
      const until = new Date(Date.now() + rec.duration_days * 86400000);
      await db.setPlan(ctx.from.id, 'pro', until);
      await ctx.reply(
        `✅ 兑换成功！已开通 <b>Pro</b>（${rec.duration_days} 天）。\n有效期至：${until.toISOString().slice(0, 10)}\n现在可享受全部额度与导出。`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('/redeem', e);
      await ctx.reply('兑换失败：' + esc(e.message)).catch(() => {});
    }
  });

  // ---- 支付事件 ----
  bot.on('pre_checkout_query', (ctx) => payments.onPreCheckout(ctx));
  bot.on('successful_payment', (ctx) => payments.onSuccessfulPayment(ctx));

  // 兜底
  bot.on('message', (ctx) => {
    if (ctx.chat && ctx.chat.type === 'private' && ctx.message && ctx.message.text) {
      const t = ctx.message.text;
      if (!t.startsWith('/')) {
        return ctx.reply('发送 <code>/help</code> 查看命令清单。', { parse_mode: 'HTML' });
      }
    }
  });

  return bot;
}

module.exports = { createBot };
