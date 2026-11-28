# Melon API

用来给自家 [MelonBanG](https://github.com/shirumesu/MelonBanG) 用的后端 api  

基于 [Bangumi Api](https://bangumi.github.io/api/)，使用 Cloudflare worker + R2 存储缓存数据，D1 存弹幕、设置同步和每周收藏人数，总之大概是这样子  
也欢迎大家fork去部署  

---

## 职责边界

Melon API 只做五类事：

1. **所有用户共享一次计算的数据**：季度完整目录索引、bangumi-data 与 Bangumi 资料合成的播出时间表和每周热度、按 subjectId 关联的地区译名。
2. **维护者统一下发的数据**：在线来源规则快照。
3. **不能编进客户端的应用凭据**：Bangumi OAuth 令牌交换由服务端补上应用密钥；无状态，不存储、不缓存、不记录令牌。
4. **MelonBanG 自己的社区数据**：MelonBanG 用户发送的弹幕，存于 D1，按 Bangumi 章节 ID 读取；发送需 Bangumi 登录，只保存 Bangumi 用户 ID。
5. **用户自己的设置同步**：MelonBanG 设置的一份 JSON，存于 D1，按 Bangumi 用户 ID 读写，需 Bangumi 登录；不保存令牌，客户端不上传凭据和本机路径。

条目详情、章节、角色、制作人员、关联条目、搜索和社区内容由 MelonBanG 直接读取 Bangumi，本服务不做转发或聚合。

## 📡 API 接口列表

### openapi 自动文档

* **GET** `/docs`

### 健康检查

* **GET** `/health`  
  接口健康状态检查

### 在线来源规则

* **GET** `/sources/rules?engine=3`
  返回维护者管理的声明式来源规则（在线视频源与 BT RSS 索引）；支持 `If-None-Match` / `ETag`，未变化时返回 304。
  `minEngine` 超过客户端版本的规则仍返回，供客户端显示更新提示；
  带 `builtinBefore` 的规则不返回给低于该版本的客户端，因为它们已内置该来源。
  规则保存在 `src/source-rules.json`，不包含执行脚本，也不在服务端探测来源。

### 热门与新番

* **GET** `/v1/trending/current`  
  本季热门番剧（按 heat）

* **GET** `/v1/seasons/current?sort=rank`  
  本季新番列表（`heat` 或 `rank`）

季度按开播日期划分，从上一个月 25 日起算：月底首播的新番按习惯归入下一季，例如 2023-09-29 首播的《葬送的芙莉莲》属于 2023 年 10 月季。
服务端缓存该季度的完整目录，再按 `limit` / `offset` 切片；不接受关键词、标签或评分筛选。
目录有效期为24小时，不同分页共用同一份资料，但 ETag 包含分页身份；NSFW 范围与排序分别缓存。
Bangumi 搜索每页只返回 20 条，读第一页拿到总数后，其余分页 4 个一组并行读取。
每日午夜只刷新本季的热播（heat）与目录（rank），其他季度、排序和 NSFW 范围在第一次请求时建立。

### 放送时间表

* **GET** `/v1/schedule/today`  
  今日放送时间表

默认仅构建当天（`days=0`），不等待前后 7 天其他条目的资料补全。

* **GET** `/v1/schedule/latest?days=7`  
  前后各 7 天放送时间表（共 15 天）

推荐客户端使用 `GET /v1/schedule/latest?startDate=2026-10-02&dayCount=7&view=byDate`。
`startDate` 是包含在窗口内的第一天，`dayCount` 是总天数（1–63）；旧 `date/days` 半径语义保留。
`view=byDate` 或 `view=items` 只传输一种表示，默认 `both` 保留原响应。

* **GET** `/v1/schedule/heat?week=2026-11-23`  
  一周（周一 00:00 上海时间起）每部播出番剧的热度，从高到低排列，供客户端排热度周榜。
  `week` 可以是这一周里的任意一天，默认本周；只能查前 6 周到下一周，其余返回 400。

热度 0–100，由新增收藏 35%、本集吐槽 35%、在看人数 30% 组成，每项先除以这周最高的一部再开平方，避免一部爆款把其他的压到一起；还没统计到新增收藏的番剧只按另外两项算。
`previousHeat` 是同一批番剧在前一周的热度，只给前一周也播出的。
本集吐槽按每次播出对上的那一集算（周一凌晨播出、Bangumi 记在周日的一集也算这一周）；刚播出不到两天时与上一集取较多的，本周还没播时取上一集，停播的一周为 0。
新增收藏以每周第一次拿到新鲜资料时的收藏人数为起点，记在 D1 的 `collection_snapshots`；`since` 是本周最早记下的时间。
本周的热度由定时任务每 15 分钟重算，缓存 15 分钟（还有番剧在补资料时 1 分钟），往周和下周缓存 6 小时。响应约 10 KB，客户端可按 `X-Cache-Expires-At` 到期后轮询。
时间表条目里的 `heat`、`heatComments`、`collectionGain` 等字段取自同一份结果，但跟随时间表缓存 1 小时；需要实时热度时读这个接口。

### 地区译名

* **GET** `/v1/subjects/{id}/aliases`  
  按 Bangumi subjectId 关联 bangumi-data 的原名及地区译名（含繁体名称），用于资源搜索与弹幕匹配。
  确无匹配数据时返回空数组，不猜测译名；有效期24小时，支持 ETag。

### Bangumi 登录

* **POST** `/v1/auth/bangumi/token`  
  JSON 请求体与 Bangumi 令牌接口相同（`grant_type`、`client_id` 及 `code`/`refresh_token`、`redirect_uri`、`state`），不含 `client_secret`。
  服务端补上应用密钥后转发到 `bgm.tv/oauth/access_token`，原样返回状态与结果；只接受授权码与刷新两种 grant。

### 弹幕

* **GET** `/v1/danmaku/{episodeId}`  
  按 Bangumi 章节 ID 返回 MelonBanG 用户发送的弹幕（`time` 秒、`mode` 1 滚动 / 4 底部 / 5 顶部、`color` RGB 整数、`text`），边缘缓存 30 秒。

* **POST** `/v1/danmaku/{episodeId}`  
  需要 `Authorization: Bearer <Bangumi 访问令牌>`。JSON 请求体 `time`、`text`（1–100 字）、`mode`、`color`。
  服务端向 Bangumi `/v0/me` 确认身份，只保存用户 ID，不保存令牌；每人每 3 秒一条、每天（上海时区）200 条，超出返回 429。

* **GET** `/v1/danmaku/quota`  
  需要 Bangumi 令牌，返回 `limit`、`remaining`、`waitSeconds`、`resetIn`。

### 设置同步

* **GET** `/v1/sync/settings`  
  需要 Bangumi 令牌，返回 `rev`（修订号，从未上传为 0）、`updated`、`data`（设置对象），ETag 为修订号。

* **PUT** `/v1/sync/settings`  
  需要 Bangumi 令牌和 `If-Match: "<rev>"`（这次修改基于的修订号，首次为 `"0"`），JSON 请求体 `{"data": {...}}`，最大 1 MB（用户开启时也包含订阅和每部番的记录）。
  修订号不一致返回 412，`details` 为云端当前设置；合并由客户端完成（三方合并，基准为上次同步的内容）。

* **DELETE** `/v1/sync/settings`  
  删除该用户在云端的设置。

服务端确认过的令牌只在边缘以 SHA-256 摘要记住用户 ID 10 分钟，不保存令牌本身。

表结构在 `migrations/`，新增迁移后执行 `wrangler d1 migrations apply melon-api --remote`，再推送部署。

### 数据完整性与缓存

时间表的播出规则来自 bangumi-data（6 小时更新），封面等基本资料先取 Bangumi 日历（1 小时更新）。
条目资料（评分、排名、收藏人数、简介）按首播月份成批读取：同一个月首播的有 3 部以上时，用 `/v0/subjects?year=&month=` 一次取最多 100 部，30 分钟更新；
其余条目（多为全年播出的长篇）逐个读取，2 小时更新。
正篇章节逐个读取，用来对上每次播出是第几话、是否最终话和吐槽数：今天或昨天（日本时间）播出新一集的每小时更新，三天内的每 3 小时，其余每 12 小时。
所有番剧的资料与章节存在 R2 的一个对象里，写入时比对 ETag，与其他实例同时写入时合并双方较新的部分再写；实例内存里的副本每分钟向 R2 确认一次是否变化。
补不到资料的条目不会丢，`incomplete` 给出还在补的数量，这样的时间表只缓存 1 分钟；没有 Bangumi 条目或上游确实没有图片时，
仍保留 `needsFallback.cover=true`，不猜测封面。

Workers 免费版每次调用最多 50 个外部请求：一次请求最多向 Bangumi 发 30 个，一次定时任务最多 40 个，其余留给 bangumi-data 和 Bangumi 日历；没补完的留给之后的请求和定时任务。
定时任务每 15 分钟一次：先重算本周热度，再依次更新本周、今天起 7 天、今日和下周的时间表，提前更新会在下一次运行前到期的数据；
请求只补缺失的、和过期超过一轮的数据（定时任务停了也能更新）。Bangumi 返回 429 时，这次调用不再继续请求。
每日午夜（上海时间）刷新本季的热播与目录、bangumi-data 和 Bangumi 日历，再清理过期缓存：最多扫描5页、删除1000个过期对象，并保存下一轮的游标。

R2 命中的数据会留在最多256项、24 MiB 的实例内存中，同一键的并发读取与加载共用请求。
同一版本的 bangumi-data 只建立一次 subjectId 索引，译名与放送规则复用。
时间表、今日放送、热度、季度列表和译名的新鲜响应同时缓存在边缘节点，到期前直接返回，不再读 R2、重新序列化。
季度列表和时间表过期后，可在 24 小时内（热度 1 小时内）先返回带 `cache.stale=true` 的已有数据，
并通过 Worker `waitUntil` 刷新；客户端应结合 `cache.expiresAt` 判断服务端数据的新鲜度。
有请求上下文时，新数据写入实例内存后即可响应，R2 持久化在后台完成；同一缓存键的写入保持顺序，避免较慢的旧写覆盖修复结果。
管理员 `force=1` 仍等待新的上游结果。
结构化目录响应支持 `ETag` / `If-None-Match`；304保留客户端数据，并通过 `X-Cache-Expires-At`、`X-Cache-Stale` 更新新鲜度。
上游失败最多回退到过期14天内的数据。
每次 Bangumi 上游请求及其响应正文读取最多等待 10 秒，不重试；bangumi-data 的备用来源共用10秒预算。
上游不存在返回404，限流返回429并转发Retry-After，网络失败与超时分别返回502和504。
Workers Logs 已启用，缓存读写失败和上游错误可在 Cloudflare Observability 中查看。

## 如何部署

本项目的生产 Worker 已通过 Cloudflare Workers Builds 连接 GitHub。
将提交推送到 `master` 后由 Cloudflare 自动构建并部署；在提交检查
`Workers Builds: melon-api` 中确认结果。日常发布不需要本机 Wrangler 登录。
以下手动部署步骤适用于新实例配置或明确需要的手动恢复。

本地开发使用 Node.js 22.15 或以上版本。安装依赖后运行 `pnpm typecheck` 检查 TypeScript 类型。

### 1. 安装 Wrangler 并登录

```bash
npm i -g wrangler
wrangler login
```

### 2. 创建 R2 存储桶和 D1 数据库

```bash
wrangler r2 bucket create melon-api-cache
wrangler d1 create melon-api
```

记下 `d1 create` 输出的 `database_id`，下一步填进 *wrangler.toml*。

### 3. 配置环境变量（Secrets）

1. 将 *.dev.vars.example* 修改为 *.dev.vars* 并填入信息  
Access_token 在[这里](https://next.bgm.tv/demo/access-token)获取  
ADMIN_TOKEN 请随意填写任意值  
BANGUMI_OAUTH_CLIENT_SECRET 是客户端所用 Bangumi 应用（App ID）的 App Secret；未设置时登录接口返回 503  

```bash
wrangler secret put BANGUMI_ACCESS_TOKEN
wrangler secret put ADMIN_TOKEN
wrangler secret put BANGUMI_OAUTH_CLIENT_SECRET
```

2. 将 *wrangler.toml.example* 修改为 *wrangler.toml*，把上一步的 `database_id` 填进 `[[d1_databases]]`  
其余一般不需要修改，如果你想可以改一下 `BANGUMI_USER_AGENT`、`r2_buckets.bucket_name`  
如果你有自定义域名，可以新增一块：

```text
[[routes]]
pattern = "your-weburl"
custom_domain = true
```

### 4. 部署项目

第一次部署前先建表（弹幕、设置同步和每周收藏人数都依赖这些表）：

```bash
wrangler d1 migrations apply melon-api --remote
```

```bash
pnpm install
pnpm run deploy
```

或直接使用 wrangler：

```bash
wrangler deploy
```

### 5.（可选）本地开发

本地的 R2 和 D1 是模拟的，第一次先在本地建表：

```bash
wrangler d1 migrations apply melon-api --local
pnpm dev
```

用 `pnpm dev --test-scheduled` 启动时，可以访问 `/__scheduled?cron=*/15+*+*+*+*` 手动触发定时任务。
