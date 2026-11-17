# 延期推演接口

`web/metrics.js` 导出 `simulateDelays(plan, delays)`，浏览器和 Node 均可调用。
`plan` 使用现有计划对象；`delays` 为任务 ID 到非负整数日历天数的映射，例如：

```js
const result = simulateDelays(plan, { 'T-10': 3, 'T-11': 1 });
```

返回值不改变输入计划：

- `tasks[id]`：`baselineStart`、`baselineEnd`、推演后的 `start`、`end`，相对于基线的 `delayDays`，用户输入的 `directDelayDays`，以及 `slackDays` 和 `critical`。
- `milestones`：每项包含 `id`、`baselineEnd`、`end` 和 `delayDays`；没有任务的里程碑日期为 `null`。
- `criticalTaskIds`：推演后总时差为零的任务 ID，可能存在多条并列关键路径。

日期按日历日计算，任务时长包含开始日和结束日，依赖任务完成后的次日才能开始。先依据依赖约束计算基线；原计划已有重叠时，基线可能晚于原计划日期。直接延期以该基线开始日期为起点；下游任务取自身直接延期与上游依赖要求中较晚的开始日，因此排期间隙可以吸收延期，多条依赖取最晚完成者。里程碑日期是所属任务的最晚结束日，延期量比较推演和基线，不等同于相对于交付日的逾期天数。算法仅使用计划日期和依赖，不推测实际进度或写入计划文件。

未知任务、未知依赖、循环依赖、无效日期和非非负整数延期会抛出错误。界面可重复传入新的延期映射计算不同情景，传入空映射则恢复基线。
