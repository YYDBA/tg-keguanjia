# TG客管家 · 部署指南

> 跨境/外贸卖家的 Telegram 客户·订单管理 Bot。零资金部署：Vercel 免费层 + Supabase 免费层 + Telegram Stars 收款。

---

## 目录
1. [你需要准备的 3 个账号](#1-需要准备的-3-个账号)
2. [第一步：创建 Telegram Bot](#2-第一步创建-telegram-bot)
3. [第二步：创建数据库](#3-第二步创建数据库)
4. [第三步：部署到 Vercel](#4-第三步部署到-vercel)
5. [第四步：设置 Webhook 与提醒](#5-第四步设置-webhook-与提醒)
6. [本地开发调试](#6-本地开发调试)
7. [功能与命令](#7-功能与命令)
8. [常见问题排查](#8-常见问题排查)

---

## 1. 你需要准备的 3 个账号

| # | 平台 | 做什么 | 费用 |
|---|------|--------|------|
| 1 | Telegram | 创建 Bot（@BotFather）拿 Token | ¥0 |
| 2 | Supabase | 建数据库，执行 `supabase/schema.sql` | ¥0（免费层） |
| 3 | Vercel | 部署代码，设置环境变量 | ¥0（免费层，需 GitHub 账号） |

> 提醒：数据库密钥与 Bot Token 属于敏感信息，仅填入服务器环境变量，**不要**提交到 Git / 发到群里。

---

## 2. 第一步：创建 Telegram Bot

1. 在 Telegram 搜索 **@BotFather**，发送 `/newbot`。
2. 按提示输入 Bot 名称（如「TG客管家」）和用户名（如 `yourname_keguanjia_bot`，全局唯一，建议含 `bot` 结尾）。
3. BotFather 会返回 **Token**（形如 `123456:ABC-DEF...`），保存好。
4. 在 @BotFather 里：
   - `/setdescription` 写一句产品说明（会出现在搜索/预览里）；
   - `/setabouttext` 写简介；
   - `/setuserpic` 上传头像；
   - `/setcommands` 一次性粘贴：
     ```
     start - 开始使用
     customer - 添加客户
     customers - 客户列表
     search - 搜索客户
     tag - 打标签
     note - 加备注
     order - 添加/变更订单
     orders - 订单列表
     remind - 设置跟进提醒
     reminders - 待办提醒
     stats - 数据看板
     export - 导出CSV
     upgrade - 升级Pro
     plan - 我的套餐
     invite - 邀请好友
     help - 命令清单
     ```
5. **开启 Stars 收款（可选）**：@BotFather → `/mybots` → 选择你的 Bot → **Payments** → 选择 **Telegram Stars**。这样 bot 才能发 Stars 发票。（Stars 支付由 Telegram 托管，无需营业执照、无需支付通道。）
   > **若 Payments 里没有 "Telegram Stars" 选项**：这是账号地区限制（中国大陆区域不开放 Stars，换 VPN 也没用）。**不影响上线**——本项目已内置"兑换码"收款：管理员用 `/gencode` 生成兑换码发给用户，用户 `/redeem` 即开通 Pro。记得在 `.env` 配 `OWNER_ID`（用 @userinfobot 查你的数字 id）。

---

## 3. 第二步：创建数据库

1. 打开 [supabase.com](https://supabase.com) → 注册 → **New Project**（免费层），记下项目密码。
2. 进入项目 → **SQL Editor** → 把 [`supabase/schema.sql`](supabase/schema.sql) 全部内容粘贴执行（会建表、函数、索引、RLS）。
3. 进入左下角 **Project Settings（齿轮）→ API Keys**，复制：
   - `Project URL` → 填到环境变量 `SUPABASE_URL`
   - `Secret keys`（`sb_secret_...`，服务端全权密钥）→ 填到环境变量 `SUPABASE_SECRET_KEY`
     （旧版 `service_role` JWT 亦兼容 `SUPABASE_SERVICE_ROLE_KEY`，但官方 2026 年底将删除旧密钥，建议直接用新格式）

---

## 4. 第三步：部署到 Vercel

1. 把本项目推到一个 GitHub 仓库（或直接 `vercel` 上传）。
2. 打开 [vercel.com](https://vercel.com) → **Import Project** → 选择该仓库。
3. 框架预设选 **Other**，构建命令留空，输出目录留空。
4. 在 **Environment Variables** 添加：
   ```
   BOT_TOKEN=<第2步的Token>
   SUPABASE_URL=<第3步的Project URL>
   SUPABASE_SECRET_KEY=<第3步的sb_secret_...密钥>
   OWNER_ID=<你的数字id，可选，用于生成兑换码>
   ```
5. **Deploy**，等部署完成，得到域名如 `https://your-app.vercel.app`。

---

## 5. 第四步：设置 Webhook 与提醒

部署完成后执行（可用浏览器打开，或本地 `curl`）：

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://your-app.vercel.app/api/webhook
```

返回 `{"ok":true}` 即成功。此时私聊你的 bot，发 `/start` 应收到欢迎语。

**到期提醒推送**（Vercel 免费层没有 cron，用一个免费外部定时器）：

1. 打开 [cron-job.org](https://cron-job.org) → 注册（免费）。
2. 新建 Cron Job：
   - URL：`https://your-app.vercel.app/api/tick`
   - 间隔：**15 分钟**（如 `*/15 * * * *`）
3. 保存并启用。之后每到提醒时间，bot 会私聊推送。

> 兜底机制：用户每次和 bot 互动时，也会顺带补发其到期提醒，双保险。

---

## 6. 本地开发调试

```bash
cd sellerbot
npm install
copy .env.example .env      # Windows；mac/linux 用 cp
# 编辑 .env 填入 BOT_TOKEN / SUPABASE_URL / SUPABASE_SECRET_KEY
npm run dev                 # 长轮询模式，无需 webhook
```

改完代码想跑测试：

```bash
npm test        # 核心逻辑单元测试
npm run check   # 全文件语法检查
```

---

## 7. 功能与命令

| 模块 | 命令 | 说明 |
|------|------|------|
| 客户 | `/customer 添加 名字 #标签 备注` | 记录客户 |
| 客户 | `/customers` `/search 词` `/tag` `/note` | 列表 / 搜索 / 标签 / 备注 |
| 订单 | `/order 添加 客户 商品 金额` | 新建订单（自动编号 KJ-xxxx） |
| 订单 | `/order 状态 单号 新状态` | 状态机流转 |
| 订单 | `/orders 状态` `/order 单号` | 筛选 / 详情 |
| 提醒 | `/remind 客户 N天|日期 内容` | 跟进提醒 |
| 提醒 | `/reminders` | 待办（可点完成） |
| 统计 | `/stats` | 看板（含超期风险） |
| 导出 | `/export` | 订单 CSV（Pro） |
| 账户 | `/upgrade` `/plan` `/invite` `/redeem 码` | 升级（Stars/兑换码）/ 套餐 / 邀请解锁 |
| 管理 | `/gencode 天数` `/codes` | 管理员生成/查看兑换码（需 OWNER_ID） |

**免费 / Pro：** 免费 20 客户 / 30 订单 / 5 提醒；Pro 月度 300 Stars / 年度 2900 Stars（或使用兑换码 /redeem），解锁 2000 客户 / 5000 订单 / 200 提醒 + CSV。

---

## 8. 常见问题排查

| 现象 | 原因 / 解决 |
|------|-----------|
| `/start` 无反应 | webhook 未设置成功；用 setWebhook 接口重设，或 `getWebhookInfo` 查看 |
| 提示"缺少环境变量" | Vercel 环境变量没填或部署后未重新部署 |
| Stars 发票发不出去 | 地区限制导致 Stars 不可用 → 改用兑换码：`/gencode` 生成，用户 `/redeem` 开通；或换支持地区的账号启用 Stars |
| 提醒不推送 | 检查 cron-job.org 是否在跑、`/api/tick` 是否返回 200 |
| 数据库报错 | `supabase/schema.sql` 是否已完整执行；`SUPABASE_SECRET_KEY`（sb_secret_...）是否填对 |
| 中文乱码导出 | CSV 已带 UTF-8 BOM，Excel 打开即正常 |

---

## 风险与合规提示
- 产品面向海外/跨境场景，请勿在国内大陆宣传运营（Telegram 需网络环境支持）。
- Stars 收入按 Telegram 规则结算（21 天窗口），个人可提现到 TON 钱包。
- 仅作为个人效率工具使用，不涉及任何灰产/黑产功能。
