---
project: 项目名称
milestones:
  - id: M1
    name: 里程碑名称
    due: 2026-12-01
tasks:
  - id: T-1
    title: 任务标题
    owner: 负责人或智能体名称
    milestone: M1
    start: 2026-11-17
    end: 2026-11-19
    deps: []            # 依赖的任务ID,如 [T-1, T-2]
    status: todo        # todo | doing | done | blocked
    progress: 0         # 0-100
    actualStart: null   # 实际开始日期,开始后填写
    actualEnd: null     # 实际完成日期,done 时必填
---

# 计划说明

(给人读的补充:范围、假设、风险。驾驶舱不会读取此部分。)
