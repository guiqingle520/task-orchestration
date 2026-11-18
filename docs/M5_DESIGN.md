# M5 阶段详细技术设计规范（T-26 ~ T-35）

本文档定义里程碑 **M5（深度可视化交互、时间机器、精细核算与平台生态）** 的完整技术方案、模块边界、纯函数签名、REST API 协议、安全边界与前后端交互契约。

- **核心架构约束**：
  1. **零第三方运行依赖**：仅使用 Node.js 内置标准库（`node:fs`、`node:path`、`node:http`、`node:https`、`node:child_process`、`node:crypto`）与原生浏览器 ES Module + SVG/DOM。
  2. **`plan.md` 格式严守规范**：严格遵守 `docs/PLAN_SPEC.md`，**不得向 `plan/plan.md` 的 YAML front matter 增删任何字段**。扩展元数据（如工作日历、工时故事点、第三方平台配置）一律通过项目隔离的侧车文件（Sidecar JSON）承载。
  3. **多项目与版本锁隔离**：所有新增服务端接口均须支持 `?project=<id>` 参数（通过 `workspaces.get()` 解析）；任何修改计划结构/排期的操作须校验 `expectedRevision` 与必填 `reason`，修改任务执行态的操作须校验 `expectedRevision`（或单任务字段级乐观锁）。
- **角色分工**：
  - `codex`：负责核心纯函数算法、服务端模块、REST API 与自动化测试（`T-26 / T-28 / T-30 / T-32 / T-34`）。
  - `antigravity`：负责前端 SVG/DOM 视图渲染、拖拽连线交互、弹窗配置与状态同步（`T-27 / T-29 / T-31 / T-33 / T-35`）。

---

## 1. 方向一：甘特图深度可视化交互（T-26 & T-27）

### 1.1 排期变更与依赖连线预检算法（T-26 · `web/metrics.js`）

在 `web/metrics.js` 中新增导出纯函数 `previewPlanEdit(plan, editOperation)`，用于在用户拖拽平移/拉伸任务条或拖拽连线建立/解除依赖时，实时在内存中进行无副作用的合法性校验、环检测与受影响下游排期冲突试算。

#### 输入参数
- `plan`: 当前解析后的计划对象 `{ project, milestones, tasks }`（函数内部禁止原地修改 `plan`）。
- `editOperation`: 编辑动作描述对象，支持以下 4 种 `type`：
  1. **平移排期 (`move`)**：`{ type: 'move', taskId: 'T-5', deltaDays: 3, cascade: false }`
  2. **双端拉伸工期 (`resize`)**：`{ type: 'resize', taskId: 'T-5', edge: 'start' | 'end', targetDate: '2026-11-22', cascade: false }`
  3. **新增依赖连线 (`link`)**：`{ type: 'link', fromId: 'T-3', toId: 'T-5', cascade: false }`（即让 `toId.deps` 包含 `fromId`）
  4. **移除依赖连线 (`unlink`)**：`{ type: 'unlink', fromId: 'T-3', toId: 'T-5' }`

#### 处理逻辑与计算口径（已明确同日交接与作用范围规则）
1. **基础校验与环检测**：
   - 校验目标任务是否存在（不存在返回 `code: 'UNKNOWN_TASK'`）。
   - `resize` 时校验 `start <= end`：若 `edge === 'start'` 且 `targetDate > task.end`（或 `edge === 'end'` 且 `targetDate < task.start`），返回 `{ valid: false, code: 'INVALID_DATE_RANGE', message: '开始日期不能晚于结束日期' }`。
   - `link` 时：
     - 若 `fromId === toId`，返回 `{ valid: false, code: 'SELF_DEPENDENCY', message: '任务不能依赖自身' }`；
     - 若 `toId.deps` 已包含 `fromId`，返回 `{ valid: false, code: 'DUPLICATE_DEPENDENCY', message: '依赖关系已存在' }`；
     - 执行拓扑 DFS 环检测：若加入 `fromId -> toId` 后形成环路，返回 `{ valid: false, code: 'CYCLE_DETECTED', cyclePath: ['T-3', 'T-5', 'T-3'], message: '存在循环依赖: T-3 -> T-5 -> T-3' }`。
2. **排期冲突口径（允许同日交接，新增或加重的倒挂必须解决）**：
   - **同日交接合法**：对任意依赖边 `u -> v`（`v` 依赖 `u`），编辑预检**允许下游在上游结束当天开工**（即 `toDay(v.start) >= toDay(u.end)` 不视为冲突）。*注：现有的 `simulateDelays` 延期推演继续保留“次日开工 (`u.end + 1`)”规则不变，前端界面说明这一区别。*
   - **倒挂冲突定义**：当 `toDay(v.start) < toDay(u.end)` 时，倒挂天数 `overlapDays = toDay(u.end) - toDay(v.start) > 0`。
   - **区分存量历史倒挂与本次编辑引入/加重的倒挂**：
     - 记编辑前该依赖边 `u -> v` 的原倒挂天数为 `beforeOverlap = Math.max(0, toDay(u_before.end) - toDay(v_before.start))`（新建立的连线 `beforeOverlap = 0`）；
     - 仅当编辑后 `afterOverlap > 0` 且（该边属于本次编辑直接/间接影响的范围且 `afterOverlap > beforeOverlap`，或为新连线导致的倒挂）时，列入本次编辑必须处理的 `conflicts` 列表；**不触碰、不报错与本次编辑无关的历史存量倒挂**。
3. **局部级联顺延（`cascade: true` 仅限本次受影响子图）**：
   - 确定本次编辑的起点任务 `rootTaskId`（`move`/`resize` 为 `taskId`，`link` 为 `toId`），沿依赖关系向下游求可达子图 `affectedSet`。
   - 当 `editOperation.cascade === true` 时：**仅对 `affectedSet` 内的任务**按拓扑序检查其直接上游 `u`，若因本次编辑导致 `toDay(v.start) < toDay(u.end)`（即相对编辑前新增或加重了倒挂），自动将 `v` 顺延至 `newStart = u.end`、`newEnd = fromDay(toDay(u.end) + dur - 1)`（保持 `v` 原工期 `dur` 不变），并将被顺延的任务 ID 记入 `cascadedTaskIds`。**严禁顺手改动 `affectedSet` 之外的其他历史排期**。
   - 当 `editOperation.cascade !== true` 且 `conflicts.length > 0` 时：返回 `valid: false`、`code: 'DEPENDENCY_CONFLICT'`，要求用户勾选级联顺延或调整日期解决倒挂后才能保存。

#### 返回值结构
```js
{
  valid: true,                       // boolean: 无环、日期合法且无未解决的新增/加重倒挂冲突时为 true
  code: 'OK',                        // 'OK' | 'CYCLE_DETECTED' | 'DEPENDENCY_CONFLICT' | 'INVALID_DATE_RANGE' | 'SELF_DEPENDENCY' | 'DUPLICATE_DEPENDENCY' | 'UNKNOWN_TASK'
  message: '',                       // 错误或提示信息
  cyclePath: [],                     // 若 code === 'CYCLE_DETECTED'，返回环路节点 ID 数组
  conflicts: [                       // 本次编辑引入或加重的排期倒挂冲突列表（downstream.start < upstream.end）
    { upstreamId: 'T-3', downstreamId: 'T-5', upstreamEnd: '2026-11-20', downstreamStart: '2026-11-18', overlapDays: 2 }
  ],
  cascadedTaskIds: ['T-5'],          // 当 cascade: true 时在受影响子图内被自动顺延的下游任务 ID 列表
  suggestedReason: '调整 T-5 计划排期至 2026-11-20 ~ 2026-11-22', // 自动生成的变更原因预填文案
  nextPlan: { project, milestones, tasks } // 应用变更后的新计划深拷贝对象（结构/环错误时为 null；仅 DEPENDENCY_CONFLICT 时仍返回试算快照供界面高亮预览）
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
     - 松开鼠标（`pointerup`）后打开规划确认弹窗：若存在 `conflicts`，弹窗提示新增倒挂冲突并提供「同时顺延受影响的下游任务 (`cascade`)」开关（未解决新增/加重倒挂前禁用保存提交），确认后携带锁定时的 `base.revision` 调用 `POST /api/plan/save`。
   - 在界面图例或规划说明中注明：「规划预检支持同日交接（下游可在上游结束当日开始）；模拟演练按完成后次日开工推演」。
2. **SVG 依赖连线层与拖拽建连（Dependency Link Layer）**：
   - 在甘特图时间线区域增加 `<svg class="gantt-links">` 图层，绘制任务间的依赖折线/贝塞尔曲线（带箭头 marker）；关键路径上的依赖线使用红色实线，普通依赖使用浅灰蓝线。
   - 在 `plannerMode === true` 时：
     - 每个任务条右侧显示输出锚点 `<i class="dep-anchor out" data-dep-from="T-x" title="拖拽至下游任务以建立依赖"></i>`，左侧显示输入锚点 `<i class="dep-anchor in" data-dep-to="T-y"></i>`；
     - 从输出锚点拖拽至目标任务时，实时调用 `previewPlanEdit(..., { type: 'link', fromId, toId })`：若 `code === 'CYCLE_DETECTED'` 等错误则连线变红并禁止提交；若产生倒挂冲突则提示勾选级联顺延后保存；
     - 在规划模式下点击已有的依赖连线，可确认解除该依赖（`type: 'unlink'`）。

---

## 2. 方向二：时间机器与历史演进回放（T-28 & T-29）

### 2.1 Git 历史计划切片提取与演进差异算法（T-28 · `server/history.mjs`、`server/server.mjs`、`web/analysis.js`）

#### 1) 服务端 Git 历史切片提取（`server/history.mjs`）
新增模块 `server/history.mjs`，通过 `execFileSync('git', ...)` 安全读取指定项目仓库中 `plan.md` 的历史提交序列（禁止 shell 拼接，严格限制在 `project.repoRoot` 内）：
- **获取历史提交列表 `listPlanHistory(project, limit = 50)`**：
  - 计算计划文件相对于 `project.repoRoot` 的相对路径 `relPlanPath`（使用 POSIX 斜杠）。
  - 执行 `git log -n <limit> --format=%H%x09%h%x09%ad%x09%an%x09%s --date=iso-strict -- <relPlanPath>`。
  - 对每个 commit，使用 `git show <hash>:<relPlanPath>` 读取当时的文件内容，并用 `parseFrontMatter` 与 `validate` 尝试解析：
    - 仅保留能成功解析出有效 `tasks` 列表且通过 `validate` 的历史快照点；
    - 提取当时的摘要指标：`taskCount`、`doneCount`、`overall`（调用 `compute(data, commitDate).summary.overall`）；
    - 按时间**从旧到新**排列 `commits` 数组，并将当前工作区实时状态单独放在顶层 `current` 字段。
- **获取指定历史版本详情 `getPlanAtCommit(project, commitHash)`**：
  - 校验 `commitHash` 必须匹配 `/^[0-9a-f]{7,40}$/i`。
  - 读取该 commit 下的 `plan.md` 解析为 `data`，同时读取当前工作区计划（记录 `currentRevision`）并调用 `computeTimelineDiff(data, currentData)` 生成 `diff`。

#### 2) 时间线演进对比纯函数（`web/analysis.js`）
在 `web/analysis.js` 中新增导出纯函数 `computeTimelineDiff(baselinePlan, currentPlan)`：
- 按任务 `id` 对比 `baselinePlan`（历史基线或某次历史 commit）与 `currentPlan`：
  ```js
  {
    baselineProject: baselinePlan.project,
    currentProject: currentPlan.project,
    summary: {
      addedCount: 2,
      removedCount: 0,
      shiftedCount: 5,         // 共同任务中 start 或 end 发生变化的任务数
      totalSlipDays: 8,        // 所有共同任务 (toDay(current.end) - toDay(baseline.end)) 之和
    },
    tasks: {
      'T-4': {
        status: 'common' | 'added' | 'removed',
        baselineStart: '2026-11-19',
        baselineEnd: '2026-11-25',
        currentStart: '2026-11-19',
        currentEnd: '2026-11-27',
        startShiftDays: 0,     // common 时为 toDay(currentStart) - toDay(baselineStart)，否则为 null
        endShiftDays: 2,       // common 时为 toDay(currentEnd) - toDay(baselineEnd)，否则为 null
        durationDelta: 2,      // common 时为 currentDur - baselineDur，否则为 null
        progressDelta: 40,     // common 时为 current.progress - baseline.progress，否则为 null
      }
    }
  }
  ```

#### 3) REST API 契约（已对齐 `current` 单列与详情 `diff` 字段）
- `GET /api/history?project=<id>&limit=30`：
  - `commits` 仅存放 Git 历史提交（从旧到新），当前工作区单列为顶层 `current`：
    ```json
    {
      "projectId": "default",
      "current": {
        "revision": "a1b2c3d4...",
        "date": "2026-11-18",
        "taskCount": 35,
        "doneCount": 25,
        "overall": 71.4
      },
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
  - 返回指定 commit 的历史计划 `data`、对比结果 `diff` 以及对比所用的当前计划版本号 `currentRevision`：
    ```json
    {
      "projectId": "default",
      "currentRevision": "a1b2c3d4...",
      "commit": {
        "hash": "94252d6...",
        "shortHash": "94252d6",
        "date": "2026-11-17",
        "timestamp": "2026-11-17T18:20:00+08:00",
        "author": "dev",
        "subject": "feat(T-8..T-16): 完成 M2/M3 ..."
      },
      "data": { "project": "...", "milestones": [...], "tasks": [...] },
      "diff": { "baselineProject": "...", "currentProject": "...", "summary": { ... }, "tasks": { ... } }
    }
    ```

### 2.2 时间机器回放控制栏与基线幽灵条叠加视图（T-29 · `web/index.html`、`web/app.js`、`web/style.css`）

1. **甘特图控制栏新增「时间机器（Time Machine）」开关与回放条**：
   - 在甘特图顶部控制栏新增 `<button type="button" id="timeMachineBtn">时间机器</button>` 与 `<label><input type="checkbox" id="showBaselineGhost"> 叠加基线幽灵条</label>`。
   - 展开时间机器面板 `#timeMachineBar`：包含 `<button id="tmPlayPause">▶ 播放</button>`、时间轴滑块 `<input type="range" id="tmSlider">`、倍速选择（`1x / 2x`）、当前帧信息（Commit 短哈希、提交日期、提交说明、当时总进度）以及 `<button id="tmExit">退出回放</button>`。
2. **回放模式与基线幽灵条（Ghost Bars）**：
   - 当勾选「叠加基线幽灵条」或处于「时间机器回放」模式时：
     - 若回放期间本地 `last.revision` 与接口返回的 `currentRevision` 不一致，前端可直接使用本地最新的 `last.data` 调用 `computeTimelineDiff(historicalData, last.data)` 刷新对比基准；
     - 在每个任务行的甘特图背景层渲染半透明虚线边框的**历史基线条（`.bar.ghost`）**；若现行结束日比基线推迟（`endShiftDays > 0`），显示 `+N天` 偏移角标。
   - 回放历史帧期间，顶栏显示「历史回放模式 · 只读」提示横幅并禁用所有写操作，点击「退出回放」恢复实时视图。

---

## 3. 方向三：单文件离线驾驶舱导出与脱敏报告分享（T-30 & T-31）

### 3.1 自包含离线 HTML 打包器与脱敏清洗纯函数（T-30 · `server/exporter.mjs`、`web/analysis.js`、`server/server.mjs`）

#### 1) 计划数据脱敏纯函数 `sanitizePlanForShare(plan, options = {})`（`web/analysis.js`）
- **输入参数**：
  - `plan`: 原始计划数据对象 `{ project, milestones, tasks }`（深拷贝处理，不修改入参）。
  - `options`:
    - `maskOwners` (`boolean`, 默认 `false`)：是否脱敏负责人姓名。若为 `true`，按负责人首次出现顺序映射为固定代号 `成员-A`、`成员-B`、`成员-C`……（同一负责人保持同一代号，保证人员负载表仍具分析价值）。
    - `stripInternalNotes` (`boolean`, 默认 `false`)：是否剔除显式标记的内部备注。**注意：不得盲目删除普通括号内容（如 `(环检测与下游冲突顺延试算)` 属于正常标题）**；仅删除标题中匹配 `/\s*(?:\[内部[:：][^\]]*\]|【内部[:：][^】]*】|<!--[\s\S]*?-->)\s*/g` 的显式内部标记。
    - `customTitle` (`string`, 可选)：自定义导出的项目展示标题（若非空则替换 `sanitizedPlan.project`）。
- **返回值**：
  - `{ plan: sanitizedPlan, ownerMap: { 'codex': '成员-A', ... } }`。
  - **脱敏源码安全红线**：`ownerMap` 仅作为函数返回值供调用方内存预览使用，**`buildStandaloneHtml` 严禁将 `ownerMap` 或脱敏前的原负责人标识写入导出的 HTML 源码中**。

#### 2) 单文件自包含 HTML 生成器 `buildStandaloneHtml(payload, options)`（`server/exporter.mjs`）
- **输入与脱敏覆盖范围**：
  - 当 `options.maskOwners === true` 时：HTML 内仅包含替换后的 `成员-A / 成员-B` 数据；且自动强制排除 Git 提交历史（因为 Git commit author/message 可能包含实名或内部信息）。
  - 当 `options.stripInternalNotes === true` 时：导出包中**完全排除 Git 提交历史 `commits` 与 `plan.md` 的 `# 计划说明` 变更记录正文**。
- **自包含离线交互能力**：
  - 内联 `web/style.css` 样式表；
  - 内联安全转义后的数据快照 `window.__OFFLINE_PLAN__ = ...`（将 `<` 转义为 `\u003c`、`\u2028/\u2029` 转义防止脚本截断与 XSS）；
  - 包含完整的可交互只读视图：KPI 卡片、甘特图（支持「适应 / 日 / 周 / 月」缩放切换、里程碑展开/折叠、点击任务查看详情）、SVG 燃尽图（支持按里程碑筛选）、里程碑卡片、风险列表与人员负载表；
  - 页面顶栏标注 `离线只读快照 · 导出于 YYYY-MM-DD`，不包含任何写操作按钮或网络请求。

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
  - **响应**：统一返回 JSON `200 { ok: true, filename: "task-orchestration-2026-11-18.html", html: "<!doctype html>..." }`。

### 3.2 离线驾驶舱导出弹窗与一键分享交互（T-31 · `web/index.html`、`web/app.js`）

- 在侧栏「进度报告」卡片新增 **「导出离线网页 (.html)」** 按钮（`#exportHtmlBtn`）。
- 点击后打开 `<dialog id="exportHtmlDialog" class="task-dialog">`：
  - **导出标题**：默认当前项目名，可修改为对外汇报名称；
  - **脱敏选项**：
    - `<input type="checkbox" id="exportMaskOwners">` 匿名化负责人（替换为 成员-A / 成员-B，源码不留原名）
    - `<input type="checkbox" id="exportStripNotes">` 排除 Git 提交记录、计划变更说明及 `[内部:...]` 标记
  - **安全提示**：弹窗内提示「注：普通括号内容会保留，请导出前确认任务标题不含敏感信息」；
  - 点击「生成并下载 HTML」调用 `POST /api/export/html` 并触发浏览器下载。

---

## 4. 方向四：精细化工时、工作日历与预估准确率核算（T-32 & T-33）

### 4.1 工作日历与工时侧车服务及预估准确率算法（T-32 · `server/capacity.mjs`、`web/analysis.js`、`server/server.mjs`）

> **设计原则**：严格遵守 `PLAN_SPEC.md`，不改动 `plan.md` 的 YAML 字段。工作日历与任务级故事点/工时存储在项目侧车文件 `plan/capacity.json`（多项目则在目标项目的 `dirname(project.planPath)/capacity.json`，已加入 `.gitignore`）。

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
  1. 若日期在 `holidays` 中 $\rightarrow$ 非工作日；
  2. 否则若日期在 `workdays`（调休补班日）中 $\rightarrow$ 工作日；
  3. 否则若 `excludeWeekends !== false`（默认 `true`）且为周六/周日 $\rightarrow$ 非工作日；
  4. 其余为有效工作日。

#### 2) 纯函数：`countWorkingDays` 与 `computeCapacityMetrics`（`web/analysis.js`）
在 `web/analysis.js` 中新增导出纯函数（**已明确纯休息日返回 `0` 与「填报 vs 推算」准确率统计口径**）：
- **`countWorkingDays(startStr, endStr, calendarConfig = {})`**：
  - 精确返回 `[startStr, endStr]` 闭区间内的有效工作日天数（整数 $\ge 0$）。
  - **纯休息日区间严格返回 `0`**（不做最低 1 天兜底；最低 1 天仅用于下方计算默认预估工时 `defaultEstimateHours` 与默认故事点）。
- **`computeCapacityMetrics(plan, capacityConfig = {}, todayStr)`**：
  - **单任务核算口径（区分 `reported` 填报值与 `inferred` 推算值）**：
    - `calendarDays`: `toDay(task.end) - toDay(task.start) + 1`；
    - `workingDays`: `countWorkingDays(task.start, task.end, capacityConfig)`；若 `workingDays === 0`，在 `calendarWarnings` 中生成预警 `{ id: task.id, message: '计划排期完全处于周末或节假日(有效工作日为 0)' }`；
    - `defaultEstimateHours`: `Math.max(1, workingDays) * hoursPerDay`；
    - `estimateSource`: 若 `capacityConfig.tasks?.[id]?.estimateHours > 0` 则为 `'reported'`，否则为 `'inferred'`；
    - `estimateHours`: `estimateSource === 'reported' ? capacityConfig.tasks[id].estimateHours : defaultEstimateHours`；
    - `storyPoints`: `capacityConfig.tasks?.[id]?.storyPoints > 0 ? capacityConfig.tasks[id].storyPoints : Math.max(1, workingDays)`；
    - `actualWorkingDays`: 若有 `actualStart`，计算 `countWorkingDays(task.actualStart, task.actualEnd || todayStr, capacityConfig)`，否则为 `null`；
    - `actualSource`:
      - 若 `capacityConfig.tasks?.[id]?.actualHours > 0` $\rightarrow$ `'reported'`（实测填报）；
      - 否则若 `task.status === 'done'` $\rightarrow$ `'inferred'`（按实际起止日期推算）；
      - 否则 $\rightarrow$ `'none'`；
    - `actualHours`:
      - 若 `actualSource === 'reported'` $\rightarrow$ `capacityConfig.tasks[id].actualHours`；
      - 若 `actualSource === 'inferred'` $\rightarrow$ `Math.max(1, actualWorkingDays ?? 1) * hoursPerDay`；
      - 否则 $\rightarrow$ `null`；
    - `inflationRatio` 与 `accuracyPct`：
      - 仅当 `task.status === 'done'` 且 `actualSource === 'reported'`（**已完成且有实测填报工时**）时计算单任务的实测准确率与膨胀系数：
        - `inflationRatio = Math.round((actualHours / estimateHours) * 100) / 100`
        - `accuracyPct = Math.round(Math.max(0, 1 - Math.abs(actualHours - estimateHours) / estimateHours) * 1000) / 10`
      - 若未完成或仅为推算工时（`actualSource !== 'reported'`），单任务的 `inflationRatio` 与 `accuracyPct` 为 `null`（避免用日期推算值制造虚假的准确率）。
  - **团队整体与按负责人聚合统计口径**：
    - `sampledDoneCount`: 已完成且 `actualSource === 'reported'` 的实测样本任务数；
    - `overallAccuracyPct`: 若 `sampledDoneCount > 0`，为所有实测样本任务 `accuracyPct` 的算术平均值（保留 1 位小数）；**若 `sampledDoneCount === 0`，严格返回 `null`**；
    - `overallInflationRatio`: 若 `sampledDoneCount > 0`，为所有实测样本任务 ` ∑ actualHours / ∑ estimateHours`（保留 2 位小数）；**若 `sampledDoneCount === 0`，严格返回 `null`**；
    - `byOwner` 中每个负责人的 `sampledDoneCount`、`accuracyPct`、`inflationRatio` 遵循完全相同的实测样本口径。

#### 返回值结构示例
```js
{
  hoursPerDay: 8,
  totalStoryPoints: 68,
  completedStoryPoints: 50,
  totalEstimateHours: 544,
  reportedActualHours: 30,           // 已填报实测工时总和
  inferredActualHours: 382,          // 未填报但按实际日期推算的工时总和
  sampledDoneCount: 2,               // 参与准确率计算的实测已完成样本数
  overallAccuracyPct: 87.5,          // sampledDoneCount === 0 时为 null
  overallInflationRatio: 1.05,       // sampledDoneCount === 0 时为 null
  calendarWarnings: [
    { id: 'T-8', message: '计划排期完全处于周末或节假日(有效工作日为 0)' }
  ],
  byOwner: [
    {
      owner: 'codex',
      taskCount: 18,
      doneCount: 13,
      sampledDoneCount: 2,
      storyPoints: 40,
      estimateHours: 320,
      reportedActualHours: 30,
      inferredActualHours: 210,
      accuracyPct: 87.5,             // sampledDoneCount === 0 时为 null
      inflationRatio: 1.05           // sampledDoneCount === 0 时为 null
    }
  ],
  tasks: {
    'T-26': {
      calendarDays: 2,
      workingDays: 2,
      storyPoints: 3,
      estimateSource: 'reported',
      estimateHours: 16,
      actualSource: 'reported',
      actualHours: 14,
      inflationRatio: 0.88,
      accuracyPct: 87.5
    }
  }
}
```

#### 3) REST API 契约
- `GET /api/capacity?project=<id>`：返回 `{ projectId, config, metrics }`。
- `POST /api/capacity?project=<id>`：校验并保存 `{ hoursPerDay, excludeWeekends, holidays, workdays, tasks }`，返回 `200 { ok: true, projectId, config, metrics }`。

### 4.2 工作日历与工时故事点配置面板及预估偏差视图（T-33 · `web/index.html`、`web/app.js`）

- 侧栏「工时与预估核算」卡片明确区分展示「填报工时」与「推算工时」，准确率旁标注样本数 `（基于 N 项实测样本）`；当 `sampledDoneCount === 0` 时显示「暂无实测样本（请在配置中填报实际工时）」。
- 配置弹窗支持编辑工作日历（节假日/调休补班日）及各任务的 `storyPoints / estimateHours / actualHours`。

---

## 5. 方向五：代码托管平台深度联动（T-34 & T-35）

### 5.1 GitHub 与 GitLab Issue 双向同步适配器与服务接口（T-34 · `server/integrations.mjs`、`server/server.mjs`）

#### 1) 侧车配置文件 `plan/integrations.json`（已加入 `.gitignore`）
按项目存储平台连接配置与任务-Issue 映射表（绝不将 Token 明文返回给前端）：
- `apiBase` 仅允许公网 `https:` 地址（复用 SSRF 私网地址拦截校验）；
- `GET /api/integrations` 响应中 `token` 固定为 `""`，通过 `tokenConfigured: boolean` 标识是否已配置凭证；保存时若 `token === ""` 则保留原已存 Token。

#### 2) 双向同步与冲突裁决规则（已明确版本锁、已完成任务不自动回退、推送需指定任务）
- **导出纯函数 `buildIssuePayload(provider, task, milestone)`**：
  - Title: `[${task.id}] ${task.title}`
  - State: `task.status === 'done' ? 'closed' : 'open'`
  - Labels: `['task-orchestration', \`milestone:${task.milestone}\`, \`status:${task.status}\`]`
- **导出纯函数 `reconcileIssuesWithPlan(plan, remoteIssues, issueMap = {}, todayStr)`**：
  - 匹配规则：优先按 `issueMap[task.id]?.number` 匹配；未映射时按远端 Issue 标题正则 `/^\[(T-\d+)\]\s*(.+)$/` 识别。
  - **拉取同步裁决规则（`direction: 'pull'`）**：
    1. **首版绝不自动回退本地已完成任务**：若本地任务 `task.status === 'done'`，而远端 Issue 处于 `open` 或带有 `status:blocked` / `status:doing` 标签，**不修改本地任务状态**，将其加入 `skippedConflicts: [{ id: task.id, number: issue.number, localStatus: 'done', remoteState: issue.state, reason: '本地任务已完成，不自动回退状态' }]` 供前端展示提醒；
    2. 若本地任务未完成（`status !== 'done'`）且远端 Issue 为 `closed`：将本地任务更新为 `status: 'done'`、`progress: 100`、`actualStart: task.actualStart || todayStr`、`actualEnd: todayStr`；
    3. 若本地任务未完成且远端 Issue 为 `open`：
       - 含标签 `status:blocked` $\rightarrow$ 更新本地为 `status: 'blocked'`（若原为 `todo` 则 `actualStart: task.actualStart || todayStr`）；
       - 含标签 `status:doing` 且本地为 `todo` $\rightarrow$ 更新本地为 `status: 'doing'`、`progress: Math.max(10, task.progress)`、`actualStart: todayStr`。
  - **拉取写回与版本锁校验**：
    - 拉取同步仅更新任务执行态字段（`status / progress / actualStart / actualEnd`），不改动计划结构与排期，因此无需填写规划者结构变更 `reason`；
    - 支持 `dryRun: true`（仅拉取远端 Issue 并返回 `proposedUpdates` 与 `skippedConflicts` 预览，不写磁盘）；
    - 当 `dryRun !== true` 正式写回 `plan.md` 时：**请求体必须携带 `expectedRevision`**，服务端校验当前 `plan.md` 的 `revision === expectedRevision`（不一致返回 `409 { message: "计划已变化，请重新预览后再确认同步" }`），校验通过后使用 `updatePlanMarkdown` + `verifyTaskUpdates` 写回。
  - **推送安全限制（`direction: 'push'`，防止误建大批 Issue）**：
    - 默认要求请求体传入非空数组 `taskIds: ['T-26', ...]`，仅对显式选中的任务创建或更新远端 Issue；
    - 若未传 `taskIds` 或为空数组，必须显式传入 `allowAll: true`（前端需经二次确认），否则服务端返回 `400 { message: "请先选择要推送的任务，或显式确认全量推送(allowAll)" }`。

#### 3) REST API 契约
- `GET /api/integrations?project=<id>`：返回脱敏配置与 `issueMap`。
- `POST /api/integrations?project=<id>`：保存项目集成配置。
- `POST /api/integrations/sync?project=<id>`：
  - **请求体**：
    ```json
    {
      "direction": "pull",
      "dryRun": false,
      "expectedRevision": "a1b2c3d4...",
      "taskIds": ["T-26"],
      "allowAll": false
    }
    ```
  - **响应**：
    ```json
    {
      "ok": true,
      "direction": "pull",
      "dryRun": false,
      "created": [],
      "updated": ["T-26"],
      "touchedTasks": [{ "id": "T-26", "beforeStatus": "doing", "afterStatus": "done" }],
      "skippedConflicts": [
        { "id": "T-1", "number": 10, "localStatus": "done", "remoteState": "open", "reason": "本地任务已完成，不自动回退状态" }
      ],
      "issueMap": { ... }
    }
    ```

### 5.2 平台集成配置弹窗与任务 Issue 绑定交互（T-35 · `web/index.html`、`web/app.js`）

1. **平台配置与同步弹窗（`<dialog id="integrationDialog">`）**：
   - 支持配置 `GitHub / GitLab`、API 地址、仓库标识与 Token；
   - **拉取流程**：点击「预览远端拉取」先以 `dryRun: true` 请求，展示将更新的任务及被跳过的已完成冲突项（`skippedConflicts`），点击「确认写入」时携带当前锁定的 `expectedRevision` 执行正式拉取；
   - **推送流程**：默认提供任务多选列表（或在任务详情中单任务一键推送），全量推送需勾选确认框后传 `allowAll: true`。
2. **任务详情 Issue 徽章**：已绑定 Issue 的任务在详情栏显示 `#编号 (open/closed)` 外部链接徽章。

---

## 6. 任务分工与验收矩阵汇总

| 任务 ID | 方向 | 负责人 | 核心交付物与修改文件 | 关键验收点 |
|---|---|---|---|---|
| **T-26** | 方向一 | `codex` | `web/metrics.js`, `tests/simulation.test.mjs` | `previewPlanEdit` 允许同日交接，检出环路与新增/加重倒挂冲突，`cascade` 仅顺延本次受影响子图 |
| **T-27** | 方向一 | `antigravity` | `web/index.html`, `web/app.js`, `web/style.css` | 规划模式下甘特条双端拉伸、SVG 依赖连线与拖拽建连/断连、新增倒挂冲突必解拦截与级联顺延勾选 |
| **T-28** | 方向二 | `codex` | `server/history.mjs`, `server/server.mjs`, `web/analysis.js`, `tests/` | `GET /api/history` 顶层单列 `current`、列表仅放 Git 历史，详情返回 `data`、`diff` 与 `currentRevision` |
| **T-29** | 方向二 | `antigravity` | `web/index.html`, `web/app.js`, `web/style.css` | 时间机器回放控制栏、滑块播放历史帧、甘特图叠加半透明历史基线幽灵条与偏移角标 |
| **T-30** | 方向三 | `codex` | `server/exporter.mjs`, `web/analysis.js`, `server/server.mjs`, `tests/` | `sanitizePlanForShare` 不将 `ownerMap` 写入 HTML、不误删正常括号，脱敏排除 Git 历史与计划说明 |
| **T-31** | 方向三 | `antigravity` | `web/index.html`, `web/app.js` | 离线驾驶舱导出配置弹窗（自定义标题、匿名化负责人、排除提交与内部标记、标题检查提醒） |
| **T-32** | 方向四 | `codex` | `server/capacity.mjs`, `web/analysis.js`, `server/server.mjs`, `tests/` | `countWorkingDays` 纯休息日返回 `0`；区分填报与推算工时，准确率仅统计已完成实测样本并附样本数 |
| **T-33** | 方向四 | `antigravity` | `web/index.html`, `web/app.js`, `web/style.css` | 侧栏工时卡片区分「填报/推算」与样本数（无样本显示暂无数据），工作日历与任务工时配置弹窗 |
| **T-34** | 方向五 | `codex` | `server/integrations.mjs`, `server/server.mjs`, `tests/` | 拉取支持 `dryRun` 预览与 `expectedRevision` 校验、不自动回退本地 `done` 任务；推送默认要求明确 `taskIds` |
| **T-35** | 方向五 | `antigravity` | `web/index.html`, `web/app.js`, `web/style.css` | 平台配置弹窗、拉取预览确认与冲突提示、单任务/指定任务推送交互、任务详情 Issue 链接徽章 |
