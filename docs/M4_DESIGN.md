# M4 阶段详细技术设计规范（T-17 ~ T-24）

本文档定义里程碑 **M4（多项目工作区、可视化规划与预警演进）** 的完整技术方案、模块边界、函数签名、API 协议与验收标准。`codex`（负责算法与服务端 `T-17/19/21/23`）与 `antigravity`（负责前端视图与交互 `T-18/20/22/24`）必须严格按本规范的接口契约对接。

---

## 1. 燃尽图与七日速率统计（T-17 & T-18）

### 1.1 算法与纯函数契约（T-17 · `web/analysis.js`）

在 `web/analysis.js` 中新增导出函数 `computeBurndown(plan, todayStr, milestoneId = null)`：

#### 输入参数
- `plan`: 解析后的 `plan.md` 数据对象（含 `milestones`、`tasks`）。
- `todayStr`: 当前日期字符串 `YYYY-MM-DD`。
- `milestoneId`: 可选，若传入（如 `'M4'`）则仅统计该里程碑下的任务；若为 `null` 或 `'all'` 则统计全部任务。

#### 计算口径
1. **任务权重（工期当量）**：每个任务的权重 $\text{weight}(t) = \text{toDay}(t.\text{end}) - \text{toDay}(t.\text{start}) + 1$（单位：人日）。
2. **时间轴范围 $[D_{\text{start}}, D_{\text{end}}]$**：
   - $D_{\text{start}} = \min_{t} \text{toDay}(t.\text{start})$
   - $D_{\text{end}} = \max(\max_{t} \text{toDay}(t.\text{end}), \text{milestoneDue})$
3. **每日理想剩余量 `ideal[d]`**：
   - 总工期当量 $W_{\text{total}} = \sum_{t} \text{weight}(t)$。
   - 在任意日期 $d \in [D_{\text{start}}, D_{\text{end}}]$，若任务 $t$ 在日历日 $x \in [t.\text{start}, t.\text{end}]$ 内每天均匀消耗 $1$ 人日，则截至日历日 $d$ 结束时，任务 $t$ 的理想剩余量为 $\max(0, \text{toDay}(t.\text{end}) - \max(d, \text{toDay}(t.\text{start}) - 1))$。
   - 对所有纳入统计的任务求和得到当日 `idealRemaining`。
4. **每日实际剩余量 `actual[d]`（仅计算 $d \le \text{today}$）**：
   - 对于历史日期 $d < \text{today}$：
     - 若任务 `status === 'done'` 且 `actualEnd && toDay(actualEnd) <= d`，该任务在 $d$ 日剩余量为 $0$；
     - 若任务有 `actualStart && toDay(actualStart) <= d`，且在 $d$ 日尚未完成：按线性插值或当日已知进度折算；为保持纯函数确定性，历史日 $d < \text{today}$ 仅扣除 `actualEnd <= d` 的已完成任务权重，而 $d = \text{today}$ 当日额外扣除进行中任务的已完成部分 $\text{weight}(t) \times (\text{progress} / 100)$。
5. **近 7 日速率（Velocity）与预计完工日（ETC）**：
   - 令 $d_0 = \max(D_{\text{start}}, \text{today} - 7)$，窗口天数 $\Delta d = \max(1, \text{today} - d_0)$。
   - 近 7 日消耗当量 $\Delta W = \max(0, \text{actual}[d_0] - \text{actual}[\text{today}])$。
   - 日均速率 $\text{velocity} = \Delta W / \Delta d$（保留 2 位小数，单位：人日/天）。
   - 若 $\text{actual}[\text{today}] === 0$：`forecastEnd = todayStr`，`slipDays = 0`。
   - 若 $\text{velocity} > 0$：剩余还需天数 $\text{daysNeeded} = \lceil \text{actual}[\text{today}] / \text{velocity} \rceil$，`forecastEnd = fromDay(today + daysNeeded)`，`slipDays = (today + daysNeeded) - D_end`。
   - 若 $\text{velocity} === 0$：`forecastEnd = null`，`slipDays = null`。

#### 返回值结构
```js
{
  milestoneId: 'all' | 'M1' | ...,
  startDate: '2026-11-17',
  endDate: '2026-12-18',
  totalScope: 42,          // 总工期当量(人日)
  remainingScope: 19,      // 今日剩余工期当量(人日)
  velocity: 2.14,          // 近7日日均燃尽速率(人日/天)
  forecastEnd: '2026-12-10' | null,
  slipDays: -8 | null,     // 负数表示提前,正数表示预计延期
  series: [
    // 从 startDate 到 max(endDate, today) 逐日数组
    { date: '2026-11-17', ideal: 40, actual: 36 },
    { date: '2026-11-18', ideal: 37, actual: null } // d > today 时 actual 为 null
  ]
}
```

### 1.2 前端视图与交互（T-18 · `web/index.html` & `web/app.js`）
- 在侧栏或主区增加 `<section class="card"><h2>燃尽图与速率<small>工期当量收敛</small></h2>...</section>`。
- 顶部提供里程碑筛选下拉框 `<select id="burndownScope">`（`全部里程碑` + 各 `M1..Mn`）。
- 指标摘要行：展示 `剩余 X / 总计 Y 人日`、`7日速率 Z 人日/天`、`预计完工日`。
- 原生 SVG 折线图（`viewBox="0 0 320 160"`）：
  - 灰色虚线绘制 `ideal`；
  - 蓝色实线 + 半透明填充绘制 `actual`；
  - 若 `forecastEnd` 存在且 `remainingScope > 0`，从 `(today, actual[today])` 向 `(forecastEnd, 0)` 画一条预测虚线（按期为绿、超期为红）。

---

## 2. 页面内可视化规划器（T-19 & T-20）

### 2.1 服务端序列化与接口契约（T-19 · `scripts/validate-plan.mjs` & `server/server.mjs`）

#### 1) YAML Front Matter 序列化器
在 `scripts/validate-plan.mjs` 中新增导出函数 `serializePlanMarkdown(data, rawMarkdown, changelogEntry = null)`：
- 将 `data`（含 `project`、`milestones`、`tasks`）严格按 `plan/plan.template.md` 的缩进与字段顺序生成 `---\n...\n---` 块。
- 保留原 `rawMarkdown` 中第二个 `---` 之后的 Markdown 正文说明部分。
- 若传入非空的 `changelogEntry`（字符串），在正文末尾自动追加一行：
  `变更记录:${today} planner ${changelogEntry}`。

#### 2) 规划者写接口 `POST /api/plan/save`
- **请求体（JSON）**：
  ```json
  {
    "project": "task-orchestration",
    "milestones": [...],
    "tasks": [...],
    "reason": "拆分 T-14 并调整 T-20 计划排期"
  }
  ```
- **服务端校验规则**：
  1. 读取当前磁盘上的 `plan.md` 解析为 `before`，对比 `before` 与请求体：
     - 若存在任务增删、里程碑增删，或任何任务的 `title / owner / milestone / start / end / deps` 发生变化，则 `reason` 必须为非空字符串（去除首尾空白后长度 $\ge 2$），否则返回 `400 { message: "修改排期或任务结构必须填写变更原因" }`。
  2. 调用 `validate(nextData)` 校验字段完整性、日期合法性、依赖存在性及无环性（DFS）；若返回错误数组非空，返回 `400 { message: errors.join('; '), errors }`。
  3. 校验通过后调用 `serializePlanMarkdown` 写回 `plan/plan.md`，返回 `200 { ok: true, data: nextData }`。

### 2.2 前端规划模式与交互（T-20 · `web/index.html` & `web/app.js`）
- **顶栏「规划模式」开关（`#plannerMode`）**：
  - 开启后，甘特图控制栏显示 **「+ 新建任务」**、**「+ 新建里程碑」** 按钮。
- **任务编辑抽屉升级**：
  - 普通模式下保持仅可改 `status` 和 `progress`。
  - 规划模式下解锁编辑：`标题 (title)`、`负责人 (owner)`、`所属里程碑 (milestone)`、`计划开始 (start)`、`计划结束 (end)`、`前置依赖 (deps)`，并增加 **「拆分为两个子任务」** 按钮与 **「变更原因 (reason)」** 必填输入框。
- **甘特图拖拽排期**：
  - 规划模式下，鼠标拖拽计划灰条（`.bar.plan`）整体平移可同时顺延/提前 `start` 与 `end`；松手后弹出变更原因确认框，确认后调用 `POST /api/plan/save`。

---

## 3. 多项目切换与工作区管理（T-21 & T-22）

### 3.1 工作区注册表与服务端接口（T-21 · `server/server.mjs`）

#### 1) 配置文件 `plan/workspaces.json`
- 若 `plan/workspaces.json` 不存在，服务端默认构造单项目列表：
  `[{ id: 'default', name: data.project, repoRoot: root, planPath: join(root, 'plan/plan.md') }]`。
- 若存在，结构如下：
  ```json
  {
    "default": "task-orchestration",
    "projects": [
      { "id": "task-orchestration", "name": "task-orchestration", "repoRoot": "D:/dev/task-orchestration", "planPath": "D:/dev/task-orchestration/plan/plan.md" }
    ]
  }
  ```

#### 2) 接口契约
- `GET /api/projects`：
  - 返回所有已注册项目及其实时健康摘要：
    ```json
    {
      "default": "task-orchestration",
      "projects": [
        { "id": "task-orchestration", "name": "task-orchestration", "planPath": "...", "health": "green", "overall": 67, "taskCount": 24 }
      ]
    }
    ```
- `POST /api/projects`：
  - 请求体：`{ "id": "my-app", "name": "我的应用", "repoRoot": "D:/dev/my-app" }`（或直接传 `planPath`）。
  - 校验：路径必须存在且包含合法的 `plan.md`（通过 `parseFrontMatter` 与 `validate`），通过后写入 `plan/workspaces.json` 并挂载 `fs.watch`，返回 `200 { ok: true, project }`。
- **既有接口多项目参数支持**：
  - `GET /api/plan?project=<id>`
  - `POST /api/task?project=<id>`
  - `POST /api/plan/save?project=<id>`
  - `POST /api/sync-git?project=<id>`
  - `GET /api/events?project=<id>`（当对应项目的 `plan.md` 变更时推送 `event: plan-change`）。

### 3.2 前端顶栏项目切换器（T-22 · `web/index.html` & `web/app.js`）
- 顶栏 `.brand` 区域将静态 `#project` 升级为 `<select id="projectSelect">` + `<button id="addProjectBtn" title="注册本地项目">+ 项目</button>`。
- 下拉选项显示：`● 项目名称 (进度%)`（带红/黄/绿状态指示）。
- 点击 `+ 项目` 弹出对话框，输入本地项目根目录路径，调用 `POST /api/projects` 注册并自动切换到新项目。

---

## 4. 外部通知与 Webhook 风险预警（T-23 & T-24）

### 4.1 服务端适配器与去重推送（T-23 · `server/webhooks.mjs` & `server/server.mjs`）

#### 1) 渠道载荷适配器（`buildWebhookPayload(channelType, event)`）
支持 4 种 `channelType`：
- `feishu`（飞书群机器人）：`{ msg_type: 'interactive' | 'post', ... }`
- `dingtalk`（钉钉群机器人）：`{ msgtype: 'markdown', markdown: { title, text } }`
- `wecom`（企业微信群机器人）：`{ msgtype: 'markdown', markdown: { content } }`
- `generic`（通用 JSON）：`{ project, today, summary, risks, markdown, timestamp }`

#### 2) 配置文件与去重缓存
- 渠道配置文件：`plan/webhooks.json`（已加入 `.gitignore`，支持配置多个 `{ id, name, type, url, enabled, autoAlert }`）。
- 风险指纹去重：在内存中维护每个项目的已推送高危风险集合签名 `Set<string>`（格式 `${projectId}:${risk.id}:${risk.level}:${risk.text}`）。当 `plan.md` 变更且某渠道开启了 `autoAlert: true` 时，仅当出现**未推送过的新红色风险**时自动发送 HTTP POST。

#### 3) 接口契约
- `GET /api/webhooks`：返回已配置的渠道列表（URL 脱敏展示，或本地返回完整结构供编辑）。
- `POST /api/webhooks`：保存/更新 `plan/webhooks.json` 配置。
- `POST /api/notify?project=<id>`：
  - 请求体：`{ "channelId": "all" | "<id>", "mode": "risks" | "report" }`
  - 立即向目标 Webhook 渠道发送当前项目的风险预警或 Markdown 周报，返回 `{ ok: true, results: [{ id, status }] }`。

### 4.2 前端配置与一键推送交互（T-24 · `web/index.html` & `web/app.js`）
- 在侧栏「进度报告」与「风险预警」卡片标题栏增加 **「推送预警」** 与 **「配置渠道」** 按钮。
- 点击「配置渠道」打开 `<dialog id="webhookDialog">`，支持添加/删除飞书、钉钉、企微或通用 Webhook URL，并勾选是否开启「新增红色风险自动推送」。
- 点击「推送预警 / 推送周报」直接调用 `POST /api/notify`，并在状态栏反馈推送结果。
