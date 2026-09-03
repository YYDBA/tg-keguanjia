'use strict';

// ============================================================
// TG客管家 · 数据访问层（Supabase / PostgreSQL）
// 服务器端使用 SERVICE_ROLE key，可绕过 RLS（RLS 用于锁死公网）
// ============================================================

const { createClient } = require('@supabase/supabase-js');

let _db = null;

function getDb() {
  if (_db) return _db;
  const url = process.env.SUPABASE_URL;
  // 优先官方新格式密钥（sb_secret_...），旧名 SUPABASE_SERVICE_ROLE_KEY 兼容
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('缺少 SUPABASE_URL 或 SUPABASE_SECRET_KEY（旧名 SUPABASE_SERVICE_ROLE_KEY 亦兼容）');
  }
  _db = createClient(url, key, { auth: { persistSession: false } });
  return _db;
}

// ---- 用户 ----
async function upsertUser({ telegramId, username, firstName }) {
  const { data, error } = await getDb()
    .from('users')
    .upsert(
      {
        telegram_id: telegramId,
        username: username || null,
        first_name: firstName || null,
      },
      { onConflict: 'telegram_id', ignoreDuplicates: false }
    )
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function getUser(telegramId) {
  const { data, error } = await getDb()
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function setPlan(telegramId, plan, planUntil) {
  const { data, error } = await getDb()
    .from('users')
    .update({ plan, plan_until: planUntil ? planUntil.toISOString() : null })
    .eq('telegram_id', telegramId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function applyReferral(referrerId) {
  // 推荐人 +10 客户额度
  const { data, error } = await getDb()
    .rpc('bump_referral_bonus', { p_owner: referrerId, p_inc: 10 });
  if (error) throw error;
  return data;
}

async function setReferrer(telegramId, referrerId) {
  const { data, error } = await getDb()
    .from('users')
    .update({ referrer_id: referrerId })
    .eq('telegram_id', telegramId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

// ---- 客户 ----
async function countCustomers(ownerId) {
  const { count, error } = await getDb()
    .from('customers')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', ownerId);
  if (error) throw error;
  return count || 0;
}

async function addCustomer(ownerId, { name, tags, note }) {
  const { data, error } = await getDb()
    .from('customers')
    .insert({
      owner_id: ownerId,
      name,
      tags: tags || [],
      note: note || null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function findCustomers(ownerId, query) {
  const q = query.trim();
  const db = getDb();
  let builder = db
    .from('customers')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (q) {
    builder = builder.or(`name.ilike.%${q}%,note.ilike.%${q}%,tags.cs.{${q}}`);
  }
  const { data, error } = await builder;
  if (error) throw error;
  return data || [];
}

async function listCustomers(ownerId) {
  const { data, error } = await getDb()
    .from('customers')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data || [];
}

async function addTags(ownerId, name, tags) {
  const { data, error } = await getDb()
    .from('customers')
    .update({ tags, updated_at: new Date().toISOString() })
    .eq('owner_id', ownerId)
    .eq('name', name)
    .select('*')
    .single();
  if (error) throw error;
  return data || null;
}

async function setNote(ownerId, name, note) {
  const { data, error } = await getDb()
    .from('customers')
    .update({ note, updated_at: new Date().toISOString() })
    .eq('owner_id', ownerId)
    .eq('name', name)
    .select('*')
    .single();
  if (error) throw error;
  return data || null;
}

// ---- 订单 ----
async function countOrders(ownerId) {
  const { count, error } = await getDb()
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', ownerId);
  if (error) throw error;
  return count || 0;
}

async function nextOrderSeq(ownerId) {
  const { data, error } = await getDb().rpc('next_order_seq', {
    p_owner: ownerId,
  });
  if (error) throw error;
  return data;
}

async function addOrder(ownerId, { orderNo, customerName, product, amount, currency }) {
  const { data, error } = await getDb()
    .from('orders')
    .insert({
      owner_id: ownerId,
      order_no: orderNo,
      customer_name: customerName,
      product,
      amount,
      currency: currency || 'USD',
      status: '待付款',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function getOrder(ownerId, orderNo) {
  const { data, error } = await getDb()
    .from('orders')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('order_no', orderNo)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function updateOrderStatus(ownerId, orderNo, status) {
  const { data, error } = await getDb()
    .from('orders')
    .update({ status, status_changed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('owner_id', ownerId)
    .eq('order_no', orderNo)
    .select('*')
    .single();
  if (error) throw error;
  return data || null;
}

async function listOrders(ownerId, status) {
  let builder = getDb()
    .from('orders')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (status) builder = builder.eq('status', status);
  const { data, error } = await builder;
  if (error) throw error;
  return data || [];
}

async function orderStats(ownerId) {
  const { data, error } = await getDb()
    .from('orders')
    .select('status, amount, currency, status_changed_at, created_at')
    .eq('owner_id', ownerId)
    .limit(5000);
  if (error) throw error;
  const rows = data || [];
  const byStatus = {};
  for (const s of ['待付款', '待发货', '已发货', '已完成', '已取消']) byStatus[s] = 0;
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  // 活跃金额（未完成/未取消）
  let activeAmount = 0;
  let activeCount = 0;
  const slugCount = { '待付款': 0, '待发货': 0, '已发货': 0 };
  const now = Date.now();
  for (const r of rows) {
    if (r.status !== '已完成' && r.status !== '已取消') {
      activeCount++;
      activeAmount += Number(r.amount || 0);
    }
    if (r.status in slugCount) {
      const ref = r.status_changed_at || r.created_at;
      const days = (now - new Date(ref).getTime()) / 86400000;
      if (days >= 7) slugCount[r.status]++;
    }
  }
  return { total: rows.length, byStatus, activeCount, activeAmount, slugCount };
}

// ---- 提醒 ----
async function countReminders(ownerId) {
  const { count, error } = await getDb()
    .from('reminders')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', ownerId)
    .eq('done', false);
  if (error) throw error;
  return count || 0;
}

async function addReminder(ownerId, { customerName, content, remindAt }) {
  const { data, error } = await getDb()
    .from('reminders')
    .insert({
      owner_id: ownerId,
      customer_name: customerName,
      content,
      remind_at: remindAt.toISOString(),
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function listReminders(ownerId) {
  const { data, error } = await getDb()
    .from('reminders')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('done', false)
    .order('remind_at', { ascending: true })
    .limit(50);
  if (error) throw error;
  return data || [];
}

async function markReminderDone(id) {
  const { data, error } = await getDb()
    .from('reminders')
    .update({ done: true })
    .eq('id', id)
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

async function scanDueForOwner(ownerId, now) {
  const { data, error } = await getDb()
    .from('reminders')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('done', false)
    .lte('remind_at', now.toISOString())
    .limit(20);
  if (error) throw error;
  return data || [];
}

async function scanDueAll(now) {
  const { data, error } = await getDb()
    .from('reminders')
    .select('*')
    .eq('done', false)
    .lte('remind_at', now.toISOString())
    .limit(200);
  if (error) throw error;
  return data || [];
}

// ---- 兑换码（Stars 不可用地区的替代收款） ----
async function createActivationCode({ code, durationDays, createdBy }) {
  const { data, error } = await getDb()
    .from('activation_codes')
    .insert({ code, duration_days: durationDays, created_by: createdBy })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function getActivationCode(code) {
  const { data, error } = await getDb()
    .from('activation_codes')
    .select('*')
    .eq('code', code)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// 仅在未被使用的情况下占用（防并发/防重复兑换）
async function useActivationCode(code, userId) {
  const { data, error } = await getDb()
    .from('activation_codes')
    .update({ used_by: userId, used_at: new Date().toISOString() })
    .eq('code', code)
    .is('used_by', null)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function listActivationCodes(createdBy) {
  const { data, error } = await getDb()
    .from('activation_codes')
    .select('*')
    .eq('created_by', createdBy)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data || [];
}

module.exports = {
  getDb,
  upsertUser,
  getUser,
  setPlan,
  applyReferral,
  setReferrer,
  countCustomers,
  addCustomer,
  findCustomers,
  listCustomers,
  addTags,
  setNote,
  countOrders,
  nextOrderSeq,
  addOrder,
  getOrder,
  updateOrderStatus,
  listOrders,
  orderStats,
  countReminders,
  addReminder,
  listReminders,
  markReminderDone,
  scanDueForOwner,
  scanDueAll,
  createActivationCode,
  getActivationCode,
  useActivationCode,
  listActivationCodes,
};
