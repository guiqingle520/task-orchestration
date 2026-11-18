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
  - id: M5
    name: 深度可视化交互、时间机器、精细核算与平台生态
    due: 2027-01-08
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
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-18
    title: 渲染 SVG 燃尽图与速率预测卡片并支持按里程碑筛选
    owner: antigravity
    milestone: M4
    start: 2026-11-30
    end: 2026-12-02
    deps: [T-4, T-17]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-19
    title: 实现 plan.md 结构化序列化回写与规划者变更原因审计接口
    owner: codex
    milestone: M4
    start: 2026-11-26
    end: 2026-11-27
    deps: [T-1, T-2]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-20
    title: 构建可视化规划器界面支持新增拆分任务与甘特拖拽改期
    owner: antigravity
    milestone: M4
    start: 2026-12-03
    end: 2026-12-04
    deps: [T-9, T-19]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-21
    title: 实现多项目工作区注册表与多目录监听服务接口
    owner: codex
    milestone: M4
    start: 2026-11-30
    end: 2026-12-02
    deps: [T-10]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-22
    title: 新增顶栏多项目切换器与本地仓库路径注册弹窗
    owner: antigravity
    milestone: M4
    start: 2026-12-07
    end: 2026-12-09
    deps: [T-20, T-21]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-23
    title: 实现飞书钉钉企微通用 Webhook 适配器与风险指纹去重推送
    owner: codex
    milestone: M4
    start: 2026-12-03
    end: 2026-12-04
    deps: [T-3, T-21]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-24
    title: 新增 Webhook 渠道配置弹窗与风险周报一键推送交互
    owner: antigravity
    milestone: M4
    start: 2026-12-10
    end: 2026-12-11
    deps: [T-22, T-23]
    status: done
    progress: 100
    actualStart: 2026-11-17
    actualEnd: 2026-11-17
  - id: T-25
    title: 修复 M4 审查问题(弹窗版本锁、项目切换隔离、Webhook项目范围、引号ID回写、默认计划容错)
    owner: codex
    milestone: M4
    start: 2026-12-14
    end: 2026-12-14
    deps: [T-24]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
  - id: T-26
    title: 实现甘特排期变更与依赖连线预检算法(环检测与下游冲突顺延试算)
    owner: codex
    milestone: M5
    start: 2026-12-15
    end: 2026-12-16
    deps: [T-11, T-19]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
  - id: T-27
    title: 构建甘特图双端拉伸改期与锚点连线建立依赖及冲突高亮交互
    owner: codex
    milestone: M5
    start: 2026-12-17
    end: 2026-12-18
    deps: [T-20, T-26]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
  - id: T-28
    title: 实现 Git 历史计划切片提取接口与时间线演进差异对比算法
    owner: codex
    milestone: M5
    start: 2026-12-17
    end: 2026-12-18
    deps: [T-7, T-12, T-21]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
  - id: T-29
    title: 新增时间机器回放控制栏与甘特图历史基线幽灵条叠加交互
    owner: antigravity
    milestone: M5
    start: 2026-12-21
    end: 2026-12-22
    deps: [T-27, T-28]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
  - id: T-30
    title: 实现单文件自包含离线 HTML 打包器与敏感字段脱敏清洗纯函数
    owner: codex
    milestone: M5
    start: 2026-12-21
    end: 2026-12-22
    deps: [T-14]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
  - id: T-31
    title: 新增离线驾驶舱导出弹窗支持脱敏选项配置与一键生成分享包
    owner: codex
    milestone: M5
    start: 2026-12-23
    end: 2026-12-24
    deps: [T-29, T-30]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
  - id: T-32
    title: 实现工作日历与工时估算侧车服务及团队预估准确率核算算法
    owner: codex
    milestone: M5
    start: 2026-12-23
    end: 2026-12-25
    deps: [T-13, T-17]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
  - id: T-33
    title: 新增工作日历与工时故事点配置面板及团队预估偏差分析视图
    owner: codex
    milestone: M5
    start: 2026-12-28
    end: 2026-12-30
    deps: [T-18, T-31, T-32]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
  - id: T-34
    title: 实现 GitHub 与 GitLab Issue 双向同步适配器与服务接口
    owner: codex
    milestone: M5
    start: 2026-12-28
    end: 2026-12-30
    deps: [T-23, T-25]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
  - id: T-35
    title: 新增代码托管平台配置弹窗与任务 Issue 双向绑定同步交互
    owner: codex
    milestone: M5
    start: 2027-01-04
    end: 2027-01-05
    deps: [T-24, T-33, T-34]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
  - id: T-36
    title: 修复旧服务导致离线网页导出失败并验证明确的重启提示
    owner: codex
    milestone: M5
    start: 2027-01-06
    end: 2027-01-06
    deps: [T-31]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
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
变更记录:2026-11-18 规划者按用户要求将 T-25 交由 codex 接手；计划日期排在 T-24 之后，因 M4 已实际交付，修复于 11-18 提前开始。
变更记录:2026-11-18 规划者按用户要求增量规划里程碑 M5 与任务 T-26 ~ T-35(甘特深度交互、时间机器历史回放、单文件离线导出、工作日历与工时预估准确率核算、GitHub/GitLab Issue 双向同步),由 codex 与 antigravity 流水线并行完成。
变更记录:2026-11-18 规划者按用户要求由 codex 先行开发 T-26/T-27；T-27 转交 codex，原计划日期和依赖不变。
变更记录:2026-11-18 antigravity 完成 T-29 时间机器回放控制栏、历史只读横幅与甘特图历史基线幽灵条叠加交互。
变更记录:2026-11-18 规划者按用户要求将 M5 剩余 T-31/T-33/T-35 转交 codex，与 T-34 一并完成；已完成的 T-29 及原计划日期、依赖不变。
变更记录:2026-11-18 规划者新增 T-36，修复 M5 更新后旧 Node 服务仍运行时的离线网页导出报错，实际当天处理。
