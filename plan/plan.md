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
  - id: M4
    name: 多项目工作区、可视化规划与预警演进
    due: 2026-12-15
tasks:
  - id: T-16
    title: 编写 Antigravity 代理启动脚本并验证端口检测与启动参数
    owner: codex
    milestone: M1
    start: 2026-11-17
    end: 2026-11-17
    deps: []
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
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
    owner: codex
    milestone: M2
    start: 2026-11-21
    end: 2026-11-24
    deps: [T-5]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-9
    title: 任务交互抽屉(查看详情、直接修改状态与手工触发校验)
    owner: codex
    milestone: M2
    start: 2026-11-25
    end: 2026-11-27
    deps: [T-8]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-10
    title: 本地文件变更监听(fs.watch 实现 plan.md 秒级 SSE/热更新)
    owner: codex
    milestone: M2
    start: 2026-11-21
    end: 2026-11-24
    deps: [T-2]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-11
    title: 模拟演练推演算法(metrics.js 纯函数:模拟延期与关键路径连锁传导)
    owner: codex
    milestone: M2
    start: 2026-11-25
    end: 2026-11-27
    deps: [T-3, T-10]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-15
    title: 模拟演练界面(拖拽模拟延期并展示推演结果)
    owner: codex
    milestone: M2
    start: 2026-11-30
    end: 2026-12-03
    deps: [T-9, T-11]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-12
    title: 项目基线与历史快照对比(对比版本间排期变更与进度滑动)
    owner: codex
    milestone: M3
    start: 2026-12-05
    end: 2026-12-08
    deps: [T-15]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-13
    title: 人员负载热力图与资源冲突再平衡建议
    owner: codex
    milestone: M3
    start: 2026-12-09
    end: 2026-12-12
    deps: [T-12]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-14
    title: 进度报告与周报导出(Markdown、SVG与一键复制摘要)
    owner: codex
    milestone: M3
    start: 2026-12-15
    end: 2026-12-18
    deps: [T-13]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-17
    title: 计算燃尽图曲线与七日速率完工预测纯函数并补齐单测
    owner: codex
    milestone: M4
    start: 2026-11-23
    end: 2026-11-25
    deps: [T-3]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-18
    title: 渲染 SVG 燃尽图与速率预测卡片并支持按里程碑筛选
    owner: antigravity
    milestone: M4
    start: 2026-11-30
    end: 2026-12-02
    deps: [T-4, T-17]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-19
    title: 实现 plan.md 结构化序列化回写与规划者变更原因审计接口
    owner: codex
    milestone: M4
    start: 2026-11-26
    end: 2026-11-27
    deps: [T-1, T-2]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-20
    title: 构建可视化规划器界面支持新增拆分任务与甘特拖拽改期
    owner: antigravity
    milestone: M4
    start: 2026-12-03
    end: 2026-12-04
    deps: [T-9, T-19]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-21
    title: 实现多项目工作区注册表与多目录监听服务接口
    owner: codex
    milestone: M4
    start: 2026-11-30
    end: 2026-12-02
    deps: [T-10]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-22
    title: 新增顶栏多项目切换器与本地仓库路径注册弹窗
    owner: antigravity
    milestone: M4
    start: 2026-12-07
    end: 2026-12-09
    deps: [T-20, T-21]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-23
    title: 实现飞书钉钉企微通用 Webhook 适配器与风险指纹去重推送
    owner: codex
    milestone: M4
    start: 2026-12-03
    end: 2026-12-04
    deps: [T-3, T-21]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
  - id: T-24
    title: 新增 Webhook 渠道配置弹窗与风险周报一键推送交互
    owner: antigravity
    milestone: M4
    start: 2026-12-10
    end: 2026-12-11
    deps: [T-22, T-23]
    status: todo
    progress: 0
    actualStart: null
    actualEnd: null
---

# 计划说明

变更记录:2026-11-17 规划者新增 T-16，按用户要求交付 Windows Antigravity Clash 代理启动脚本；由 codex 当日完成，不依赖驾驶舱功能。

前端采用零依赖方案(原生 ES 模块 + SVG + Node 服务),无需 npm install。
变更记录:2026-11-17 规划者将原 T-2/T-3 拆分为 T-2/T-3/T-4。
变更记录:2026-11-17 规划者新增 T-5(界面优化),依据用户选择浅色风格并要求风险联动高亮。
变更记录:2026-11-17 规划者新增 T-6(生成计划技能),依据用户需求。
变更记录:2026-11-17 规划者新增 T-7(git commit 自动更新任务进度),依据用户需求。
变更记录:2026-11-17 规划者增量规划后续功能(M2 交互强化与自动化、M3 多维分析与报告),新增 T-8 ~ T-14。
变更记录:2026-11-17 规划者按用户确认将 M2 并行分工:T-8/T-9 归 antigravity,T-10 归 codex 并提前至 11-21 开始(仅依赖 T-2);T-11 拆为算法(codex)与新增 T-15 界面(antigravity),T-12 改依赖 T-15。

变更记录:2026-11-17 codex 修复用户移动到桌面的 T-16 启动入口，配套脚本改为同目录引用并通过检查。

变更记录:2026-11-17 codex 按用户要求将完整 T-16 启动文件及使用说明复制至桌面 start-Antigravity 文件夹，启动前检查通过。

变更记录:2026-11-17 codex 修复 T-16 将 agy-node sidecar 误判为桌面主程序的问题；同步桌面两处脚本，检查确认桌面进程为零且识别一项辅助进程，未终止后台程序。

变更记录:2026-11-17 规划者根据用户要求将未完成的 T-8、T-9、T-15、T-12、T-13、T-14 转交 codex；原计划日期和依赖保持不变。
变更记录:2026-11-17 规划者按用户确认的 M4 方案增量规划里程碑 M4 与任务 T-17 ~ T-24(燃尽图、可视化规划器、多项目工作区、多渠道 Webhook 预警),由 codex 与 antigravity 并行分工。
