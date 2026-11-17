# 智能体规则

## 项目概览
- 这是一个读取 `plan/plan.md` 并展示进度、甘特图、风险和人员负载的本地驾驶舱。
- 使用 Node.js 内置模块和原生浏览器 ES 模块,当前没有第三方运行依赖,无需 `npm install`。
- `server/server.mjs` 提供静态页面、`GET /api/plan` 和 `POST /api/sync-git`。
- `web/` 包含页面、样式和前端逻辑;`web/metrics.js` 是浏览器与 Node 共用的指标计算模块。
- `scripts/validate-plan.mjs` 解析和校验计划;`scripts/sync-git-progress.mjs` 根据 Git 提交同步任务进度。
- `docs/PLAN_SPEC.md` 是计划格式与权限规范,`plan/plan.template.md` 是模板,`plan/plan.md` 是当前计划。
- `docs/M4_DESIGN.md` 是 M4 阶段(T-17 ~ T-24:燃尽图、可视化规划器、多项目工作区、Webhook 预警)的详细技术设计与前后端接口契约。

## 启动与验证
- 在项目根目录运行 `npm start`,打开 `http://localhost:5173`;可用环境变量 `PORT` 修改端口。
- 运行 `npm run plan:check` 或 `node scripts/validate-plan.mjs` 校验计划。项目目前没有配置独立的测试脚本;代码变更还应按受影响功能做针对性验证。
- `npm run plan:sync` 会扫描 Git 历史并可能修改 `plan/plan.md`;运行前先确认需要同步,随后校验计划并检查变更。
- `.githooks/` 提供提交前校验及根据提交消息同步进度的钩子;仅在 Git 配置了 `core.hooksPath=.githooks` 时自动生效。
- `CLAUDE.md` 和 `GEMINI.md` 引用本文件;更新共用项目指引时维护 `AGENTS.md`。

## 计划规则(强制)
- 任何编码任务开始前,必须先在 `plan/plan.md` 生成或更新排期,格式严格遵循 `docs/PLAN_SPEC.md` 和 `plan/plan.template.md`。未完成前不得开始写代码。
- 任务开始/完成时,必须更新对应任务的 `status`、`progress`、`actualStart`、`actualEnd`。
- 每次修改 `plan/plan.md` 后必须运行 `node scripts/validate-plan.mjs`,通过后才能结束任务。
- 只有规划者可以改任务结构、依赖和计划日期,详见 `docs/PLAN_SPEC.md`。
- 生成或更新计划时,按 `.agents/skills/generate-plan/SKILL.md` 的步骤执行(不支持技能的工具请直接阅读该文件)。
- git commit 消息须包含任务 ID(如 `T-3 60%`、`done T-3`),可通过 `npm run plan:sync` 或 `.githooks/commit-msg` 自动同步进度到 `plan/plan.md`。
