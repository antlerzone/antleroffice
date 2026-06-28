# AntlerOffice Human Resource — Create NPC Skin

Use this skill when the COO delegates a request to design a pixel art skin for an AntlerOffice NPC character.

## 核心原则

**快、不啰嗦，只设一道确认关。** 老板丢图 + 取名就直接开做第一张预览图，不用问一堆问题、也不用先写文字草稿等批准。唯一的确认关在"第一张图之后、做完整动画之前"。

## Step 1 — Intake（极简）

老板给：
- 参考图片（jpg/png）和 / 或
- 皮肤名字

两样都有就直接进 Step 2。只有当**名字**或**任何视觉参考 / 描述都没有**时，才回一句问清楚。不要问风格、配色那一堆。

## Step 2 — 直接生成第一张预览图（不用等批准）

立刻调用 **SpriteCook MCP**，根据参考图生成**一张静态角色预览图**（正面单张，先不做动画）。直接把这张图给老板看。

结尾说：

```
喜欢这版就说「可以 / approve」，我接着做会动的完整皮肤；
想改就告诉我哪里改。
```

## Step 3 — 等老板批准这张图

- 老板说「可以 / approve」→ 进 Step 4。
- 老板要改 → 带上修改要求**重新生成这一张预览图**，再给他看（**还不做完整动画表**）。

## Step 4 — 批准后：生成会动的完整皮肤

调用 **SpriteCook MCP** 生成完整角色动画表：

**112×96 px，3 方向（正 / 左 / 右）× 7 走路帧，PNG**

## Step 5 — 设价格 + 发布前确认

向老板**提一个 credit 价格**（每张皮肤可以不同价），等老板确认。内置 / default 皮肤免费（价格 0）；自定义 AI 生成的皮肤才收费。

```
这张皮肤「[名字]」我建议定价 [N] credits，确认就发布；
要改价或免费也告诉我。
```

**没确认价格前不要发布。**

## Step 6 — 发布到商店（收到价格确认后）

调用 `POST /api/skins/create`，传 `{ name, priceCredits, previewUrl, assetUrl }`，把皮肤写进 **ECS 皮肤目录**，它才会出现在 Skins 商店、可被浏览和购买。

回报：皮肤名字、价格、现在已上架到 **Skins 商店**（预览人人可见，购买后才能 Apply）。

## 工具

| 工具 | 用途 |
|------|------|
| SpriteCook MCP | 第一张预览图 + 完整动画表 |
| `POST /api/skins/create` | 把皮肤写入 ECS 目录（上架可购买） |

## 规格

最终动画表固定：**112×96 px，3 方向（正 / 左 / 右）× 7 走路帧，PNG**。像素画 4–8 个主色最好看，颜色从参考图提取。如果模型看不了图片，就退回用老板的文字描述。
