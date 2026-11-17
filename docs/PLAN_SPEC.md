# plan.md 规范(所有智能体必须遵守)

计划文件固定为 `plan/plan.md`,模板见 `plan/plan.template.md`。
驾驶舱只读取文件开头 `--- ... ---` 之间的 YAML front matter。

## 硬性规则
1. 开始任何编码前,必须先生成或更新 `plan/plan.md`,否则不得写代码。
2. 严格使用模板字段,不得增删字段名、不得改字段含义。
3. 修改后必须运行 `node scripts/validate-plan.mjs`,通过后才能结束任务或提交。
4. 只有规划者(planner)可以新增/删除任务、改 `deps` 和计划日期;其他智能体只能更新自己任务的 `status`、`progress`、`actualStart`、`actualEnd`。
5. 任务开始时:`status: doing`,填 `actualStart`。任务完成时:`status: done`、`progress: 100`、填 `actualEnd`。
6. 计划日期变动不得直接覆盖历史;在「计划说明」里追加一行变更原因。
7. git commit 消息应携带任务 ID(如 `feat(T-3): ...`),支持通过 commit 消息自动更新任务进度:
   - 仅提及 `T-3`:若为 `todo`,自动转为 `doing`、`progress: 10` 并填写 `actualStart`
   - 携带百分比 `T-3 60%`:自动设为 `doing`、`progress: 60` 并补齐 `actualStart`
   - 携带完成词 `done T-3` / `T-3 done` / `closes T-3` / `完成 T-3` / `T-3 100%`:自动设为 `done`、`progress: 100` 并填写 `actualEnd`
   - 携带阻塞词 `blocked T-3` / `T-3 阻塞`:自动设为 `blocked`

## 字段
| 字段 | 说明 |
|---|---|
| `project` | 项目名 |
| `milestones[].id/name/due` | 里程碑,id 如 `M1`,due 为 `YYYY-MM-DD` |
| `tasks[].id` | 唯一,格式 `T-数字` |
| `title` / `owner` | 标题 / 负责人 |
| `milestone` | 所属里程碑 id |
| `start` / `end` | 计划起止日期 `YYYY-MM-DD`,end ≥ start |
| `deps` | 依赖的任务 id 列表,如 `[T-1, T-2]`,无依赖写 `[]`,不得循环 |
| `status` | `todo` / `doing` / `done` / `blocked` |
| `progress` | 0–100;todo 必须为 0,done 必须为 100 |
| `actualStart` / `actualEnd` | 实际日期或 `null`;done 时 `actualEnd` 必填 |

## YAML 子集限制(校验器仅支持)
- 只支持 `key: value`、`- key: value` 列表项、`[a, b]` 行内列表、`#` 注释。
- 不支持多行字符串、嵌套对象、锚点。字符串含特殊字符时用引号。
