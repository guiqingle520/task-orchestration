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
  - id: M6
    name: 任务查找与日常跟进
    due: 2026-12-09
  - id: M7
    name: 跨项目总览与汇报
    due: 2026-12-18
  - id: M8
    name: 今日行动工作台、新项目接入向导与 MCP 插件
    due: 2026-12-25
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
  - id: T-37
    title: 修复甘特图里程碑图例悬停消失并验证里程碑卡片正常
    owner: codex
    milestone: M5
    start: 2027-01-07
    end: 2027-01-07
    deps: [T-27]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
  - id: T-38
    title: 实现白底状态色驾驶舱首版并验证甘特交互与窄屏布局
    owner: codex
    milestone: M5
    start: 2027-01-08
    end: 2027-01-08
    deps: [T-37]
    status: done
    progress: 100
    actualStart: 2026-11-18
    actualEnd: 2026-11-18
  - id: T-39
    title: 统一任务查询规则并验证关键词与组合筛选
    owner: codex
    milestone: M6
    start: 2026-11-23
    end: 2026-11-24
    deps: []
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-40
    title: 接入甘特图筛选并处理空结果、依赖线和窄屏键盘操作
    owner: codex
    milestone: M6
    start: 2026-11-25
    end: 2026-11-26
    deps: [T-39]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-41
    title: 新增日常跟进列表并支持按负责人查看及定位任务
    owner: codex
    milestone: M6
    start: 2026-11-27
    end: 2026-11-30
    deps: [T-40]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-42
    title: 支持复制和打开任务链接并验证切换项目及失效定位
    owner: codex
    milestone: M6
    start: 2026-12-01
    end: 2026-12-02
    deps: [T-41]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-43
    title: 提供跨项目只读统计并处理单项目不可用
    owner: codex
    milestone: M7
    start: 2026-12-10
    end: 2026-12-11
    deps: []
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-44
    title: 新增跨项目总览并支持按风险排序和进入项目
    owner: codex
    milestone: M7
    start: 2026-12-14
    end: 2026-12-15
    deps: [T-43, T-47]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-45
    title: 从跨项目总览复制 Markdown 摘要并核对统计一致性
    owner: codex
    milestone: M7
    start: 2026-12-16
    end: 2026-12-16
    deps: [T-44]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-46
    title: 为动态下拉框添加模糊搜索并验证键盘与多选操作
    owner: codex
    milestone: M6
    start: 2026-12-03
    end: 2026-12-04
    deps: [T-41]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-47
    title: 展示各里程碑阶段的进度与任务数并支持查看对应任务
    owner: codex
    milestone: M6
    start: 2026-11-20
    end: 2026-11-20
    deps: []
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-48
    title: 区分七个驾驶舱导航图标的颜色并保留黑白界面
    owner: codex
    milestone: M6
    start: 2026-11-19
    end: 2026-11-19
    deps: []
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-49
    title: 为计划时间线增加专注模式和浏览器全屏并恢复查看位置
    owner: codex
    milestone: M6
    start: 2026-11-19
    end: 2026-11-19
    deps: []
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-50
    title: 加固服务端静态文件边界校验、统一 JSON 请求体解析与计划原子写入
    owner: antigravity
    milestone: M7
    start: 2026-11-19
    end: 2026-11-19
    deps: []
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-51
    title: 优化窄屏甘特图日期刻度自适应步长与里程碑竖线标签防重叠
    owner: antigravity
    milestone: M7
    start: 2026-11-19
    end: 2026-11-19
    deps: [T-50]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-52
    title: 统一驾驶舱全局按钮、下拉触发器与分段控件视觉样式
    owner: antigravity
    milestone: M7
    start: 2026-11-19
    end: 2026-11-19
    deps: [T-51]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-53
    title: 修复添加项目等弹窗表单的标签对齐与输入框满宽布局
    owner: antigravity
    milestone: M7
    start: 2026-11-19
    end: 2026-11-19
    deps: [T-52]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-54
    title: 支持注册项目时调用系统原生目录选择器选择本地仓库文件夹
    owner: antigravity
    milestone: M7
    start: 2026-11-19
    end: 2026-11-19
    deps: [T-53]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-55
    title: 优化 Windows 文件夹选择器启动延迟（弹窗打开时预热与常驻复用）
    owner: antigravity
    milestone: M7
    start: 2026-11-19
    end: 2026-11-19
    deps: [T-54]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-56
    title: 重构驾驶舱为侧栏真分页多视图架构与通栏全宽计划时间线
    owner: antigravity
    milestone: M7
    start: 2026-11-19
    end: 2026-11-19
    deps: [T-55]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-57
    title: 实现可开工任务判定（区分现在可开工与可提前开始）、验收要求精确提取与智能体交接说明生成
    owner: codex
    milestone: M8
    start: 2026-12-21
    end: 2026-12-22
    deps: [T-56]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-58
    title: 在项目总览实现今日行动（需跟进与可开工）负责人筛选、进度更新与交接说明预览复制
    owner: antigravity
    milestone: M8
    start: 2026-12-22
    end: 2026-12-23
    deps: [T-57]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-59
    title: 实现新项目接入向导支持目录计划预检、缺失计划模板预览创建与格式错误原文件保护
    owner: codex
    milestone: M8
    start: 2026-12-23
    end: 2026-12-24
    deps: [T-54, T-57]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-19
  - id: T-60
    title: 实现零依赖 stdio MCP 服务（查询、校验与带并发冲突检查的进度写回）及双端智能体插件封装
    owner: antigravity
    milestone: M8
    start: 2026-12-24
    end: 2026-12-25
    deps: [T-58, T-59]
    status: done
    progress: 100
    actualStart: 2026-11-19
    actualEnd: 2026-11-20
  - id: T-61
    title: 固定时间线任务与日期表头并保持横向刻度对齐
    owner: codex
    milestone: M8
    start: 2026-11-20
    end: 2026-11-20
    deps: []
    status: done
    progress: 100
    actualStart: 2026-11-20
    actualEnd: 2026-11-20
  - id: T-62
    title: 展开时间线筛选与工具时定位到工具栏
    owner: codex
    milestone: M8
    start: 2026-11-20
    end: 2026-11-20
    deps: []
    status: done
    progress: 100
    actualStart: 2026-11-20
    actualEnd: 2026-11-20
  - id: T-63
    title: 优化时间机器的历史加载与滑块切换响应
    owner: codex
    milestone: M8
    start: 2026-11-20
    end: 2026-11-20
    deps: []
    status: done
    progress: 100
    actualStart: 2026-11-20
    actualEnd: 2026-11-20
  - id: T-64
    title: 收起筛选与工具后让专注时间线填满剩余高度
    owner: codex
    milestone: M8
    start: 2026-11-20
    end: 2026-11-20
    deps: []
    status: done
    progress: 100
    actualStart: 2026-11-20
    actualEnd: 2026-11-20
  - id: T-65
    title: 移除侧栏本地工作区标签并保留连接状态
    owner: codex
    milestone: M8
    start: 2026-11-20
    end: 2026-11-20
    deps: []
    status: done
    progress: 100
    actualStart: 2026-11-20
    actualEnd: 2026-11-20
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
变更记录:2026-11-18 规划者新增 T-37，修复里程碑图例与卡片共用样式导致悬停消失的问题，实际当天处理。
变更记录:2026-11-18 规划者新增 T-38，按确认的 Figma 白底状态色方案实现驾驶舱首版；计划接续 T-37，按用户要求当天提前开始。

## 下一阶段路线与验收

截至 2026-11-19，M1–M5 的 38 项任务均已完成。以下为拟定排期；按用户此前安排，由 codex 承担开发，按工作日串行推进。M6 在 12 月 7–9 日预留 3 个工作日，M7 在 12 月 17–18 日预留 2 个工作日，用于联动回归、手册更新和修整。旧计划日期作为基线保留；新任务以已实际完成的功能为起点，依赖只记录本轮尚未完成的前置。

### M6 · 任务查找与日常跟进（优先交付）

| 任务 | 验收标准 |
|---|---|
| T-39 | 关键词可按任务编号和标题查找，英文不区分大小写；状态、负责人、里程碑可与关键词同时使用。清空条件后恢复全部任务。 |
| T-40 | 甘特图只显示命中的任务；依赖线仅在两端均可见时绘制。无结果可一键清空条件，窄屏可用键盘操作。筛选只影响甘特图和跟进列表，项目整体指标、燃尽图和导出仍按完整计划统计；时间机器按回放切片筛选，继续只读。 |
| T-41 | 跟进列表按阻塞、逾期、未来 7 天到期排序，重复命中仅出现一次，已完成任务不进入列表。可按手动选择的负责人聚焦，不引入登录；点击可展开对应里程碑并定位甘特图任务。 |
| T-42 | 复制的链接只包含项目 ID 和任务 ID；在同一个本地驾驶舱打开时，直接加载当前计划并定位任务。切换项目不带入上一项目的筛选；项目或任务不存在时明确提示，不定位到其他同编号任务。 |
| T-46 | 项目、任务、负责人、里程碑、历史快照等随数据增长的选择框可在展开后输入搜索，覆盖现有模拟演练、Issue 同步任务范围和 M6 新筛选。按名称、标题或可见编号匹配，中文支持片段，英文忽略大小写，忽略首尾空格；例如输入“离线”可找到带该词的任务，输入“t-3”优先显示完整编号 T-3。无结果时显示提示，清空输入恢复全部候选。支持方向键、回车和 Esc；中文输入法选字时不提前选中。输入、取消和清空搜索文字都不改变已选值，多选任务在搜索后保留此前的勾选。播放倍速、状态、平台等固定短列表保留原控件。 |
| T-47 | 从侧栏「里程碑」进入阶段进度，默认列出当前项目的全部阶段，包括已完成和已过期的阶段。每行显示进度条、百分比、已完成/总任务数、计划交付日；有延期风险时补充预计交付日。点击阶段可在甘特图展开其任务。 |
| T-48 | 驾驶舱七个导航图标分别使用蓝、青、紫、灰蓝、玫红、砖红、绿；导航文字、白底和选中背景保留原样。桌面侧栏和紧凑导航的默认、悬停、选中状态都可辨认，链接及键盘焦点不变。 |
| T-49 | 时间线主按钮展开至整个浏览器内容区，保留筛选、缩放、时间机器和任务操作；更多显示选项提供浏览器全屏。不支持或拒绝全屏时继续使用展开视图并提示。退出或按 Esc 恢复原布局及页面和甘特图滚动位置；窄屏默认收起筛选与工具，仍可手动展开。 |

里程碑进度口径（T-47）：沿用现有按计划工期加权的进度算法，与甘特图阶段进度一致；已完成任务数按任务状态统计。没有任务的阶段显示「暂无任务」和 0/0，不判为已完成；甘特图筛选不改变阶段统计，时间机器查看回放版本时使用同一版本的数据。

里程碑延期标记（T-47）：阶段进度列表和甘特图里程碑行统一用红色标签并显示文字。超过计划交付日且仍有未完成任务时标为「已延期 N 天」，按当前统计日计算；未到期但预计晚于计划交付日时标为「预计延期 N 天」，同时显示预计交付日；全部任务完成但实际交付日超过计划时标为「延期完成 N 天」，以最后一项任务的实际完成日计算。计划交付日当天不算已延期，空阶段不标延期。

项目状态标记（T-46）：项目下拉框收起时显示当前项目的状态，展开或搜索时每个项目选项都显示对应标记。统一使用色点加状态文字：绿色「正常」、琥珀色「有风险」、红色「告急」、灰色「不可用」。复用现有项目健康度，计划缺失或无效时显示「不可用」，并验证四种标记在白底、键盘高亮和窄屏下都可辨认。

### M7 · 跨项目总览与汇报

| 任务 | 验收标准 |
|---|---|
| T-43 | 基于已注册项目和同一统计日返回健康度、总体进度、逾期数、阻塞数与下一个尚未完成的里程碑；全部完成时显示无待交付里程碑。单个计划丢失或无效时标记不可用，其他项目仍可查看。总览数据不包含本地路径或渠道配置。 |
| T-44 | 提供全项目总览入口，默认优先显示存在阻塞或逾期的项目，任一可用项目都可进入原驾驶舱，并可从总览的「查看里程碑」直接打开该项目的阶段进度。每个项目使用与下拉框一致的状态色和文字。不可用项目单独标记，不按零风险展示或计入有效项目合计。 |
| T-45 | 从当前总览快照复制 Markdown，统计日、项目数和风险计数与页面一致，显式列出不可用项目。摘要只包含项目名、汇总指标和里程碑信息，不包含任务明细、负责人、Git 记录或本地路径。 |

本轮沿用现有计划字段和零第三方运行依赖。跨项目只查看和复制总结；跨项目依赖编辑、跨项目离线网页和自动推送留待有明确需求时再排。

变更记录:2026-11-19 规划者增量新增 M6–M7 与 T-39–T-45，优先缩短单项目查找与跟进路径，再复用现有统计口径提供跨项目总览和汇报。
变更记录:2026-11-19 规划者按用户要求新增 M6 的 T-46，下拉框模糊搜索安排在 12 月 3–4 日。为确保单人串行且保留回归缓冲，M6 由 12 月 4 日调整至 12 月 9 日，M7 由 12 月 15 日调整至 12 月 18 日；T-43 至 T-45 随之顺延。
变更记录:2026-11-19 规划者按用户要求在 T-46 与 T-44 补充统一的项目状态色验收，分别覆盖项目下拉框和跨项目总览。
变更记录:2026-11-19 规划者按用户要求新增 M6 的 T-47，复用现有进度计算完善各里程碑阶段查看，安排在 11 月 20 日；M7 的 T-44 补充直达入口并依赖 T-47，里程碑交付日不变。
变更记录:2026-11-19 规划者按用户要求在 T-47 中补充里程碑延期红色标签及实际和预计延期的验收规则。
变更记录:2026-11-19 规划者新增 M6 的 T-48，当日按截图为七个导航入口区分图标颜色，其他任务排期不变。
变更记录:2026-11-19 按用户要求将 T-48 的里程碑导航图标改为红色，并用偏玫红的深红与风险图标的砖红区分。
变更记录:2026-11-19 按用户要求优先交付 M6，T-39 至 T-42、T-46 和 T-47 提前开工；保留原计划日期和 M7 排期。
变更记录:2026-11-19 M6 的七项任务全部完成。任务筛选、跟进、链接、可搜索下拉框和里程碑进度已通过 42 项回归测试与桌面及窄屏浏览器验证。
变更记录:2026-11-19 按用户要求启动 M7 的 T-43 至 T-45，复用现有工作区和 M6 的状态标签，原计划日期保留。
变更记录:2026-11-19 M7 三项任务全部完成；跨项目总览、状态色、项目及里程碑跳转和同口径 Markdown 摘要通过 45 项测试与桌面、窄屏浏览器验收。
变更记录:2026-11-19 规划者按用户确认新增 M6 体验改进 T-49，增加时间线专注模式和可选浏览器全屏，沿用原交付日。
变更记录:2026-11-19 完成 T-49；在 Chromium 验证 1440px 和 390px 布局、原生全屏及回退、滚动恢复、规划编辑与历史只读，47 项测试通过。
变更记录:2026-11-19 规划者按代码评审结论新增 M7 的 T-50，加固服务端静态文件边界校验、统一 POST JSON 解析并统一 plan.md 原子写入。
变更记录:2026-11-19 antigravity 完成 T-50；服务端目录读取保护、同前缀路径逃逸拦截、统一 withJsonBody 限流与 plan.md 原子写入均已通过 48 项测试。
变更记录:2026-11-19 规划者按代码评审 P2 结论新增 M7 的 T-51，按可用宽度自适应稀疏化甘特日期刻度并防止里程碑竖线标签重叠。
变更记录:2026-11-19 antigravity 完成 T-51；抽取甘特布局纯函数实现窄屏刻度自适应、里程碑标签两层错排/边界翻转与 resize 重绘，全量 50 项测试通过。
变更记录:2026-11-19 规划者按用户反馈新增 M7 的 T-52，统一驾驶舱所有按钮、下拉触发器、分段控件与组合按钮的现代白底风格。
变更记录:2026-11-19 antigravity 完成 T-52；消除原生灰底硬框按钮，统一主/次/轻按钮、浅灰胶囊分段器、组合下拉与 hover/active/disabled 状态，全量 50 项测试通过。
变更记录:2026-11-19 规划者按用户反馈新增 M7 的 T-53，统一修复添加项目及其他弹窗的表单字段对齐与输入框宽度布局。
变更记录:2026-11-19 antigravity 完成 T-53；统一所有弹窗表单为标签在上、满宽输入框在下，修正复选框对齐、聚焦高亮与底部分隔操作栏。
变更记录:2026-11-19 规划者按用户要求新增 M7 的 T-54，新增本机目录选择接口并在添加项目弹窗提供「选择文件夹」按钮及名称自动预填。
变更记录:2026-11-19 antigravity 完成 T-54；新增 server/folder-picker.mjs 与 POST /api/projects/pick-directory 接口，支持原生文件夹选择与项目名/代号自动预填，全量 53 项测试通过。
变更记录:2026-11-19 规划者按用户反馈新增 M7 的 T-55，通过弹窗打开时预热与短时常驻 PowerShell STA 进程消除文件夹选择器冷启动卡顿。
变更记录:2026-11-19 antigravity 完成 T-55；实现 Windows 常驻 STA 进程复用（3 分钟空闲自动回收、Base64 安全传输与打开弹窗后台预热），点击选择文件夹即时弹出。
变更记录:2026-11-19 规划者按用户确认的布局方案新增 M7 的 T-56，重构驾驶舱为侧栏真分页多视图（跨项目总览/项目总览/计划时间线/里程碑与风险/负载与工时/报告与集成），并将计划时间线改为通栏全宽展示。
变更记录:2026-11-19 antigravity 完成 T-56；重构为 6 视图真分页架构、2 列等宽平衡网格与通栏全宽时间线，兼容所有历史锚点与跨视图联动跳转，全量 53 项测试通过。

### M8 · 今日行动工作台、新项目接入向导与 MCP 插件

| 任务 | 验收标准 |
|---|---|
| T-57 | 只有 `todo` 且全部前置已 `done` 的任务才进入候选，无依赖也算就绪。按当前统计日区分「现在可开工」（`start <= today`）和「可提前开始」（`start > today`），并给出入选原因（如「无前置依赖」「前置 T-26、T-27 均已完成」）。提取验收要求时精确匹配任务 ID（`T-5` 不得误配 `T-50`）；计划正文无对应验收条目时明确显示「未填写」。 |
| T-58 | 将项目总览右下卡片由「人员负载」替换为「今日行动」（「人员负载」保留在「负载与工时」页）。「需跟进」和「可开工」共用负责人筛选，保留各自入选原因。每行优先露出「更新进度」和「复制开工说明」，点击任务标题跳到计划时间线定位；不设 `+25%` 按钮。更新进度复用现有弹窗与 `expected` 冲突检查；复制开工说明支持预览并保持任务原状态不变；时间机器历史回放模式保持只读。端到端验收：在总览完成前置任务 → 下游任务立即出现在可开工列表 → 预览并复制开工说明 → 刷新后确认下游任务仍为 `todo`。 |
| T-59 | 选定目录后明确区分三种结果：1) 计划存在且有效则直接注册；2) 缺少 `plan/plan.md` 则提供默认模板预览并经用户确认后创建注册；3) 已有 `plan/plan.md` 但格式或校验错误则明确显示错误并保留原文件，绝不覆盖用户已有的计划文件。 |
| T-60 | 先交付查询与校验工具，再开放进度写回。严格遵守 `docs/PLAN_SPEC.md` 角色权限：普通执行工具仅允许更新任务执行字段（`status` / `progress` / `actualStart` / `actualEnd`）。写入须覆盖并发冲突检查：两个 Agent 同时读到旧进度并先后提交时，后提交者收到 `409`/冲突提示而不覆盖前次结果。插件封装分别以 Codex 和 Antigravity 实际加载并调用成功为准。 |

变更记录:2026-11-19 规划者汇总用户、Codex 与 Antigravity 共识，新增里程碑 M8 与任务 T-57 ~ T-60（共 4 项任务：T-57/T-59 由 codex 负责，T-58/T-60 由 antigravity 负责），并将四条验收细则写入计划说明。
变更记录:2026-11-19 antigravity 接手并完成 T-58；在项目总览实现「今日行动（需跟进 + 可开工）」、共用负责人筛选、复用弹窗更新进度及开工说明预览复制（时间机器保持只读），全量 57 项测试通过。
变更记录:2026-11-20 antigravity 完成 T-60；实现零依赖 stdio MCP 服务（server/mcp.mjs，覆盖查询、校验、角色权限拦截与双 Agent 409 并发冲突检查）及 Antigravity/Codex 双端插件封装与本机注册。
变更记录:2026-11-19 codex 开始 T-57，按既定验收标准提前开发，保留原计划日期。
变更记录:2026-11-19 codex 完成 T-57。T-58 可从 web/task-handoff.js 引入 readyTasks(last.data.tasks, last.m.today)，先用完整任务列表判定，再按负责人筛选，availability 为 now 或 early，reason 为入选原因。总览与任务详情共用 buildTaskHandoff(last.data, taskId, last.acceptanceByTask) 生成纯文本预览及复制内容。实时与历史快照分别提供本版本的验收标准。
变更记录:2026-11-19 codex 提前开始 T-59，保留原排期。
变更记录:2026-11-19 codex 完成 T-59，已验证有效计划直接注册、缺失计划预览确认创建和错误计划原文件保护。浏览器验证覆盖取消预览及预览后其他进程创建计划的情况。
变更记录:2026-11-20 按用户要求新增 T-61，固定计划时间线表头，覆盖普通、专注与全屏视图。
变更记录:2026-11-20 codex 完成 T-61，已在桌面普通、专注、浏览器全屏和窄屏视图验证纵向表头固定、横向任务列固定以及日期与网格对齐。
变更记录:2026-11-20 按用户反馈新增 T-62，修复紧凑专注视图展开工具后工具栏仍在视口外的问题。
变更记录:2026-11-20 codex 完成 T-62，展开时将工具栏滚动到可见位置并显示对应的展开或收起操作，已用窄屏浏览器复测。
变更记录:2026-11-20 按用户反馈新增 T-63，优化历史快照加载、滑块拖动和连续回放。
变更记录:2026-11-20 codex 完成 T-63，批量读取 Git 快照并在容量上限内预加载，滑块合并连续输入。浏览器验证打开回放、快速切帧、2 倍速播放和退出恢复，63 项测试通过。
变更记录:2026-11-20 按用户反馈补充 T-62 响应验证，展开时仅滚动时间线容器，避免后台刷新重复替换未变化的甘特图。
变更记录:2026-11-20 codex 完成 T-62 响应修复，窄屏浏览器验证展开后直接定位，以及后台刷新时复用内容相同的甘特图。63 项测试通过。
变更记录:2026-11-20 按用户当前浏览器反馈补充 T-62，统一各视图的工具栏显隐状态与按钮文字。
变更记录:2026-11-20 codex 完成 T-62 修正，普通和专注视图均已在用户当前浏览器实际验证展开、收起和任务筛选。
变更记录:2026-11-20 按用户要求新增 T-64，收起工具栏后让专注与全屏时间线利用剩余高度。
变更记录:2026-11-20 codex 完成 T-64，已在 1920×911 桌面、窄屏和浏览器全屏验证收起后甘特图填满可用高度，任务详情仍可滚动访问。
变更记录:2026-11-20 按用户要求新增 T-65，精简侧栏底部的状态显示。
变更记录:2026-11-20 codex 完成 T-65，已确认本地页面移除固定标签和黑点，保留更新时间与连接状态。
