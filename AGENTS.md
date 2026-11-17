# 智能体规则

## 计划规则(强制)
- 任何编码任务开始前,必须先在 `plan/plan.md` 生成或更新排期,格式严格遵循 `docs/PLAN_SPEC.md` 和 `plan/plan.template.md`。未完成前不得开始写代码。
- 任务开始/完成时,必须更新对应任务的 `status`、`progress`、`actualStart`、`actualEnd`。
- 每次修改 `plan/plan.md` 后必须运行 `node scripts/validate-plan.mjs`,通过后才能结束任务。
- 只有规划者可以改任务结构、依赖和计划日期,详见 `docs/PLAN_SPEC.md`。
- 生成或更新计划时,按 `.agents/skills/generate-plan/SKILL.md` 的步骤执行(不支持技能的工具请直接阅读该文件)。
- git commit 消息须包含任务 ID(如 `T-3 60%`、`done T-3`),可通过 `npm run plan:sync` 或 `.githooks/commit-msg` 自动同步进度到 `plan/plan.md`。
