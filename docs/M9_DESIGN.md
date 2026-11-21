# M9 阶段详细技术设计规范（T-67 ~ T-72 · V2 评审定稿）

本文档定义里程碑 **M9（多负责人与多智能体协同、任务认领锁与动态面板）** 的完整技术方案、跨进程协调锁机制、租约代次（`leaseId`）防抢单协议、纯函数签名、MCP 与 REST API 契约、前端交互规范及回归验收矩阵。

> 本规范已吸收本地 Multica **「方案头脑风暴智囊团」（工单 `GUIQ-26`：软件架构师、产品经理、UI/UE 设计师、测试工程师、风险与反方顾问 + 智囊团主持人）** 的五视角独立评审结论。

---

## 0. 核心架构约束与信任边界

1. **零第三方运行依赖**：仅使用 Node.js 内置标准库（`node:fs`、`node:path`、`node:crypto`、`node:http`）与原生浏览器 ES Module + DOM/SVG。
2. **`plan.md` 格式严守规范**：严格遵守 `docs/PLAN_SPEC.md`，**不得向 `plan/plan.md` 的 YAML front matter 增删任何字段**。多负责人名录（Roster）、认领租约（Lease）、执行心跳（Heartbeat）与双轨事件日志一律通过项目隔离的侧车文件承载，并加入 `.gitignore`。
3. **开放式多负责人模型（分离 `task.owner` 与 `claim.actor`）**：
   - `task.owner` 是 `plan/plan.md` 中的**计划责任归属人**（仅规划模式可改，用于排期、人员负载与按负责人筛选）；
   - `claim.actor` 是当前实际持锁执行该任务的**认领执行者**（支持任意人类成员如 `alice`、`bob`、团队代号或智能体实例如 `codex`、`antigravity`、`claude-code`、`codex#1`）；
   - 认领、心跳续租、超时接管与释放**绝不自动篡改 `plan.md` 中的 `task.owner`**。
4. **单机协作信任边界声明**：
   - `actor` 是单机本地工作区内合作进程（Web 驾驶舱、多个 stdio MCP 客户端、Git 钩子）的自报标识，提供**协作式防抢单、防并发误覆盖与失联接管协调**，不作为跨机器或防恶意本地进程篡改磁盘的加密身份认证系统。

---

## 1. 计划级跨进程互斥锁与侧车存储（T-67）

### 1.1 计划级跨进程互斥锁（`server/plan-lock.mjs`）

为解决多个 stdio MCP 进程、Web 服务进程与 CLI 脚本并发读写同一项目的 `plan.md` 和 `claims.json` 时的竞态（TOCTOU）及 Windows NTFS 下 `renameSync` 瞬时 `EPERM/EACCES` 问题，引入统一跨进程协调锁：

#### 核心函数签名
- **`withPlanLock(planPath, fn, options = {})`**：
  - **锁路径规范化**：对 `resolve(planPath)` 规范化后，以同目录下的 `<planFileName>.lock` 目录作为跨进程互斥锁（`mkdirSync(lockDir)` 在 POSIX 与 Windows NTFS 上均为内核级原子操作）。
  - **锁元数据**：获取锁后在 `<lockDir>/owner.json` 写入 `{ holderId: randomUUID(), pid: process.pid, acquiredAt: new Date().toISOString() }`。
  - **有界指数退避重试**：若锁已被占用（`EEXIST`），按 `20ms -> 40ms -> 80ms -> 120ms` 退避等待，默认最长等待 `options.timeoutMs = 2500`。超时未获取锁抛出 `PlanLockError(409, 'LOCK_BUSY', '当前计划正在被另一进程写入，请稍后重试')`。
  - **僵尸锁安全回收**：绝不依据短超时盲目删锁；仅当锁存在超过 `staleLockMs`（默认 `30000ms`）且读取 `owner.json` 校验 `process.kill(pid, 0)` 确认原 PID 已不存在时，才安全回收僵尸锁。
  - **Windows 原子替换加固 `atomicReplaceFile(targetPath, content, expectedRevision = null)`**：
    - 在 `withPlanLock` 临界区内执行；
    - 先以 `flag: 'wx'` 写入唯一临时文件 `<targetPath>.<uuid>.tmp`；
    - 若传入 `expectedRevision !== null`，在持锁状态下重读 `targetPath` 校验 SHA-256 revision；
    - 调用 `renameSync(tmp, targetPath)`，若在 Windows 下遇到瞬时 `EPERM` 或 `EACCES`，在持锁期内做最多 5 次退避重试（`15ms * attempt`）；若仍失败，保留原目标文件完好，在 `finally` 中清理临时文件并抛出明确可诊断错误。

### 1.2 侧车文件命名与数据结构（`server/claims.mjs`）

- **侧车路径规则（与 `server/capacity.mjs` 同构）**：
  - 当计划文件名为默认的 `plan.md` 时，侧车文件为同目录的 `claims.json`（即 `plan/claims.json`）；
  - 当计划文件名为自定义名称（如 `sprint2.md`）时，侧车文件为同目录的 `<planFile>.claims.json`（即 `sprint2.md.claims.json`），确保同目录多计划互不串用。
  - `.gitignore` 新增 `claims.json`、`*.claims.json`、`*.lock/`。

#### 侧车 JSON 结构
```json
{
  "version": 1,
  "roster": [
    { "id": "codex", "label": "Codex", "kind": "agent", "defaultTtlMinutes": 30 },
    { "id": "antigravity", "label": "Antigravity", "kind": "agent", "defaultTtlMinutes": 30 },
    { "id": "alice", "label": "Alice (前端研发)", "kind": "human", "defaultTtlMinutes": 480 }
  ],
  "claims": {
    "T-67": {
      "taskId": "T-67",
      "leaseId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "actor": "codex",
      "actorKind": "agent",
      "ownerSnapshot": "codex",
      "claimedAt": "2026-11-23T01:00:00.000Z",
      "heartbeatAt": "2026-11-23T01:12:00.000Z",
      "expiresAt": "2026-11-23T01:42:00.000Z",
      "ttlMinutes": 30,
      "note": "已完成跨进程互斥锁与代次校验单测"
    }
  },
  "activityLog": [
    {
      "id": "evt-1",
      "at": "2026-11-23T01:00:00.000Z",
      "type": "claim",
      "taskId": "T-67",
      "actor": "codex",
      "leaseId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "note": "认领任务"
    }
  ],
  "auditLog": [
    {
      "id": "aud-1",
      "at": "2026-11-23T02:00:00.000Z",
      "type": "takeover",
      "taskId": "T-67",
      "actor": "alice",
      "previousActor": "codex",
      "previousLeaseId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
      "newLeaseId": "4f8c2a11-7e12-4d3a-8b9c-1a2b3c4d5e6f",
      "reason": "原智能体租约超时，转由人工接管收尾"
    }
  ]
}
```

### 1.3 租约状态判定与名录聚合纯函数（`web/claims.js` · 浏览器与 Node 共用）

- **差异化默认 TTL 策略**：
  - `kind === 'human'`：默认 `ttlMinutes = 480`（8 小时），允许范围 `5 ~ 1440` 分钟（24 小时）；
  - `kind === 'agent'`（或未指定）：默认 `ttlMinutes = 30`（30 分钟），允许范围 `5 ~ 240` 分钟（4 小时）。
- **纯函数 `evaluateClaims(claimsConfig, plan, nowIso)`**：
  - **时间注入**：必须使用显式传入的 `nowIso`（ISO 8601 字符串或毫秒时间戳）做比较，不隐式调用 `Date.now()`，保证时钟偏移与超时边界测试完全确定。
  - **名录自动聚合 `mergedRoster`**：
    - 合并 `claimsConfig.roster`、`plan.tasks[].owner` 与当前 `claimsConfig.claims` 中的 `actor`；
    - 未在 `roster` 显式配置的标识，按启发式默认归类（匹配 `/^(?:codex|antigravity|claude|cursor|qoder|copilot|opencode|agent)(?:[#_-].*)?$/i` 为 `'agent'`，其余默认 `'human'`），用户可在名录管理中显式指定 `kind` 与 `label`。
  - **单任务租约状态判定**：
    - 若 `taskId` 在 `plan.tasks` 中已不存在 $\rightarrow$ `state: 'orphaned'`（孤儿租约，提示清理，绝不抛错崩溃）；
    - 若对应任务 `task.status === 'done'` $\rightarrow$ `state: 'done_pending_reconcile'`（读视图不视为活跃锁，写入口自动按代次幂等清理）；
    - 若 `Date.parse(nowIso) < Date.parse(claim.expiresAt)` $\rightarrow$ `state: 'active'`，计算 `remainingMs` 与 `remainingMinutes`；
    - 若 `Date.parse(nowIso) >= Date.parse(claim.expiresAt)` $\rightarrow$ `state: 'stale'`（已超时可接管），计算 `overdueMinutes`。

---

## 2. 全写入口防绕过、租约代次校验与 MCP 工具集（T-68 & T-69）

### 2.1 全写入口统一收口矩阵

所有修改 `plan.md` 或 `claims.json` 的入口必须在同一项目的 `withPlanLock(project.planPath, ...)` 内执行，并遵守以下租约规则：

| 写入口 | 租约校验与幂等自愈规则 |
|---|---|
| **进入任何写入口前（自愈预处理）** | 扫描 `claims`：若某条租约对应的 `plan.tasks` 任务已处于 `status === 'done'`，自动移除该残留租约并记入 `activityLog`（`type: 'auto_reconcile_done'`），消除“写完 `done` 崩溃未释放”留下的死锁。 |
| **`plan_claim_task` / `POST /api/claims (claim)`** | • 若任务不存在 $\rightarrow$ `404 TASK_NOT_FOUND`。<br>• 若任务已 `status === 'done'` $\rightarrow$ `409 TASK_ALREADY_DONE`（禁止认领已完成任务）。<br>• 若当前无租约：创建新租约并生成全新 `leaseId = randomUUID()`。<br>• 若当前有 `active` 租约：<br>  - 若 `claim.actor === input.actor`（且未传不同 `expectedLeaseId`）：幂等续租（刷新 `heartbeatAt/expiresAt/note`，保留原 `leaseId`）；<br>  - 若 `claim.actor !== input.actor` 且 `force !== true`：返回 `409 TASK_ALREADY_CLAIMED`（携带当前 `claim` 详情）；<br>  - 若 `force === true`：必须提供非空 `reason`（$\ge 2$ 字），生成全新 `leaseId` 并写入 `auditLog (type: 'force_takeover')`。<br>• 若当前有 `stale`（已超时）租约：<br>  - 同一 `actor`（且传入匹配的 `expectedLeaseId` 或未发生他人接管）允许续租恢复；<br>  - 不同 `actor` 接管必须显式传 `takeoverStale: true`（或 `force: true`），生成**全新 `leaseId`** 并写入 `auditLog (type: 'takeover')`；未传 `takeoverStale: true` 时返回 `409 CLAIM_STALE_CONFIRM_REQUIRED` 提醒确认。<br>• **关于 `startImmediately`（默认 `false`）**：默认认领仅写 `claims.json`；若显式传 `startImmediately: true` 且任务为 `todo`，在同一锁内尝试将 `plan.md` 更新为 `doing (10%, actualStart: today)`。若写 `plan.md` 失败，保留认领并返回 `200 { ok: true, claim, taskStarted: false, warningCode: 'CLAIMED_BUT_NOT_STARTED' }`。 |
| **`plan_heartbeat_task` / `POST /api/claims (heartbeat)`** | • 必须传入 `id, actor, leaseId`。<br>• 若当前无租约或 `claim.leaseId !== input.leaseId`（例如超时后已被他人甚至是同名重启实例接管）：返回 `409 LEASE_SUPERSEDED`（绝不复活旧租约或篡改新接管者的租约）。<br>• 校验通过后原地更新 `heartbeatAt`、`expiresAt` 与 `note`（不刷屏 `activityLog`）。 |
| **`plan_release_task` / `POST /api/claims (release)`** | • 若传 `force: true`：必须提供非空 `reason`，移除当前租约并记入 `auditLog (type: 'force_release')`。<br>• 正常释放：必须匹配当前租约的 `actor`（若传入 `leaseId` 也必须匹配；若 `leaseId` 不匹配返回 `409 LEASE_SUPERSEDED`），移除租约并记入 `activityLog (type: 'release')`。 |
| **`plan_update_task` / `POST /api/task`** | • 若目标任务当前存在 `active` 租约：<br>  - 未传 `actor`（旧版调用）$\rightarrow$ 返回 `409 TASK_LOCKED_BY_CLAIM`（提示任务正由 `<claim.actor>` 执行中，请传入匹配 `actor/leaseId` 或等待释放，关闭旧接口绕过口）；<br>  - 传入的 `actor !== claim.actor` $\rightarrow$ 返回 `409 CLAIM_CONFLICT`；<br>  - 传入了 `leaseId` 但 `leaseId !== claim.leaseId` $\rightarrow$ 返回 `409 LEASE_SUPERSEDED`。<br>• 若目标任务当前存在 `stale` 租约且传入了过期的 `leaseId`（或旧 `actor` 在已被他人接管后迟到写回）$\rightarrow$ 返回 `409 LEASE_SUPERSEDED`。<br>• 若目标任务无租约：完全兼容旧版无 `actor` 的 `expected` 乐观锁更新。<br>• **完工条件释放**：当更新后 `task.status === 'done'` 时，在同一互斥锁内**仅当 `claim.leaseId` 仍为本次校验通过的代次时**自动释放该租约并写入 `activityLog (type: 'complete_release')`。 |
| **Git 同步（`POST /api/sync-git` & `scripts/sync-git-progress.mjs`）** | • 统一接入 `withPlanLock` 与 `expectedRevision` 原子写回。<br>• 扫描 commit 更新任务前读取当前 `claims.json`：若任务存在 `active` 租约，且该更新并非显式允许（CLI 默认保护活跃租约），**跳过对该持锁任务的自动改写**，将其记入返回值的 `skippedLockedTasks: [{ id, actor, leaseId }]`，防止无关 commit 提及 `T-x` 或历史重放静默改写/释放他人正在执行的任务。 |
| **规划模式保存（`POST /api/plan/save`）** | • 在 `withPlanLock` 内检查被删除、被拆分或被修改 `owner` 的任务是否正持有 `active` 租约。<br>• 若存在且请求体未显式传 `forceOverrideClaims: true`，返回 `409 { code: 'ACTIVE_CLAIM_CONFLICT', message: '部分任务正处于活跃认领执行中，请先释放或勾选强制覆盖', conflicts: [...] }`。<br>• 若显式传 `forceOverrideClaims: true`（或清理已删除任务的孤儿租约），在保存计划后同步清理对应孤儿租约并记入 `auditLog`。 |
| **远端 Issue 拉取确认（`POST /api/integrations/sync`）** | • 预览与正式拉取确认时检查受影响任务是否有 `active` 租约；若有他人 `active` 租约，列入 `skippedConflicts`（reason: `'本地任务正处于活跃认领锁定中'`），不静默覆盖。 |

### 2.2 MCP 工具 Schema 定义（`server/mcp.mjs`）

在保留原有 5 个工具的基础上新增 3 个工具，共 8 个工具：
1. `plan_list_projects`
2. `plan_get_overview`（新增可选布尔参数 `unclaimedOnly: false`；返回列表中每个任务附带紧凑 `claim: { state, actor, leaseId, expiresAt, note } | null`）
3. `plan_get_task`（返回 `claim` 详情；`handoff` 文本仅追加本任务的认领状态与一行带 `actor` 的 MCP 指引）
4. `plan_validate`
5. `plan_update_task`（新增可选参数 `actor: string`、`leaseId: string`）
6. **`plan_claim_task`** *(新增)*
7. **`plan_heartbeat_task`** *(新增)*
8. **`plan_release_task`** *(新增)*

### 2.3 REST API 与 SSE 实时推送契约（`server/server.mjs`）

- **`GET /api/claims?project=<id>`**：
  - 返回 `{ projectId, today, now, roster, claims, summary, activityLog, auditLog }`（其中 `claims` 与 `summary` 由 `evaluateClaims` 计算得出）。
- **`POST /api/claims?project=<id>`**：
  - 请求体支持 4 种 `action`：
    1. `action: 'claim'`：`{ action: 'claim', id, actor, actorKind?, ttlMinutes?, note?, startImmediately?, takeoverStale?, expectedLeaseId?, force?, reason? }`
    2. `action: 'heartbeat'`：`{ action: 'heartbeat', id, actor, leaseId, ttlMinutes?, note? }`
    3. `action: 'release'`：`{ action: 'release', id, actor?, leaseId?, force?, reason? }`
    4. `action: 'roster'`：`{ action: 'roster', roster: [...], cleanupOrphans?: boolean }`
- **SSE 监听扩展（`watchProject`）**：
  - `server/server.mjs` 中的 `watchProject` 同时匹配计划文件名（如 `plan.md`）与对应的侧车文件名（如 `claims.json` 或 `<planFile>.claims.json`）；任一文件发生原子替换，均在防抖后向订阅该项目的 SSE 客户端广播 `event: plan-change\ndata: changed\n\n`。
- **离线 HTML 导出零泄漏红线（`server/exporter.mjs`）**：
  - `POST /api/export/html` 继续严格使用计划结构白名单，**严禁读取或内联 `claims.json` 的任何内容（包括 `actor`、`note`、`roster`、`activityLog`、`auditLog`）**。

---

## 3. 前端多负责人、防抢单与动态面板交互设计（T-70 & T-71）

### 3.1 开放式多负责人选择器与 `owner / actor` 克制展示（T-70）

1. **多负责人候选与快捷录入**：
   - 从 `mergedRoster` 动态渲染所有负责人选项（涵盖 `plan.md` 中的既有 `owner` 与名录中的人类/智能体成员）。
   - 在「今日行动」负责人筛选、时间线负责人筛选、规划模式任务负责人输入以及认领弹窗中，支持选择已有名录成员，或直接输入新负责人标识（如 `alice`、`claude-code`、`codex#2`）。
   - 前端在 `localStorage` 中记住当前浏览器操作者最近使用的默认执行身份 `preferredActor`（仅作表单预填，不代表权限绕过）。
2. **`task.owner` 与 `claim.actor` 合并/并列显示规则**：
   - 当任务未被认领时：仅显示计划负责人 `task.owner`；
   - 当任务已被认领且 `claim.actor === task.owner` 时：合并显示 `🔒 <owner> 执行中 · 剩余 Nm`；
   - 当跨负责人委派/代领（`claim.actor !== task.owner`）时：明确并列标注 `负责人：<owner> · 🔒 执行中：<actor>（剩余 Nm）`；
   - 当租约处于 `stale` 时：显示琥珀色/红色文字标记 `⚠️ <actor> 租约已超时 Nm（可接管）`，不单靠颜色区分。
3. **保留「复制开工说明」只读承诺 + 新增「认领并复制」分步反馈**：
   - **「复制开工说明」按钮**：100% 保持 M8 的只读行为，不发认领请求、不改任务状态。
   - **开工说明弹窗（`#handoffDialog`）与「今日行动」可开工行**：
     - 弹窗内顶部新增紧凑的「认领执行设置」栏：可选择/输入执行人 `actor`、身份类型（`AI 智能体 30m` / `人类负责人 8h`）、可选勾选「认领时同步将未开始任务标为进行中 (10%)」（默认不勾选）；
     - 提供两个独立按钮：**「仅复制说明（不改状态）」** 与 **「认领并复制说明」**；
     - **分步结果反馈**：点击「认领并复制说明」时，先调用 `POST /api/claims (action: 'claim')`，成功后刷新弹窗内的开工说明文本（使其包含最新的 `leaseId` 与 `actor`），再写入剪贴板。若认领成功但浏览器剪贴板写入被拒，状态栏明确显示 `✓ 已由 <actor> 认领成功；剪贴板复制失败，请手动选中文本框复制`，绝不把复制失败误报为未认领，也绝不在认领失败时静默复制。
4. **时间机器回放模式只读隔离**：
   - 当处于时间机器历史回放模式（`timeMachine.active === true`）时，隐藏或禁用所有认领/续租/释放按钮，并在界面标注 `历史回放 · 不显示实时认领状态`。

### 3.2 视图落点：「负载与工时」动态面板与甘特图任务列锁徽章（T-71）

1. **严守 6 视图导航，不新增第 7 个主导航**：
   - 在 **`负载与工时`（`data-view="capacity"`）** 视图新增卡片 `<section class="card" id="claimsLiveCard" data-views="capacity">`（**在岗执行动态与负责人名录**）：
     - **顶部操作栏**：显示当前活跃认领数、超时失联数，提供 **「管理负责人名录」** 按钮（打开 `<dialog id="rosterDialog">` 管理 `id / 显示名 / 人类或智能体类型 / 默认租约时长` 及一键清理孤儿租约）和 **「刷新状态」** 按钮。
     - **在岗与超时列表**：展示当前项目的 `active` 与 `stale` 认领项（任务 ID 与标题、计划负责人 `owner`、执行人 `actor`、最新心跳进展 `note`、到期时间与剩余/超时分钟数），每行提供「发送心跳/备注」「释放」或「确认接管」按钮。
     - **双轨协同事件流（默认折叠或紧凑展示最近 10 条）**：支持切换查看「常规协同动态 (`activityLog`)」与「强制接管/解锁审计 (`auditLog`)」。
   - **统计口径隔离**：原有的「人员负载」卡片继续严格按 `plan.md` 的 `task.owner` 计算每周并行峰值；名录与动态卡片单独展示各负责人的「计划归属任务数」与「当前持锁执行数」。
2. **甘特图左侧固定任务列紧凑锁标识（不污染甘特条内部）**：
   - 甘特图右侧的 `.bar.plan` / `.bar.act` 内部**不放置**长姓名或倒计时（避免遮挡进度填充、双端拉伸手柄 `.resize-handle` 与依赖锚点 `.dep-anchor`）。
   - 在甘特图**左侧固定任务名称列（`.gantt-task-cell`）**中追加紧凑的无障碍锁状态胶囊 `<span class="claim-badge active|stale" aria-label="...">🔒 actor</span>`；
   - 点击任务行后，在下方 `#detail`（任务详情区）展示完整的认领卡片（当前持锁人、租约代次短码、认领时间、最后心跳时间、到期时间、最新心跳备注），并提供 **「认领任务」「更新心跳备注」「释放锁」「超时接管 / 强制解锁（需填原因）」** 操作。
3. **`390px` 窄屏与断线重连保护**：
   - 在 `390px` 视口下，「今日行动」与「在岗执行动态」列表均采用单列纵向流式排版，按钮自动换行不裁切，页面无整体横向滚动条溢出；
   - SSE 断线重连或任何认领/写回接口返回 `409` 时，前端立即重拉 `/api/plan` 与 `/api/claims` 权威快照并刷新界面。

---

## 4. 任务分工与验收矩阵（T-67 ~ T-72）

| 任务 ID | 负责人 | 核心交付物与修改文件 | 关键验收点 |
|---|---|---|---|
| **T-67** | `codex` | `server/plan-lock.mjs`, `server/claims.mjs`, `web/claims.js`, `.gitignore`, `tests/claims.test.mjs` | `withPlanLock` 跨进程互斥与 Windows `EPERM` 退避重试；`evaluateClaims` 纯函数注入 `nowIso` 判定 `active / stale / orphaned`；区分 `human (480m)` 与 `agent (30m)` 默认 TTL；`leaseId` 代次生成、`done` 任务残留锁幂等自愈及 `activityLog / auditLog` 双轨日志 |
| **T-68** | `codex` | `server/mcp.mjs`, `server/server.mjs`, `scripts/sync-git-progress.mjs`, `server/integrations.mjs` | 新增 `plan_claim_task / plan_heartbeat_task / plan_release_task`；全写入口（MCP、REST、Git 同步、规划保存、Issue 拉取）统一接入 `withPlanLock` 与租约校验；接管后旧 `leaseId`（含同名实例）请求一律 `409 LEASE_SUPERSEDED`；旧版无 `actor` 调用有锁时 `409`、无锁时兼容 |
| **T-69** | `codex` | `server/server.mjs`, `server/exporter.mjs`, `web/task-handoff.js` | 提供 `GET/POST /api/claims`；认领默认不改 `todo` 状态，`startImmediately` 半成功返回 `claimed_but_not_started`；`watchProject` 监听侧车文件变更推送 SSE；离线 HTML 导出零侧车数据泄漏 |
| **T-70** | `antigravity` | `web/index.html`, `web/app.js`, `web/style.css` | 开放式多负责人选择与录入；保留原「复制开工说明（不改状态）」并新增独立「认领并复制」与分步错误反馈；同 `owner/actor` 合并展示、跨人代领并列展示；时间机器回放只读隔离 |
| **T-71** | `antigravity` | `web/index.html`, `web/app.js`, `web/style.css` | 在「负载与工时」页构建在岗执行动态、双轨事件流与名录管理弹窗；甘特图固定任务名称列渲染紧凑锁徽章，详情区支持认领、心跳备注、超时二次确认接管与必填原因强制解锁；`390px` 窄屏与键盘无障碍适配 |
| **T-72** | `codex` | `tests/mcp.test.mjs`, `tests/claims-e2e.test.mjs`, `tests/exporter.test.mjs` | 覆盖 5 大边界的自动化回归测试套件（双进程同步屏障并发抢单、超时接管后旧代次拦截、半成功重启自愈、Git 同步与规划删改持锁任务拦截、离线 HTML 导出源码零侧车泄漏）全量通过 |
