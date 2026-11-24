# 自我唤醒（wake）

到点自己开一轮：按配置里的一条内容投递，跑完回来接着做事。给 WhaleLife 用。

从思维空间的子插件拆出来单独装，因为间隔和内容都是"我自己"的事，跟思维画布没关系。

## 装

```
plugins/wake/
  plugin.yaml
  index.ts
  data/config.json     运行时才有
```

放进宿主 `plugins/` 下，重启一次（新目录不会热扫）。之后在控制台「设置 → 自我唤醒」里改。

`depends: [web, sessions, tools]` —— 少了任何一个，`ctx.sessions.enqueue` 或页面都起不来。

## 四条设计取舍

**1. 不碰主会话。**
默认自己建一条「自我唤醒」会话，唤醒的输入输出都落在那里，主会话不受影响。

> 早期版本以为「不带 sessionId 就是插件的专用通道」，其实宿主会回落到**当前选中的会话**
> （`core/plugin-services.ts`：`input.sessionId ?? await sessions.current()`），
> 于是每唤一次就往主会话里塞一轮，下次再唤又驮着那一段。0.2.0 起由 `session_id` 显式指定。

**2. 用 enqueue 不用 run。**
主会话正在跑的时候排队等，不打断用户的话。

**3. 优先级给负的（-50）。**
用户的话永远排在自我唤醒前面。

**4. 唤醒内容可以写多条，每次随机抽一条。**
同一句话反复说会僵，也会把"这次要干点什么"变成一件机械的事。

## 配置

```json
{
  "enabled": false,
  "interval_minutes": 5,
  "max_per_hour": 6,
  "model": "",
  "permission": "full",
  "session_mode": "own",
  "session_id": "",
  "prompts": ["醒醒。去看一眼……", "另一条……"]
}
```

| 键 | 说明 |
|---|---|
| `enabled` | 关着就真不唤 |
| `interval_minutes` | 多少分钟一次 |
| `max_per_hour` | 一小时上限，防止配错烧额度 |
| `model` | 留空用宿主默认模型 |
| `permission` | `off` / `ask` / `full`。要写文件必须是 `full` |
| `session_mode` | `own` 自己那条（默认）／`current` 宿主当前选中的那条 |
| `session_id` | 专用会话 id。留空则第一次唤醒时自动建一条，之后复用 |
| `prompts` | 唤醒内容，每次随机抽一条；老写法 `prompt` 单条也认 |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/plugins/wake/fire` | 立刻投一轮。body 或查询串可带 `source` / `id` / `force` |
| POST | `/plugins/wake/save` | 保存配置，合并式：只传要改的键 |
| GET | `/plugins/wake/` | 设置页 |

`fire` **立刻回 202**，在后台投递。因为 `enqueue` 会等到整轮跑完（含模型调用）才返回，
几十秒到几分钟；早先版本在这里 await，调用方 10 秒就超时，于是"没投出去"和
"投出去了还在跑"长得一模一样。

`force=1` 越过开关和限流，只给用户点名的场景用（页面按钮、`self_wake_now`）。
定时和外部通知触发的请求都要受限流管，否则配错一次就是一小时九次。

## 两个工具

- `self_wake_status`（safe）：开没开、多久一次、这一小时几次、上次什么时候、上次用的哪条内容、落在哪条会话
- `self_wake_now`（ask）：立刻唤一轮，用来试效果

## 踩过的三个坑

**一、`enqueue` 不带 sessionId = 落进"当前选中的会话"。**
不是插件专用通道。所以唤醒的上下文和主会话一样大，一次唤醒十几万 token。
见上面第 1 条。

**二、先占额度再投递。**
投递要跑几十秒，两次并发请求如果都在"已投递"之前看不到对方，就都能挤过上限。
顺序反了就是一小时九次、上限写的是六。

**三、`fire` 不能同步等。**
见上。

## 状态

0.2.0。单机在用，没有为了通用做抽象。
