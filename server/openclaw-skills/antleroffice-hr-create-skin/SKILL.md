# AntlerOffice Human Resource — Create NPC Skin

Use this skill when the COO delegates a request to design a pixel art skin for an AntlerOffice NPC character.

## Golden Rule

**Never publish a skin without the boss's explicit approval.**
Always draft the design → present to COO → wait for boss to say "发布" / "publish" → then save.

## Step 1 — Intake

Ask the boss (via COO):

| Field | Question |
|-------|----------|
| 参考图片 | 有没有参考图片？（可以丢 jpg/png，或者文字描述也行） |
| NPC 名字 | 这个皮肤给哪个 NPC 用？或者是全新角色？ |
| 风格偏好 | 商务专业 / 可爱萌系 / 酷炫个性 / 奇幻风格？ |
| 主色调 | 如果没有参考图，主要颜色是？ |
| 皮肤名字 | 这个皮肤叫什么名字？（用于保存和显示） |

如果老板丢了参考图片，直接进入 Step 2，不用再问风格和颜色（从图片提取）。

## Step 2 — 分析参考图片（如有）

从参考图片提取：
- **主色调**（最多 5 个主要颜色，列出 hex code）
- **角色特征**（发型、服装、配件、整体气质）
- **风格**（写实 / 卡通 / 简约 / 奇幻）

整理成设计简报。

## Step 3 — Draft 设计简报

向 COO 呈现：

```
🎨 皮肤设计 Draft — [皮肤名字]

参考: [图片来源 / 文字描述]

颜色提取:
  主色: #XXXXXX（描述）
  副色: #XXXXXX（描述）
  强调色: #XXXXXX（描述）

角色设定:
  发型: ...
  服装: ...
  配件: ...
  气质: ...

像素规格: 112×96 px，3 方向 × 7 走路帧，PNG

SpriteCook 参数:
  style: pixel-agents
  palette: [主色调描述]
  character: [角色特征描述]

请老板确认设计方向，说「生成」我就调用 SpriteCook。
```

**等老板确认，不要自动生成。**

## Step 4 — 生成皮肤（收到"生成"后）

1. 调用 **SpriteCook MCP** 生成角色图：
   - 规格：**112×96 px，3 方向 × 7 走路帧，PNG**
   - 传入颜色和角色描述
2. 把生成结果展示给 COO 看

呈现格式：
```
✅ 皮肤已生成 — [皮肤名字]

[图片预览]

满意的话说「发布」，不满意告诉我哪里要改。
```

**等老板说"发布"或"修改"。**

## Step 5 — 发布（收到"发布"后）

1. 调用 `POST /api/config/skins`（multipart，上传 PNG）保存皮肤
2. 回报：皮肤名字、皮肤 ID、在哪里找到（Characters 页面）
3. 告诉老板可以在任何 NPC 的设置里「Apply」这个皮肤

## 修改流程

如果老板说要修改：
- 记录修改要求
- 重新 Draft 修改后的参数（Step 3）
- 再等一次老板确认
- 再生成（Step 4）

## 工具

| 工具 | 用途 |
|------|------|
| SpriteCook MCP | 生成 pixel art 角色动画图 |
| `POST /api/config/skins` | 保存皮肤到 AntlerOffice |
