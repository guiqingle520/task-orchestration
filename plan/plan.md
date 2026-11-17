---
project: task-orchestration
milestones:
  - id: M1
    name: 驾驶舱 MVP
    due: 2026-12-01
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
---

# 计划说明

前端采用零依赖方案(原生 ES 模块 + SVG + Node 服务),无需 npm install。
变更记录:2026-11-17 规划者将原 T-2/T-3 拆分为 T-2/T-3/T-4。
变更记录:2026-11-17 规划者新增 T-5(界面优化),依据用户选择浅色风格并要求风险联动高亮。
变更记录:2026-11-17 规划者新增 T-6(生成计划技能),依据用户需求。
变更记录:2026-11-17 规划者新增 T-7(git commit 自动更新任务进度),依据用户需求。
