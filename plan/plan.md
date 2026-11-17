---
project: task-orchestration
milestones:
  - id: M1
    name: 驾驶舱 MVP
    due: 2026-11-20
  - id: M2
    name: 交互强化与自动化演进
    due: 2026-12-04
  - id: M3
    name: 多维分析与团队协作发布
    due: 2026-12-18
tasks:
  - id: T-1
    title: 定义 plan.md 规范与校验器
    owner: planner
    milestone: M1
    start: 2026-11-17
    end: 2026-11-17
    deps: []
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-2
    title: 驾驶舱服务端(读取并解析 plan.md,提供 /api/plan)
    owner: dev
    milestone: M1
    start: 2026-11-17
    end: 2026-11-18
    deps: [T-1]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-3
    title: 指标计算(偏差、关键路径、延期传导、负载)
    owner: dev
    milestone: M1
    start: 2026-11-18
    end: 2026-11-20
    deps: [T-2]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-4
    title: 前端页面(指标条、甘特图、风险面板、负载条)
    owner: dev
    milestone: M1
    start: 2026-11-19
    end: 2026-11-27
    deps: [T-3]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-5
    title: 界面优化(浅色精密风格、甘特图自适应、风险点击联动高亮)
    owner: dev
    milestone: M1
    start: 2026-11-17
    end: 2026-11-18
    deps: [T-4]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-6
    title: 「生成计划」技能(generate-plan skill)
    owner: dev
    milestone: M1
    start: 2026-11-17
    end: 2026-11-18
    deps: [T-1]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-7
    title: 解析 git commit 任务 ID 自动同步 plan.md 进度与钩子
    owner: dev
    milestone: M1
    start: 2026-11-18
    end: 2026-11-19
    deps: [T-1]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-8
    title: 甘特图缩放与视图切换(日/周/月跨度与多里程碑折叠)
    owner: antigravity
    milestone: M2
    start: 2026-11-21
    end: 2026-11-24
    deps: [T-5]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-9
    title: 任务交互抽屉(查看详情、直接修改状态与手工触发校验)
    owner: antigravity
    milestone: M2
    start: 2026-11-25
    end: 2026-11-27
    deps: [T-8]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-10
    title: 本地文件变更监听(fs.watch 实现 plan.md 秒级 SSE/热更新)
    owner: codex
    milestone: M2
    start: 2026-11-21
    end: 2026-11-24
    deps: [T-2]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-11
    title: 模拟演练推演算法(metrics.js 纯函数:模拟延期与关键路径连锁传导)
    owner: codex
    milestone: M2
    start: 2026-11-25
    end: 2026-11-27
    deps: [T-3, T-10]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-15
    title: 模拟演练界面(拖拽模拟延期并展示推演结果)
    owner: antigravity
    milestone: M2
    start: 2026-11-30
    end: 2026-12-03
    deps: [T-9, T-11]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-12
    title: 项目基线与历史快照对比(对比版本间排期变更与进度滑动)
    owner: dev
    milestone: M3
    start: 2026-12-05
    end: 2026-12-08
    deps: [T-15]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-13
    title: 人员负载热力图与资源冲突再平衡建议
    owner: dev
    milestone: M3
    start: 2026-12-09
    end: 2026-12-12
    deps: [T-12]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-14
    title: 进度报告与周报导出(Markdown、SVG与一键复制摘要)
    owner: dev
    milestone: M3
    start: 2026-12-15
    end: 2026-12-18
    deps: [T-13]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
---

# 计划说明

前端采用零依赖方案(原生 ES 模块 + SVG + Node 服务),无需 npm install。
变更记录:2026-11-17 规划者将原 T-2/T-3 拆分为 T-2/T-3/T-4。
变更记录:2026-11-17 规划者新增 T-5(界面优化),依据用户选择浅色风格并要求风险联动高亮。
变更记录:2026-11-17 规划者新增 T-6(生成计划技能),依据用户需求。
变更记录:2026-11-17 规划者新增 T-7(git commit 自动更新任务进度),依据用户需求。
变更记录:2026-11-17 规划者增量规划后续功能(M2 交互强化与自动化、M3 多维分析与报告),新增 T-8 ~ T-14。
变更记录:2026-11-17 规划者按用户确认将 M2 并行分工:T-8/T-9 归 antigravity,T-10 归 codex 并提前至 11-21 开始(仅依赖 T-2);T-11 拆为算法(codex)与新增 T-15 界面(antigravity),T-12 改依赖 T-15。
