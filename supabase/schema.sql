-- ============================================================
-- TG客管家 · Supabase / PostgreSQL 数据库结构
-- 在 Supabase SQL Editor 中一次性执行
-- ============================================================

-- 用户
create table if not exists users (
  telegram_id    bigint primary key,
  username       text,
  first_name     text,
  plan           text not null default 'free',            -- free | pro
  plan_until     timestamptz,
  referrer_id    bigint,
  referral_bonus int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 客户
create table if not exists customers (
  id         bigserial primary key,
  owner_id   bigint not null references users(telegram_id) on delete cascade,
  name       text not null,
  tg_username text,
  tg_user_id bigint,
  tags       text[] not null default '{}',
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

-- 订单
create table if not exists orders (
  id                bigserial primary key,
  order_no          text not null,
  owner_id          bigint not null references users(telegram_id) on delete cascade,
  customer_id       bigint references customers(id) on delete set null,
  customer_name     text,
  product           text not null,
  amount            numeric(12,2),
  currency          text not null default 'USD',
  status            text not null default '待付款',   -- 待付款/待发货/已发货/已完成/已取消
  status_changed_at timestamptz not null default now(),
  follow_up_date    date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (owner_id, order_no)
);

-- 提醒
create table if not exists reminders (
  id            bigserial primary key,
  owner_id      bigint not null references users(telegram_id) on delete cascade,
  customer_id   bigint references customers(id) on delete set null,
  customer_name text,
  content       text,
  remind_at     timestamptz not null,
  done          boolean not null default false,
  created_at    timestamptz not null default now()
);

-- 订单号计数器（原子自增）
create table if not exists counters (
  owner_id  bigint primary key references users(telegram_id) on delete cascade,
  order_seq int not null default 0
);

-- 兑换码（Stars 不可用地区的替代收款）
create table if not exists activation_codes (
  code          text primary key,
  duration_days int not null,
  created_by    bigint not null references users(telegram_id) on delete cascade,
  used_by       bigint,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);

-- 客户消息时间线（转发即归档 / 随手记）
create table if not exists messages (
  id          bigint generated always as identity primary key,
  owner_id    bigint not null references users(telegram_id) on delete cascade,
  customer_id bigint references customers(id) on delete set null,
  text        text,
  kind        text not null default 'forward',
  created_at  timestamptz not null default now()
);
create index if not exists idx_messages_owner on messages(owner_id, created_at desc);
create index if not exists idx_messages_customer on messages(customer_id, created_at desc);

-- 每日待办摘要发送记录（避免一天重复推送）
alter table users add column if not exists last_digest_date date;
alter table users add column if not exists last_weekly_date date;

-- 原子获取下一订单序号
create or replace function next_order_seq(p_owner bigint)
returns int language plpgsql as $$
declare v int;
begin
  insert into counters(owner_id, order_seq) values (p_owner, 1)
    on conflict (owner_id) do update set order_seq = counters.order_seq + 1
    returning order_seq into v;
  return v;
end $$;

-- 增加邀请奖励额度
create or replace function bump_referral_bonus(p_owner bigint, p_inc int)
returns int language plpgsql as $$
declare v int;
begin
  update users set referral_bonus = referral_bonus + p_inc
    where telegram_id = p_owner
    returning referral_bonus into v;
  return coalesce(v, 0);
end $$;

-- 索引
create index if not exists idx_customers_owner on customers(owner_id);
create index if not exists idx_orders_owner on orders(owner_id);
create index if not exists idx_orders_owner_status on orders(owner_id, status);
create index if not exists idx_reminders_due on reminders(remind_at) where done = false;

-- ============================================================
-- RLS：默认锁死公网，仅服务器端 service_role 可读写
-- ============================================================
alter table users     enable row level security;
alter table customers enable row level security;
alter table orders    enable row level security;
alter table reminders enable row level security;
alter table counters  enable row level security;
alter table activation_codes enable row level security;
alter table messages enable row level security;

-- 服务端通过 service_role key 绕过 RLS；公网 anon 一律拒绝
drop policy if exists "deny anon all users"     on users;
create policy "deny anon all users"     on users     for all using (false) with check (false);
drop policy if exists "deny anon all customers" on customers;
create policy "deny anon all customers" on customers for all using (false) with check (false);
drop policy if exists "deny anon all orders" on orders;
create policy "deny anon all orders"    on orders    for all using (false) with check (false);
drop policy if exists "deny anon all reminders" on reminders;
create policy "deny anon all reminders" on reminders for all using (false) with check (false);
drop policy if exists "deny anon all counters" on counters;
create policy "deny anon all counters"  on counters  for all using (false) with check (false);
drop policy if exists "deny anon all activation_codes" on activation_codes;
create policy "deny anon all activation_codes" on activation_codes for all using (false) with check (false);
drop policy if exists "deny anon all messages" on messages;
create policy "deny anon all messages" on messages for all using (false) with check (false);
