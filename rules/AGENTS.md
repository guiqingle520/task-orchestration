# 任务时间线驾驶舱 MCP 协作规则

- 需要查询多项目进度、待跟进任务、可开工任务或单个任务的验收要求时，优先调用 `plan_list_projects`、`plan_get_overview`、`plan_get_task` 工具。
- 更新任务执行状态前，先调用 `plan_get_task` 获取当前 `expected` 快照，再调用 `plan_update_task` 原子写回；若返回 `409 / CONFLICT`，必须重新读取最新状态后再决定是否重试，不得覆盖其他智能体的进度。
- `plan_update_task` 仅用于更新任务执行字段（`status` / `progress` / `actualStart` / `actualEnd`）；调整任务结构、依赖或计划日期仍须遵守 `docs/PLAN_SPEC.md` 规划者权限。
- 完成任意计划变更后，调用 `plan_validate` 确认 `plan/plan.md` 校验通过。
