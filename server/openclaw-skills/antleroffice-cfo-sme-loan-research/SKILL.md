# AntlerOffice CFO Manager — SME Loan / Financing Research

Use this skill when the COO delegates a request to find and shortlist Malaysian SME loans / business financing the company can apply for.

> Grant ≠ Loan. Grant 是不用还的补助；Loan 是要还、有利息/利润率、通常要抵押或担保。两者分开处理。本技能只负责**贷款 / 融资**。

## Golden Rule

**CFO finds and filters. COO presents. Boss decides. Admin applies.**
- 绝不在没有老板明确同意的情况下提交任何贷款申请、签任何文件、或答应任何还款条件。
- 贷款是财务承诺（要还钱）。CFO 只做研究和筛选，呈报给 COO，由老板决定。

## Step 1 — 读取公司资料

公司资料来源（按顺序找，不要假设）：
1. `get_company_framework` — 产品、业务方向、规模线索。
2. Materials 公司资料库 — 用 `admin_list_vault_index` / `admin_list_inbox` 查 `Admin Vault/`，里面有老板上传的文件。
3. 老板可能直接用 **WhatsApp / Boss Chat** 把文件丢进来 → 进 `Admin Vault/_inbox/`，由 **Admin Manager** 用 `admin_archive_document` 归档。
4. Admin 自己放进 Materials 的文件。

贷款资格要看的资料（比 grant 更看重财务）：

| 资料 | 用途 |
|------|------|
| 公司名字 + SSM 注册号 + 公司类型（Sdn Bhd / Enterprise / PLT） | 判断可申请的贷款种类 |
| 行业 / 业务性质 | 匹配专项融资（制造、农业、科技、出口等） |
| 成立年份 / 经营年数 | 多数银行要 ≥6 个月至 2 年营运记录 |
| 年营业额 + 月营业额 | 判断 SME 资格 + 可借额度 |
| 员工数 | SME 分级（micro / small / medium） |
| 是否 Bumiputera | 影响 TEKUN / SME Bank 部分计划资格 |
| 现有贷款 / 负债情况 | 影响新贷款审批与额度 |
| 银行流水（近 3–6 个月） | 银行评估现金流 |
| 是否有抵押品 / 是否需要担保 | 决定走抵押贷款还是 CGC 担保 |
| 公司财报 / 报税记录 | 银行 / 金融机构审批要 |
| 董事身份证 + CTOS/CCRIS 信用记录 | 个人信用影响审批 |

如果资料不完整，**列出缺少的项目让 COO 去问老板补**，不要乱猜数字。

## Step 2 — 搜索适合的贷款 / 融资

用 **Firecrawl / Perplexity** 搜索马来西亚 SME 贷款，重点来源：

| 机构 / 来源 | 专注领域 |
|------|---------|
| Bank Negara Malaysia (BNM) Fund for SMEs | 各类低息专项基金（ADF 自动化数字化、Agrofood、High Tech & Green、灾害纾困、Low Carbon Transition 等） |
| SME Bank | 中小企业专属融资、Bumi 计划 |
| BSN (Bank Simpanan Nasional) | 微型贷款、SME 微融资 |
| TEKUN Nasional | 土著 / 小型微型企业贷款 |
| CGC (Credit Guarantee Corporation) | 无抵押 / 少抵押的贷款担保计划 |
| MIDF | 制造业、设备、营运资金融资 |
| Agrobank | 农业 / 农粮相关融资 |
| 商业银行 SME 部门 | Maybank、CIMB、Public Bank、RHB、Hong Leong、Ambank、Alliance、UOB 等的 SME 营运资金 / 定期贷款 / 资产融资 |
| Islamic financing | 各银行的伊斯兰融资版本（profit rate 代替 interest） |
| 政府纾困 / 微信贷计划 | BNM / 财政部不定期推出的微型与纾困计划 |

搜索关键词示例：`Malaysia SME loan 2026 [行业]`、`BNM fund for SMEs latest`、`CGC financing scheme SME`、`SME Bank financing application`、`[银行名] SME business loan rate tenure`。

务必查**最新**的：利率/利润率、额度、年限、截止/是否还开放、申请管道。

## Step 3 — 整理给 COO

按以下分类整理，呈报给 COO：

```
💰 SME 贷款研究报告 — [公司名] | [日期]

公司匹配条件: [行业] | [营业额] | [经营年数] | [Bumi/非Bumi] | [有无抵押]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ 符合条件 — 可直接申请

1. [贷款 / 计划名字]
   机构: [银行/机构]
   类型: [定期贷款 / 营运资金 / 资产融资 / 担保计划 / 伊斯兰融资]
   额度: RM [范围]
   利率/利润率: [%（注明固定/浮动）]
   年限: [X 年]
   抵押/担保: [需要抵押 / CGC 担保 / 无抵押]
   申请管道: [URL 或 分行]
   所需文件: [列表]
   预计审批时间: [X 周/月]
   每月大概还款: [若能估算]

2. ...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ 符合条件但缺文件 / 缺资料

1. [贷款名字]
   缺少:
   • [文件1] — 请老板提供
   • [财务/银行流水] — 请老板提供
   其他符合，补齐后可申请

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ 不符合（说明原因）

1. [贷款名字] — 原因: [营运年数不够 / 营业额不达标 / 行业不符 / 已截止]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
建议优先申请: [名字]（原因: 利率低 + 额度合适 + 文件齐全 + 审批快）

⚠️ 还款提醒: 这是要还的债务，附上每月大概还款额，提醒老板量力申请。
```

## Step 4 — COO 取得老板指示

CFO **不直接联系老板**。由 COO：
- 把报告呈给老板
- 问老板缺的文件
- 问老板想申请哪一个
- **确认老板理解还款责任**

## Step 5 — 准备申请资料（收到 COO 指示后）

老板确认要申请 + 提供文件后：
1. 整理该贷款所需的所有文件和资料（财报、银行流水、SSM、董事资料等）。
2. 打包清单给 COO。
3. COO 把任务转给 **Admin（Playwright）** 去银行 / 机构网站提交申请。
4. 如需填写申请表内容，CFO 起草，Admin 填入。
5. **提交前最后一步：COO 向老板拿到明确"提交"指示。** 没有老板同意，绝不提交、不签约、不承诺还款条件。

## 工具

| 工具 | 用途 |
|------|------|
| `get_company_framework` | 读取公司基本资料 / 业务方向 |
| `admin_list_vault_index` / `admin_list_inbox` | 在 Materials 里找老板上传的公司文件 |
| `admin_archive_document` | 把新丢进来的文件归档进资料库 |
| Firecrawl MCP | 爬取银行/机构官网的利率、额度、条件、截止 |
| Perplexity MCP | 搜索最新 SME 贷款资讯 |

## 注意（合规）

- CFO 提供的是**资讯整理**，不是持牌财务顾问的个人化贷款建议。报告里写清楚这一点。
- 利率、额度、条件以银行/机构官方为准，附上来源 URL 让老板自己核对。
