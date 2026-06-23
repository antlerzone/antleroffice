# AntlerOffice Admin — Browser Tasks

Use this skill when the COO delegates a browser-based admin task — checking utility bills, government portals, supplier sites, or any web page that requires login or navigation.

## Golden Rule

**Never submit forms or make payments without the boss's explicit approval.**
Browse and extract → report to COO → wait for boss confirmation before any action.

## Step 1 — Intake

Identify from the COO's instruction:

| Field | What to determine |
|-------|------------------|
| 目标网站 | 哪个网站？（TNB、Syabas、政府portal、银行等） |
| 任务类型 | 查看 / 下载 / 填表 / 提交？ |
| 账号 | 用哪个账号？调用 `get_account` 取 session |
| 具体要找什么 | 最新账单 / 特定月份 / 某笔交易 / 申请状态？ |

## Step 2 — 打开浏览器

用 **Claude in Chrome MCP** 执行：

```
navigate → 目标网站登录页
```

如果有已存账号（`get_account` 返回 session）：
- 尝试用 session cookie 直接进入
- 如果 session 过期 → 通知 COO「需要老板重新登录，密码存在 [账号名]」

如果没有存账号：
- 通知 COO「需要老板提供 [网站] 的登录资料，或者先登录让我记录 session」

## Step 3 — 导航 & 提取

登录成功后：
1. 导航到目标页面（账单页、申请状态页等）
2. 读取页面内容（`get_page_text` / `read_page`）
3. 提取关键数据：
   - 账单：金额、截止日期、账单号、状态
   - 申请：状态、参考号、备注
   - 文件：下载链接

## Step 4 — 回报 COO

格式：
```
✅ [网站名] 查询结果

账号: [账号别名]
查询时间: [时间]

[提取的数据，清晰格式展示]

如需进一步操作（下载 / 提交），请老板确认。
```

如果页面需要进一步操作（付款、提交表格）：
- **不要自动执行**
- 向 COO 说明需要做什么，等老板指示

## 常见任务参考

| 任务 | 网站 | 要找的页面 |
|------|------|-----------|
| 查电费 | mytnb.com.my | My Account → Bills |
| 查水费 | syabas.com.my | My Account → Bill History |
| 查 SSM 状态 | mycoris.ssm.com.my | Company Search |
| 查 LHDN 状态 | mytax.hasil.gov.my | e-Filing Status |
| 查 EPF 余额 | i-Akaun KWSP | Account Balance |

## 工具

| 工具 | 用途 |
|------|------|
| `get_account` | 取已存的网站账号 session |
| `mcp__Claude_in_Chrome__navigate` | 打开目标网页 |
| `mcp__Claude_in_Chrome__get_page_text` | 读取页面内容 |
| `mcp__Claude_in_Chrome__read_page` | 读取页面结构 |
| `mcp__Claude_in_Chrome__form_input` | 填写表单（需老板确认后才执行） |
