# M5 阶段详细技术设计规范（T-26 ~ T-35）

本文档定义里程碑 **M5（深度可视化交互、时间机器、精细核算与平台生态）** 的完整技术方案、模块边界、纯函数签名、REST API 协议、安全边界与前后端交互契约。

- **核心架构约束**：
  1. **零第三方运行依赖**：仅使用 Node.js 内置标准库（`node:fs`、`node:path`、`node:http`、`node:https`、`node:child_process`、`node:crypto`）与原生浏览器 ES Module + SVG/DOM。
  2. **`plan.md` 格式严守规范**：严格遵守 `docs/PLAN_SPEC.md`，**不得向 `plan/plan.md` 的 YAML front matter 增删任何字段**。扩展元数据（如工作日历、工时故事点、第三方平台配置）一律通过项目隔离的侧车文件（Sidecar JSON）承载。
  3. **多项目与版本锁隔离**：所有新增服务端接口均须支持 `?project=<id>` 参数（通过 `workspaces.get()` 解析），所有修改 `plan.md` 的操作均须校验 `expectedRevision` 与必填 `reason`。
- **角色分工**：
  - `codex`：负责核心纯函数算法、服务端模块、REST API 与自动化测试（`T-26 / T-28 / T-30 / T-32 / T-34`）。
  - `antigravity`：负责前端 SVG/DOM 视图渲染、拖拽连线交互、弹窗配置与状态同步（`T-27 / T-29 / T-31 / T-33 / T-35`）。

---

## 1. 方向一：甘特图深度可视化交互（T-26 & T-27）

### 1.1 排期变更与依赖连线预检算法（T-26 · `web/metrics.js`）

在 `web/metrics.js` 中新增导出纯函数 `previewPlanEdit(plan, editOperation)`，用于在用户拖拽拉伸任务条或拖拽连线建立/解除依赖时，实时在前端内存中进行无副作用的合法性校验、环检测与下游排期冲突顺延试算。

#### 输入参数
- `plan`: 当前解析后的计划对象 `{ project, milestones, tasks }`（函数内部禁止原地修改 `plan`）。
- `editOperation`: 编辑动作描述对象，支持以下 4 种 `type`：
  1. **平移排期 (`move`)**：`{ type: 'move', taskId: 'T-5', deltaDays: 3 }`
  2. **双端拉伸工期 (`resize`)**：`{ type: 'resize', taskId: 'T-5', edge: 'start' | 'end', targetDate: '2026-11-22', cascade: false }`
  3. **新增依赖连线 (`link`)**：`{ type: 'link', fromId: 'T-3', toId: 'T-5', cascade: false }`（即让 `toId.deps` 包含 `fromId`）
  4. **移除依赖连线 (`unlink`)**：`{ type: 'unlink', fromId: 'T-3', toId: 'T-5' }`

#### 处理逻辑与计算口径
1. **基础校验与环检测**：
   - 校验目标任务是否存在；`resize` 时校验 `start <= end`，若 `edge === 'start'` 且 `targetDate > task.end`（或反之），返回 `{ valid: false, code: 'INVALID_DATE_RANGE', message: '开始日期不能晚于结束日期' }`。
   - `link` 时：
     - 若 `fromId === toId`，返回 `{ valid: false, code: 'SELF_DEPENDENCY', message: '任务不能依赖自身' }`；
     - 若 `toId.deps` 已包含 `fromId`，返回 `{ valid: false, code: 'DUPLICATE_DEPENDENCY', message: '依赖关系已存在' }`；
     - 执行拓扑 DFS 环检测：若加入 `fromId -> toId` 后形成环路，返回 `{ valid: false, code: 'CYCLE_DETECTED', cyclePath: ['T-3', 'T-5', 'T-3'], message: '存在循环依赖: T-3 -> T-5 -> T-3' }`。
2. **依赖冲突检测（Dependency Violation）与级联顺延（Cascade Shift）**：
   - 对任意存在依赖关系 `u -> v`（`v` 依赖 `u`），规范要求理想排期满足 `toDay(v.start) >= toDay(u.end)`（或 `toDay(v.start) > toDay(u.end)` 紧接下一日；此处统一定义：**若 `toDay(v.start) < toDay(u.end)` 则判定为排期倒挂冲突 `conflicts`**）。
   - 当 `editOperation.cascade === true` 时：按拓扑序自动将所有满足 `toDay(v.start) < toDay(u.end)` 的下游任务 `v` 顺延，使其新 `start = u.end`（保持 `v` 原工期 `dur` 不变），并记录在 `cascadedTaskIds` 中。
3. **关键路径与里程碑影响对比**：
   - 基于变更后的 `nextPlan` 计算新的关键路径 `criticalTaskIds` 以及受影响的里程碑预计完成日变化 `milestoneImpacts`。

#### 返回值结构
```js
{
  valid: true,                       // boolean: 是否通过无环与日期合法性校验
  code: 'OK',                        // 'OK' | 'CYCLE_DETECTED' | 'INVALID_DATE_RANGE' | 'SELF_DEPENDENCY' | 'DUPLICATE_DEPENDENCY' | 'UNKNOWN_TASK'
  message: '',                       // 错误或提示信息
  cyclePath: [],                     // 若 code === 'CYCLE_DETECTED'，返回环路节点 ID 数组
  conflicts: [                       // 排期倒挂冲突列表（downstream.start < upstream.end）
    { upstreamId: 'T-3', downstreamId: 'T-5', upstreamEnd: '2026-11-20', downstreamStart: '2026-11-18', overlapDays: 2 }
  ],
  cascadedTaskIds: ['T-5'],          // 当 cascade: true 时被自动顺延的下游任务 ID 列表
  suggestedReason: '调整 T-5 计划排期至 2026-11-20 ~ 2026-11-22', // 自动生成的变更原因预填文案
  nextPlan: { project, milestones, tasks } // 应用变更后的新计划深拷贝对象（valid 为 false 时为 null）
}
```

### 1.2 甘特图双端拉伸、锚点连线与冲突实时高亮交互（T-27 · `web/index.html`、`web/app.js`、`web/style.css`）

1. **双端拉伸手柄（Resize Handles）**：
   - 在 `plannerMode === true` 时，每个 `.bar.plan` 左右两端渲染拖拽手柄：
     `<span class="resize-handle left" data-plan-resize="start" data-task-id="T-x"></span>`
     `<span class="resize-handle right" data-plan-resize="end" data-task-id="T-x"></span>`。
   - 拖拽过程中通过 `pointermove` 实时调用 `previewPlanEdit(base.data, { type: 'resize', ... })`：
     - 浮动提示框（Tooltip）实时显示新起止日期与工期天数；
     - 若产生 `conflicts`，在冲突的下游任务条上叠加 `.conflict-highlight` 红色脉冲虚线框；
     - 松开鼠标（`pointerup`）后打开规划确认弹窗（若存在冲突，提供「同时顺延下游冲突任务 (`cascade`)」勾选框），预填 `suggestedReason`，确认后携带打开时的 `base.revision` 调用 `POST /api/plan/save`。
2. **SVG 依赖连线层与拖拽建连（Dependency Link Layer）**：
   - 在甘特图时间线区域增加底层/顶层 `<svg class="gantt-links">` 图层，绘制任务间的依赖折线/贝塞尔曲线（带箭头 marker）；关键路径上的依赖线使用醒目的红色实线，普通依赖使用浅灰蓝线。
   - 在 `plannerMode === true` 时：
     - 每个任务条右侧显示输出锚点 `<i class="dep-anchor out" data-dep-from="T-x" title="拖拽至下游任务以建立依赖"></i>`，左侧显示输入锚点 `<i class="dep-anchor in" data-dep-to="T-y"></i>`；
     - 从输出锚点按住拖拽至目标任务行或输入锚点时，绘制实时跟随指针的虚线连接线，并调用 `previewPlanEdit(..., { type: 'link', fromId, toId })`：
       - 若 `valid === false`（如循环依赖），连接线变红并在状态栏提示 `message`，禁止松手提交；
       - 若 `valid === true`，目标任务高亮为可放置状态（绿色边框），松手后弹出变更原因确认框并保存；
     - 在规划模式下点击已有的依赖连线，可快捷解除该依赖（`type: 'unlink'`）。

---

## 2. 方向二：时间机器与历史演进回放（T-28 & T-29）

### 2.1 Git 历史计划切片提取与演进差异算法（T-28 · `server/history.mjs`、`server/server.mjs`、`web/analysis.js`）

#### 1) 服务端 Git 历史切片提取（`server/history.mjs`）
新增模块 `server/history.mjs`，通过 `execFileSync('git', ...)` 安全读取指定项目仓库中 `plan.md` 的历史提交序列（禁止 shell 拼接，严格限制在 `project.repoRoot` 内）：
- **获取历史提交列表 `listPlanHistory(project, limit = 50)`**：
  - 计算计划文件相对于 `project.repoRoot` 的相对路径 `relPlanPath`（使用 POSIX 斜杠）。
  - 执行 `git log -n <limit> --format=%H%x09%h%x09%ad%x09%an%x09%s --date=iso-strict -- <relPlanPath>`。
  - 对每个 commit，使用 `git show <hash>:<relPlanPath>` 读取当时的文件内容，并用 `parseFrontMatter` 与 `validate` 尝试解析：
    - 仅保留能成功解析出有效 `tasks` 列表的快照点（忽略格式损坏的历史提交）；
    - 提取当时的摘要指标：`taskCount`、`doneCount`、`overall`（调用 `compute(data, commitDate).summary.overall`）。
- **获取指定历史版本详情 `getPlanAtCommit(project, commitHash)`**：
  - 校验 `commitHash` 必须匹配 `/^[0-9a-f]{7,40}$/i`。
  - 读取该 commit 下的 `plan.md`，解析为 `data`，并计算当时的 `metrics`。

#### 2) 时间线演进对比纯函数（`web/analysis.js`）
在 `web/analysis.js` 中新增导出纯函数 `computeTimelineDiff(baselinePlan, currentPlan)`：
- 按任务 `id` 对比 `baselinePlan`（历史基线或某次历史 commit）与 `currentPlan`：
- 返回每个任务的排期偏移与状态演进：
  ```js
  {
     baselineProject: baselinePlan.project,
     currentProject: currentPlan.project,
     summary: {
       addedCount: 2,
       removedCount: 0,
       shiftedCount: 5,         // start 或 end 发生变化的任务数
       totalSlipDays: 8,        // 所有共同任务 (current.end - baseline.end) 之和
     },
     tasks: {
       'T-4': {
         status: 'common' | 'added' | 'removed',
         baselineStart: '2026-11-19',
         baselineEnd: '2026-11-25',
         currentStart: '2026-11-19',
         currentEnd: '2026-11-27',
         startShiftDays: 0,     // toDay(currentStart) - toDay(baselineStart)
         endShiftDays: 2,       // toDay(currentEnd) - toDay(baselineEnd)
         durationDelta: 2,
         progressDelta: 40,     // current.progress - baseline.progress
       }
     }
  }
  ```

#### 3) REST API 契约
- `GET /api/history?project=<id>&limit=30`：
  - 返回该项目 `plan.md` 的 Git 历史版本列表（按时间从旧到新排序，便于时间轴从左到右回放，末尾附加 `current` 工作区当前状态）：
    ```json
    {
      "projectId": "default",
      "commits": [
        {
          "hash": "94252d6...",
          "shortHash": "94252d6",
          "date": "2026-11-17",
          "timestamp": "2026-11-17T18:20:00+08:00",
          "author": "dev",
          "subject": "feat(T-8..T-16): 完成 M2/M3 ...",
          "taskCount": 16,
          "doneCount": 16,
          "overall": 100
        }
      ]
    }
    ```
- `GET /api/history?project=<id>&rev=<commitHash>`：
  - 返回指定 commit 时的完整计划数据与与当前计划的 `diff`：
    ```json
    {
      "projectId": "default",
      "commit": { "hash": "...", "shortHash": "...", "date": "2026-11-17", "subject": "..." },
      "data": { "project": "...", "milestones": [...], "tasks": [...] }
    }
    ```

### 2.2 时间机器回放控制栏与基线幽灵条叠加视图（T-29 · `web/index.html`、`web/app.js`、`web/style.css`）

1. **甘特图控制栏新增「时间机器（Time Machine）」开关与回放条**：
   - 在甘特图顶部控制栏新增 `<button type="button" id="timeMachineBtn">时间机器</button>` 与 `<label><input type="checkbox" id="showBaselineGhost"> 叠加基线幽灵条</label>`。
   - 展开时间机器面板 `#timeMachineBar`：
     - 包含 `<button id="tmPlayPause">▶ 播放</button>`、时间轴滑块 `<input type="range" id="tmSlider" min="0" max="N">`、倍速选择（`1x / 2x`）、当前帧信息（Commit 短哈希、提交日期、提交说明、当时总进度）以及 `<button id="tmExit">退出回放</button>`。
2. **回放模式与基线幽灵条（Ghost Bars）**：
   - 当勾选「叠加基线幽灵条」或处于「时间机器回放」模式时：
     - 调用 `computeTimelineDiff(baselineData, currentData)`；
     - 在每个任务行的甘特图背景层渲染半透明虚线边框的**历史基线条（`.bar.ghost`）**，直观呈现原定排期位置 vs 现行排期位置；若现行结束日比基线推迟（`endShiftDays > 0`），显示 `+N天` 偏移角标。
   - 当拖动时间机器滑块或点击「▶ 播放」自动步进时：
     - 驾驶舱甘特图、KPI 卡片与燃尽图实时渲染所选历史帧的数据（顶部状态栏显示醒目的「历史回放模式 · 只读」横幅，期间禁用编辑操作），点击「退出回放」立即恢复到最新实时状态。

---

## 3. 方向三：单文件离线驾驶舱导出与脱敏报告分享（T-30 & T-31）

### 3.1 自包含离线 HTML 打包器与脱敏清洗纯函数（T-30 · `server/exporter.mjs`、`web/analysis.js`、`server/server.mjs`）

#### 1) 计划数据脱敏纯函数 `sanitizePlanForShare(plan, options = {})`（`web/analysis.js`）
- **输入参数**：
  - `plan`: 原始计划数据对象 `{ project, milestones, tasks }`（深拷贝处理，不修改入参）。
  - `options`:
    - `maskOwners` (`boolean`, 默认 `false`)：是否脱敏负责人姓名。若为 `true`，按负责人出现顺序映射为固定代号 `成员-A`、`成员-B`、`成员-C`……（同一负责人保持同一代号，保证人员负载表仍然具备分析价值）。
    - `stripInternalNotes` (`boolean`, 默认 `false`)：是否移除任务标题中括号内的内部备注（或隐藏关联 Git 提交记录）。
    - `customTitle` (`string`, 可选)：自定义导出的项目展示标题。
- **返回值**：脱敏后的 `{ plan: sanitizedPlan, ownerMap: { 'codex': '成员-A', ... } }`。

#### 2) 单文件自包含 HTML 生成器 `buildStandaloneHtml(payload, options)`（`server/exporter.mjs`）
- 生成一份**完全内联、无需任何外部请求、双击 `.html` 即可在任意现代浏览器离线交互查看**的单文件驾驶舱：
  - 内联 `web/style.css` 样式表；
  - 内联预计算好的脱敏数据快照 `window.__OFFLINE_PLAN__ = ...`（安全转义 `</script>` 与 `<` 为 `\u003c` 防止 XSS 注入）；
  - 包含完整的可交互只读视图能力：KPI 卡片、甘特图（支持「适应 / 日 / 周 / 月」缩放档位切换、里程碑展开/折叠、点击任务查看详情）、SVG 燃尽图（支持按里程碑筛选）、里程碑进度卡片、风险预警列表与人员负载热力图；
  - 页面顶栏标注 `离线只读快照 · 导出于 YYYY-MM-DD HH:mm`，自动隐藏所有写操作按钮（新建/编辑任务、同步 Git、Webhook 配置等）。

#### 3) REST API 契约
- `POST /api/export/html?project=<id>`：
  - **请求体**：
    ```json
    {
      "today": "2026-11-18",
      "maskOwners": true,
      "stripInternalNotes": true,
      "customTitle": "任务时间线驾驶舱（对外汇报版）"
    }
    ```
  - **响应**：`200 OK`，`Content-Type: text/html; charset=utf-8`，返回 `{ ok: true, filename: "task-orchestration-2026-11-18.html", html: "<!doctype html>..." }` JSON（或根据 `Accept` 直接返回 JSON 供前端触发 Blob 下载）。统一约定返回 JSON：`200 { ok: true, filename, html }`。

### 3.2 离线驾驶舱导出弹窗与一键分享交互（T-31 · `web/index.html`、`web/app.js`）

- 在侧栏「进度报告」卡片新增 **「导出离线网页 (.html)」** 按钮（`#exportHtmlBtn`）。
- 点击后打开 `<dialog id="exportHtmlDialog" class="task-dialog">`：
  - **导出标题**：默认当前项目名，可修改为汇报专用名称；
  - **脱敏选项**：
    - `<input type="checkbox" id="exportMaskOwners">` 匿名化负责人（替换为 成员-A / 成员-B）
    - `<input type="checkbox" id="exportStripNotes">` 隐藏 Git 提交历史与内部备注
  - **预览摘要**：实时显示将导出的里程碑数、任务数及是否启用脱敏；
  - 点击「生成并下载 HTML」调用 `POST /api/export/html`，拿到 `html` 字符串后通过 `Blob` 触发浏览器下载 `filename`，并在状态栏提示导出成功。

---

## 4. 方向四：精细化工时、工作日历与预估准确率核算（T-32 & T-33）

### 4.1 工作日历与工时侧车服务及预估准确率算法（T-32 · `server/capacity.mjs`、`web/analysis.js`、`server/server.mjs`）

> **设计原则**：严格遵守 `PLAN_SPEC.md`，不改动 `plan.md` 的 YAML 字段。工作日历与任务级故事点/预估工时存储在项目侧车文件 `plan/capacity.json`（若多项目则在目标项目的 `dirname(project.planPath)/capacity.json`，并加入 `.gitignore`；文件不存在时自动使用默认配置：周末休假、每日 8 小时、按有效工作日折算工时）。

#### 1) 侧车配置文件结构 `capacity.json`
```json
{
  "hoursPerDay": 8,
  "excludeWeekends": true,
  "holidays": ["2026-12-25", "2027-01-01"],
  "workdays": ["2026-12-26"],
  "tasks": {
    "T-26": { "storyPoints": 3, "estimateHours": 16, "actualHours": 14 }
  }
}
```
- **有效工作日判断规则**：
  - 若日期在 `holidays` 中 $\rightarrow$ 非工作日；
  - 否则若日期在 `workdays`（调休补班日）中 $\rightarrow$ 工作日；
  - 否则若 `excludeWeekends === true` 且为周六/周日 $\rightarrow$ 非工作日；
  - 其余为有效工作日。

#### 2) 纯函数：`computeCapacityMetrics(plan, capacityConfig = {}, todayStr)`（`web/analysis.js`）
在 `web/analysis.js` 中新增导出纯函数：
- **辅助纯函数 `countWorkingDays(startStr, endStr, calendarConfig)`**：计算 `[startStr, endStr]` 闭区间内的有效工作日天数（至少为 `1`，若任务全排在周末/节假日则按 `0` 计并在 `calendarWarnings` 中预警）。
- **每项任务的精细化核算**：
  - `workingDays`: 计划区间内的有效工作日数；
  - `defaultEstimateHours`: `Math.max(1, workingDays) * hoursPerDay`；
  - `estimateHours`: 若 `capacityConfig.tasks[id]?.estimateHours > 0` 则取配置值，否则取 `defaultEstimateHours`；
  - `storyPoints`: `capacityConfig.tasks[id]?.storyPoints ?? Math.max(1, workingDays)`；
  - `actualWorkingDays`: 若任务有 `actualStart`，计算 `actualStart` 至 `actualEnd || todayStr` 的有效工作日数；
  - `actualHours`: 若配置了 `actualHours` 则取配置值；否则若 `status === 'done'` 取 `Math.max(1, actualWorkingDays) * hoursPerDay`；
  - `inflationRatio`（仅 `done` 任务）：`actualHours / estimateHours`（工期/工时膨胀系数，$1.0$ 表示精准，$>1.0$ 表示超支，$<1.0$ 表示提前）；
  - `accuracyPct`（仅 `done` 任务）：$\max(0, 1 - |\text{actualHours} - \text{estimateHours}| / \text{estimateHours}) \times 100$。
- **团队整体与按负责人聚合统计**：
  ```js
  {
    hoursPerDay: 8,
    totalStoryPoints: 68,
    completedStoryPoints: 50,
    totalEstimateHours: 544,
    totalActualHours: 412,
    overallAccuracyPct: 86.5,        // 已完成任务的平均预估准确率(%)
    overallInflationRatio: 1.08,     // 已完成任务的总实际工时 / 总预估工时
    calendarWarnings: [              // 排在节假日或非工作日的任务提醒
      { id: 'T-8', message: '计划区间包含 2 天周末/节假日' }
    ],
    byOwner: [
      { owner: 'codex', taskCount: 18, doneCount: 13, storyPoints: 40, estimateHours: 320, actualHours: 240, accuracyPct: 88.2, inflationRatio: 1.04 }
    ],
    tasks: {
      'T-1': { workingDays: 1, storyPoints: 1, estimateHours: 8, actualHours: 8, inflationRatio: 1, accuracyPct: 100 }
    }
  }
  ```

#### 3) REST API 契约
- `GET /api/capacity?project=<id>`：
  - 读取该项目的 `capacity.json`（不存在则返回默认配置），并结合当前 `plan.md` 返回 `{ config, metrics }`。
- `POST /api/capacity?project=<id>`：
  - 请求体：`{ hoursPerDay, excludeWeekends, holidays, workdays, tasks }`。
  - 校验合法性（`hoursPerDay` 为 $1 \sim 24$ 的数字，日期格式必须为 `YYYY-MM-DD`，`storyPoints/estimateHours/actualHours` 为非负数），原子写入 `capacity.json`，返回 `200 { ok: true, config, metrics }`。

### 4.2 工作日历与工时故事点配置面板及预估偏差视图（T-33 · `web/index.html`、`web/app.js`）

1. **侧栏新增「工时与预估核算」卡片（`#capacityCard`）**：
   - 标题栏提供 **「配置日历/工时」** 按钮（`#configCapacityBtn`）；
   - 摘要指标展示：`总故事点 (已完成/总计)`、`总预估工时`、`团队预估准确率 (%)`、`平均工期膨胀系数 (x)`；
   - 按负责人展示预估准确率与工时对比微条形图；若有节假日排期提醒（`calendarWarnings`），展示可点击定位的提示项。
2. **日历与工时配置弹窗（`#capacityDialog`）**：
   - 支持设置「每日标准工时 (`hoursPerDay`)」、「自动排除周末 (`excludeWeekends`)」、自定义「节假日列表 (`holidays`)」与「调休补班日 (`workdays`)」；
   - 提供任务工时/故事点快速编辑表格（支持为任务填入 `storyPoints`、`estimateHours`、`actualHours`），保存后调用 `POST /api/capacity` 并刷新视图。

---

## 5. 方向五：代码托管平台深度联动（T-34 & T-35）

### 5.1 GitHub 与 GitLab Issue 双向同步适配器与服务接口（T-34 · `server/integrations.mjs`、`server/server.mjs`）

#### 1) 侧车配置文件 `plan/integrations.json`（已加入 `.gitignore`）
按项目存储平台连接配置与任务-Issue 映射表（绝不将 Token 明文返回给前端）：
```json
{
  "projects": {
    "default": {
      "provider": "github",
      "apiBase": "https://api.github.com",
      "repo": "owner/repo",
      "token": "ghp_xxx",
      "enabled": true,
      "labelPrefix": "milestone:",
      "issueMap": {
        "T-26": { "number": 42, "url": "https://github.com/owner/repo/issues/42", "state": "open", "syncedAt": "2026-11-18T12:00:00Z" }
      }
    }
  }
}
```
- **安全与网络边界（延续 `webhooks.mjs` 标准）**：
  - `apiBase` 仅允许 `https:` 协议且通过公网 DNS/IP 校验（拒绝 `127.0.0.1`、`localhost`、局域网私有 IP 段等 SSRF 风险地址）；
  - `GET /api/integrations` 响应中 `token` 固定返回 `""`，以 `tokenConfigured: true/false` 表示是否已保存凭证；更新配置时若 `token` 为空字符串，自动沿用原已保存的 `token`。

#### 2) 双向同步核心逻辑（`server/integrations.mjs`）
提供适配器支持 `github` 与 `gitlab` 两种平台，并支持传入自定义 `transport` 函数以便单测无网络 Mock 验证：
- **导出纯函数 `buildIssuePayload(provider, task, milestone)`**：
  - 构造创建/更新远端 Issue 的请求载荷：
    - Title: `[${task.id}] ${task.title}`
    - Body: 包含任务负责人 `owner`、所属里程碑 `milestone`、计划日期 `start ~ end`、前置依赖 `deps`、当前进度 `progress%`；
    - State: `task.status === 'done' ? 'closed' : 'open'`；
    - Labels: `['task-orchestration', `milestone:${task.milestone}`, `status:${task.status}`]`。
- **导出纯函数 `reconcileIssuesWithPlan(plan, remoteIssues, issueMap = {})`**：
  - 匹配规则：优先按 `issueMap[task.id].number` 匹配；若未映射，则按远端 Issue 标题正则 `/^\[(T-\d+)\]\s*(.+)$/` 自动识别任务 ID 并建立绑定。
  - **拉取同步（`mode: 'pull'`，远端 Issue $\rightarrow$ 本地 `plan.md`）**：
    - 若远端 Issue 状态为 `closed` 且本地任务尚未 `done`：将任务更新为 `status: 'done'`、`progress: 100`、`actualStart: task.actualStart || today`、`actualEnd: today`；
    - 若远端 Issue 状态为 `open` 且包含标签 `status:blocked`：将本地任务更新为 `status: 'blocked'`；
    - 若远端 Issue 状态为 `open` 且包含标签 `status:doing`（且本地为 `todo`）：将本地任务更新为 `status: 'doing'`、`progress: Math.max(10, task.progress)`、`actualStart: today`；
    - 所有改动通过 `updatePlanMarkdown` + `verifyTaskUpdates` 写回 `plan.md`。
  - **推送同步（`mode: 'push'`，本地 `plan.md` $\rightarrow$ 远端 Issue）**：
    - 对选定或全部任务：若尚未关联 Issue 则调用平台 API 创建新 Issue 并记录到 `issueMap`；若已关联且标题/状态有差异则调用 PATCH/PUT 更新远端 Issue 状态（如本地已 `done` 则自动关闭远端 Issue）。

#### 3) REST API 契约
- `GET /api/integrations?project=<id>`：
  - 返回当前项目的集成配置（脱敏 `token: ""`, `tokenConfigured: boolean`）及 `issueMap` 绑定状态表。
- `POST /api/integrations?project=<id>`：
  - 保存当前项目的 `provider`、`apiBase`、`repo`、`token`、`enabled` 配置。
- `POST /api/integrations/sync?project=<id>`：
  - 请求体：`{ "direction": "pull" | "push", "taskIds": ["T-26"] }`（`taskIds` 可选，缺省同步全部任务）。
  - 返回：`200 { ok: true, direction, created: [...], updated: [...], touchedTasks: [...], issueMap }`。

### 5.2 平台集成配置弹窗与任务 Issue 绑定交互（T-35 · `web/index.html`、`web/app.js`）

1. **顶栏或侧栏新增「平台同步 (Issue)」入口**：
   - 在顶栏 `syncGit` 按钮旁或侧栏新增 **「Issue 同步」** 按钮（`#issueSyncBtn`）与 **「配置平台」** 按钮（`#configIntegrationBtn`）。
2. **平台配置弹窗（`<dialog id="integrationDialog">`）**：
   - 支持选择平台类型（`GitHub` / `GitLab`）、填写 API 地址（默认 `https://api.github.com` 或 `https://gitlab.com/api/v4`）、仓库标识（如 `owner/repo` 或项目 ID）、Access Token（密码框，已配置时显示占位提示）；
   - 提供「从远端 Issue 拉取状态 (`pull`)」与「推送任务至远端 Issue (`push`)」快捷操作按钮，并反馈同步结果（新建了几个 Issue、更新了哪些任务）。
3. **任务详情与甘特图联动展示**：
   - 若某任务已在 `issueMap` 中绑定了远端 Issue，在甘特图底部详情栏 `#detail` 及任务编辑弹窗中显示可点击的 Issue 徽章链接（如 `<a href="..." target="_blank" rel="noopener">#42 (open)</a>`），并支持单独对该任务点击「同步此任务 Issue」。

---

## 6. 任务分工与验收矩阵汇总

| 任务 ID | 方向 | 负责人 | 核心交付物与修改文件 | 关键验收点 |
|---|---|---|---|---|
| **T-26** | 方向一 | `codex` | `web/metrics.js`, `tests/simulation.test.mjs` | `previewPlanEdit` 纯函数支持平移、拉伸、建连、断连，准确检出环路、排期倒挂冲突及级联顺延 |
| **T-27** | 方向一 | `antigravity` | `web/index.html`, `web/app.js`, `web/style.css` | 规划模式下甘特条支持双端拉伸改期、SVG 依赖连线渲染、拖拽锚点建立/解除依赖与冲突高亮 |
| **T-28** | 方向二 | `codex` | `server/history.mjs`, `server/server.mjs`, `web/analysis.js`, `tests/` | `GET /api/history` 提取 Git 计划演进快照，`computeTimelineDiff` 准确计算基线偏移 |
| **T-29** | 方向二 | `antigravity` | `web/index.html`, `web/app.js`, `web/style.css` | 时间机器回放控制栏、滑块播放历史帧、甘特图叠加半透明历史基线幽灵条与偏移角标 |
| **T-30** | 方向三 | `codex` | `server/exporter.mjs`, `web/analysis.js`, `server/server.mjs`, `tests/` | `sanitizePlanForShare` 脱敏纯函数与 `POST /api/export/html` 生成零外部依赖的自包含可交互 HTML |
| **T-31** | 方向三 | `antigravity` | `web/index.html`, `web/app.js` | 离线驾驶舱导出配置弹窗（自定义标题、匿名化负责人、隐藏备注）与一键下载 `.html` |
| **T-32** | 方向四 | `codex` | `server/capacity.mjs`, `web/analysis.js`, `server/server.mjs`, `tests/` | `GET/POST /api/capacity` 侧车服务、`countWorkingDays` 工作日历与 `computeCapacityMetrics` 预估准确率核算 |
| **T-33** | 方向四 | `antigravity` | `web/index.html`, `web/app.js`, `web/style.css` | 侧栏工时与预估准确率卡片、负责人偏差对比条、工作日历与任务故事点/工时配置弹窗 |
| **T-34** | 方向五 | `codex` | `server/integrations.mjs`, `server/server.mjs`, `tests/` | GitHub/GitLab 适配器、SSRF 防护、Token 掩码、`reconcileIssuesWithPlan` 及 `/api/integrations` 接口 |
| **T-35** | 方向五 | `antigravity` | `web/index.html`, `web/app.js`, `web/style.css` | 代码托管平台配置弹窗、一键双向同步（Push/Pull）交互、任务详情 Issue 链接徽章展示 |
