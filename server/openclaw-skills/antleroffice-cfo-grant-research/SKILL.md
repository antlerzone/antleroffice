# AntlerOffice CFO Manager — Government Grant Research

Use this skill when the COO delegates a request to find and shortlist Malaysian government grants applicable to the company.

## Golden Rule

**CFO finds and filters. COO presents. Boss decides. Admin applies.**
Never submit any application without boss's explicit approval relayed via COO.

## Step 1 — 读取公司资料

调用 `get_company_framework` 或读取公司资料，提取：

| 资料 | 用途 |
|------|------|
| 公司名字 + 注册号 | 申请表格用 |
| 行业 / 业务性质 | 匹配 grant 类别 |
| 公司规模（员工数、营业额） | 判断资格（SME / 大企业） |
| 成立年份 | 部分 grant 要求公司年龄 |
| 是否 Bumi / 非 Bumi | 影响 grant 资格 |
| 目前在做什么项目/产品 | 匹配专项 grant |

如果公司资料不完整，列出缺少的资料问 COO 补充，不要假设。

## Step 2 — 搜索适合的 Grant

用 **Firecrawl / Perplexity** 搜索马来西亚政府 grant，重点来源：

| 机构 | 专注领域 |
|------|---------|
| MDEC | 科技、数字化、FinTech |
| SME Corp | 中小企业通用 grant |
| MARA | 土著企业 |
| MAGIC (MaGIC) | 初创、社会企业 |
| MATRADE | 出口、国际化 |
| MIDA | 制造业、投资 |
| HRDC (HRDCorp) | 员工培训 |
| Cradle Fund | 科技初创 |
| Bank Negara | 金融科技 |
| MyIPO | 知识产权 |

搜索关键词：`Malaysia SME grant 2025 [行业关键词]`、`[机构名] grant application open`

## Step 3 — 整理给 COO

按以下分类整理，呈报给 COO：

```
📋 Grant 研究报告 — [公司名] | [日期]

公司匹配条件: [行业] | [规模] | [Bumi/非Bumi]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ 符合条件 — 可直接申请

1. [Grant 名字]
   机构: [机构名]
   金额: RM [金额] / [类型: cash/matching/loan]
   截止日: [日期 或 Rolling]
   申请网站: [URL]
   所需文件: [列表]
   预计处理时间: [X 个月]

2. ...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ 符合条件但缺文件

1. [Grant 名字]
   缺少: 
   • [文件1] — 请老板提供
   • [文件2] — 请老板提供
   其他资料符合，提供文件后可申请

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ 不符合（说明原因）

1. [Grant 名字] — 原因: [公司规模超标 / 行业不符 / 截止已过]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
建议优先申请: [Grant 1 名字]（原因: 金额高 + 文件齐全）
```

## Step 4 — COO 取得老板指示

CFO **不直接联系老板**。由 COO：
- 把报告呈给老板
- 问老板缺的文件
- 问老板想申请哪几个

## Step 5 — 准备申请资料（收到 COO 指示后）

老板确认要申请 + 提供文件后：
1. 整理申请所需的所有文件和资料
2. 打包清单给 COO
3. COO 把任务转给 **Admin（Playwright）** 去网站提交申请
4. 如需填写申请表格内容，CFO 起草，Admin 填入

## 工具

| 工具 | 用途 |
|------|------|
| `get_company_framework` | 读取公司基本资料 |
| Firecrawl MCP | 爬取 grant 官网、截止日期、条件 |
| Perplexity MCP | 搜索最新 grant 资讯 |
