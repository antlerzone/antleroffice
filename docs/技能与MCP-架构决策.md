# 技能（Skill）与 MCP — 架构决策记录

> 记录我们关于 NPC 技能 / MCP「放本地还是放云端」以及「技能去重安装」的讨论结论，方便下次接着聊。
> 最后更新：2026-06-26

---

## 0. 产品定位（前提）

AntlerOffice 本质是一个**可视化的 OpenClaw**。

Browse 里的每个 agent，都是**我们（产品方）预先配置好的「成品员工」** —— 配好了技能、配好了用哪些 MCP。用户进来 **hire（下载）就能直接用**，不用自己从零搭。

这个定位决定了下面所有的取舍：技能是「商品的一部分」，跟着 NPC 走，而不是用户自己拼装的零件。

---

## 1. 现状盘点（2026-06-26 实测）

- **本地没有任何「独立技能库」。** 存用户自建技能的文件 `data/skills.json` **根本不存在** → 读出来是空 `[]`。
- **本地也没有「独立 MCP 库」。** `data/mcps.json` 同样不存在 → 空。
- **技能全部 tie 在 NPC 上。** 每个模板自带一份清单（`skillIds` / `openclawSkillNames`），技能的实际内容（提示词等）放在代码仓库 `skills/*.json`，以及按模板打包的 ECS bundle 里。
- **技能定义的来源 = 云端 bundle。** Hire 时从 ECS 下载该模板的 bundle，缓存到本地 `~/.antleroffice2/bundles/{templateId}/`。也就是说技能定义**本来就在云端**，本地只是缓存。
- **bundle 按 templateId 打包** → 同一个技能如果被两个模板都包含，会在两个模板的 bundle 目录里**各存一份（重复）**。
- 已有 `skill-install-log.json`：记录每次安装（含 `skillId` / `npcTemplateId` / 状态 `installed|skipped|failed`），目前是「历史日志」，不是去重索引，但可以拿来查「某技能是否已装」。

**一句话现状：技能/MCP 全绑在 NPC 上，本地没有独立库；定义来自云端 bundle，按模板分别缓存。**

---

## 2. 决策一：技能 / MCP 放本地还是云端

把一个 agent 拆成两层，分开存：

| 层 | 内容 | 放哪 | 理由 |
|---|---|---|---|
| **配方层** | 技能清单、提示词、用哪些 MCP、默认配置 | **云端**（沿用现有 bundle/ECS） | 由我们编辑、用户下载即用，符合「成品员工」定位 |
| **钥匙层** | 用户自己的账号 / token（登录某后台、发某平台） | **本地** | 这是用户自己的机密，不是我们能预打包的；留本地最安全 |

### token 要不要也上云？（**待定**）

- **只留本地（推荐起步）**：token 只待在用户自己电脑。云库被黑也偷不到东西。代价：用户换电脑要重登一次。
- **也放云端**：登一次到处能用，但等于我们替全体用户保管钥匙；泄露=所有用户外部账号暴露，且要担保管机密的合规责任。要做就得用「连我们自己都解不开」的客户端加密，工程量明显更大。
- **结论**：token **先默认只留本地**，零风险、不挡上线。以后真有多设备同步需求，再单独做「客户端加密同步」，那时我们手里也永远是密文。

---

## 3. 决策二：技能去重安装（新需求）

### 需求

> NPC A 和 NPC B 都包含同一个技能 X。
> - A 先 hire → 安装 X。
> - B 后 hire → **不要重装 X**，只安装 B 有、但还没装过的技能。

### 现状问题

- bundle 按 templateId 打包，同一技能在 A、B 两个模板里**各存一份**，目前没有「按技能 id 去重」的共享层。
- 所以 B 安装时大概率会把 X 再装/再写一遍，而不是跳过。

### 建议做法

1. **建一个「共享技能安装状态」**：以 **技能 id** 为 key（不是以 NPC 为 key），记录「这个技能已经装好了」。`skill-install-log.json` 已有 `skillId` 字段，可在它基础上加一个「当前已安装集合」的索引。
2. **Hire 时做 diff**：
   - 取该 NPC 模板的技能清单。
   - 逐个看「共享状态里有没有」：
     - 有 → 跳过（状态记 `skipped`，复用已装的那份）。
     - 没有 → 安装 + 写入共享状态。
3. 结果：A 装 `[X, Y]`；B 模板是 `[X, Z]` → B 只装 `Z`，X 直接复用。

### 待确认的一个关键点

OpenClaw 里技能是**每个 agent 各自挂一份**，还是**全局共享一个技能池、agent 只是引用**？

- 若**全局共享/引用** → 去重很自然：装一次，B 引用即可。
- 若**每 agent 各一份** → 「跳过安装」要改成「从已装的那份复制/链接给 B」，否则 B 那个 agent 身上没有这个技能。

> 下次先把这一点查清楚，再定去重到底是「跳过」还是「复制引用」。

---

## 4. Internal / Admin NPC 访问（决策）

### 需求

有一批「内部 / admin」NPC，平时对普通用户**完全不可见**，只有 **SaaS admin 账号**能看到、能用。

### 决策

- **放在 SaaS admin portal，不放消费端 desktop。** 内部 NPC 是 admin 管理功能，后台本来就只有 admin 能进、本来就连着 ECS，权限天然隔离，不污染消费端 app。
- **不用单独密码，按账号 admin 角色判断**（跟着「户口」/登录身份走）。
- **内部 NPC 在 server 上打标记**，平时不下发。

### ⚠️ 必须做两层校验（不能只做一层）

> 这一点是硬要求：UI 藏起来 ≠ 拿不到。前端能被绕过，真正的门必须在 server。

1. **UI 层**：`user.isAdmin`（来自 ECS 登录身份）为真，portal 才渲染那张 “SaaS admin” 卡片 / Internal 入口。普通用户根本看不到入口。
2. **Server 层（真正挡人）**：返回内部 NPC 的接口**自己强制校验 token 是不是 admin**，不是 admin 直接拒。否则有人绕过界面、直接调 API 照样能把内部 NPC 拉出来。

两层都做，才是「非 admin 真的看不到、也拿不到」。**第二层不能省。**

### 代码在哪（重要更正）

ECS 后端和 SaaS portal **都在这个工作区里**，B 方案绝大部分**已经做好了**：

- `Antlermarket/server` = **ECS 后端**；`Antlermarket/website` = **SaaS portal**（Next.js）。
- **第二层（server 强制校验）已存在**：`server/src/routes/admin-catalog.js` 的 `requireAdmin` 用 `repo.isSaasAdminEmail(user.email)` 判 admin（admin = 邮箱在 SaaS admin 名单里），保护着 `/api/admin/catalog/workers` 全部接口。非 admin → 401。
- **admin portal 已存在**：`website/app/admin/workers` 就是管理 NPC 的页面，admin 在那里能看到/管理**全部** worker（`listSaasWorkers()` 返回全部）。

### 现有可见性 & 真正缺的一档

- 现有 `visibility` 只有两档：`public`（公开）/ `hidden`（隐藏，需 hire password + 用 catalogUuid 搜索才出现 —— **用户拿到 UUID 仍能搜到**）。
- **缺**：一个「纯内部」第三档 —— 公开 catalog 完全不下发、用户永远搜不到，只有 admin 看得到。
- 实现核心：新增 `visibility: 'internal'`，并在**公开 catalog**（`server/src/routes/catalog.js` 的 `mergedCatalogTemplates` / `catalog-fields.js`）里把它**整个过滤掉**；admin 接口照旧返回（admin 仍可见）。

---

## 5. 待办 / 下次继续

### Internal / Admin NPC（B 方案，多数已就绪）
- [x] server 第二层校验：`requireAdmin` + `isSaasAdminEmail`（已存在）。
- [x] admin portal 管理页：`website/app/admin/workers`（已存在）。
- [ ] **新增 `visibility: 'internal'`**：`catalog-fields.js` 的 `normalizeVisibility` 放开第三档。
- [ ] **公开 catalog 过滤掉 internal**：`server/src/routes/catalog.js` 不下发 internal worker（这是「用户永远搜不到」的关键）。
- [ ] admin portal workers 页：可把 worker 设成 internal（可见性下拉加一项）。
- [ ] 确认 portal admin 入口对非 admin 已隐藏/重定向（第一层 UI）。

### 技能 / MCP
- [ ] 确认 OpenClaw 技能是 per-agent 还是全局共享（决定去重实现方式）。
- [ ] 设计「共享技能安装状态」索引（基于 `skill-install-log` 扩展）。
- [ ] 实现 hire 时的技能 diff（只装缺的）。
- [ ] token 是否上云 —— 暂定只留本地，待用户需求再议。
- [ ] （可选）出一张「每个 NPC 绑了哪些技能 / MCP」的对照表。
