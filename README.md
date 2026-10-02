# Melon API

用来给自家 [MelonBanG](https://github.com/shirumesu/MelonBanG) 用的后端 api  

基于 [Bangumi Api](https://bangumi.github.io/api/)，使用 Cloudflare worker + R2 存储缓存数据，总之大概是这样子  
也欢迎大家fork去部署  

---

## 📡 API 接口列表

本服务提供以下番剧相关 API：

### openapi 自动文档

* **GET** `/docs`

### 健康检查

* **GET** `/health`  
  接口健康状态检查

### 在线来源规则

* **GET** `/sources/rules?engine=1`
  返回维护者管理的声明式视频源规则；支持 `If-None-Match` / `ETag`，未变化时返回 304。
  `minEngine` 超过客户端版本的规则仍返回，供客户端显示更新提示。
  规则保存在 `src/source-rules.json`，不包含执行脚本，也不在服务端探测来源。

### 番剧搜索

* **GET** `/v1/subjects/search?q={name}`  
  根据关键词搜索番剧

默认每页 10 条，使用 `limit` 和 `offset` 分页；最大 `limit=100`、`offset=5000`。
越界或无效参数返回 400；`hasMore` 在可访问偏移上限终止。标签等数组支持重复参数、逗号分隔和 JSON 数组，顺序不同但语义相同的筛选复用缓存。

### 热门与新番

* **GET** `/v1/trending/current`  
  本季热门番剧

* **GET** `/v1/seasons/current`  
  本季新番列表

### 放送时间表

* **GET** `/v1/schedule/today`  
  今日放送时间表

默认仅构建当天（`days=0`），不等待前后 7 天其他条目的资料补全。

* **GET** `/v1/schedule/latest?days=7`  
  前后各 7 天放送时间表（共 15 天）

推荐客户端使用 `GET /v1/schedule/latest?startDate=2026-10-02&dayCount=7&view=byDate`。
`startDate` 是包含在窗口内的第一天，`dayCount` 是总天数（1–63）；旧 `date/days` 半径语义保留。
`view=byDate` 或 `view=items` 只传输一种表示，默认 `both` 保留原响应。

### 番剧详情

* **GET** `/v1/subjects/{id}`  
  获取番剧详细信息
  （包含：评论区、角色与声优、制作团队等）

示例：

```
GET /v1/subjects/531063
```

客户端只需要番剧资料时，使用 `GET /v1/subjects/531063?includeHtml=false`。
它复用完整详情缓存，保留章节、角色与声优、制作人员、简介、评分、关联条目和播出时间，
不等待评论与讨论网页抓取；`comments` 和 `topics` 返回空数组。
也可显式选择 `view=basic`（主体）、`view=playback`（主体、主线章节、别名）或 `view=full`（完整结构化详情）。
显式 `view` 默认不抓取 HTML；旧无 `view` 的默认行为保留。播放视图不会等待角色、制作人员、关联条目或放送规则。
需要评论时再请求 `/v1/subjects/{id}/comments` 或 `/v1/subjects/{id}/topics`。
完整详情的 `aliases` 返回按 Bangumi subjectId 关联的 bangumi-data 原名及地区译名（含繁体名称），
与放送规则共用上游缓存；确无匹配数据时返回空数组，不猜测译名。上游请求失败会终止详情聚合。
不传该参数的默认行为不变；`full=false` 仍返回简略条目。

同一详情接口支持 `Accept: application/x-ndjson`，建议搭配 `includeHtml=false`。
冷请求先发送 `snapshot`（完整详情形状的当前数据及 `pending` 分区名），
随后每个分区可用时发送 `patch`（`data` 只包含该分区，`pending` 随之减少），
最终发送含完整 `data` 和 `cache` 的 `complete`。缓存命中直接发送 `complete`。
`pending` 中的空数组表示仍在加载，移除后才表示已确认结果；章节可用后可先展示。
结构化分区失败会发送 `error`，不能将中间结果写入完整详情缓存；
未收到 `complete` 的连接也不能视作加载成功。JSON 客户端继续使用同一加载与缓存逻辑。

新客户端可加 `streamVersion=2`：`patch.append=["episodes"]` 表示将该分块追加到章节数组，其他字段仍替换。
`snapshot` 即使把 episodes 标为 pending，也可能包含已经加载的章节前缀。冷加载的 `complete` 仅包含 cache；
客户端应提交累计结果。缓存命中的 `complete` 仍包含完整 data。旧版本流协议保持不变。
`GET /v1/subjects/{id}/episodes?limit=200&offset=0` 可独立读取章节页（默认100、最大200）；`hasMore=true` 时使用返回的 `nextOffset` 继续读取。
偏移按上游原始行数计算，不受无效章节过滤影响；空页终止分页。无分页参数时仍返回完整章节数组。

### 数据完整性与缓存

时间表共用缓存的 bangumi-data 规则、Bangumi 日历和季度资料，仅为资料不完整的条目补取详情摘要。
每个摘要独立缓存；冷时间表先返回已有资料，缺图在后台补全并更新同一时间表缓存，不阻塞首屏。
时间表前台补充资料预算为15秒，后台修复预算为25秒；缺图快照使用5分钟TTL。没有 Bangumi 条目或上游确实没有图片时，
仍保留 `needsFallback.cover=true`，不猜测封面。

完整详情只读取目标番剧的放送规则，不再为了一个详情请求重新补全整张时间表。
章节列表会读取所有分页，保留超过 200 话的长篇番剧；后续分页最多四个并行请求。

R2 命中的数据会留在最多256项、估算序列化数据24 MiB预算的实例内存中，同一键的并发读取与加载共用请求。
同一版本的 bangumi-data 只建立一次 subjectId 索引，别名与放送规则复用。
搜索、结构化详情、季度列表和时间表过期后，可在 24 小时内先返回带 `cache.stale=true` 的已有数据，
并通过 Worker `waitUntil` 刷新；客户端应结合 `cache.expiresAt` 判断服务端数据的新鲜度。
有请求上下文时，新数据写入实例内存后即可响应，R2 持久化在后台完成；同一缓存键的写入保持顺序，避免较慢的旧写覆盖修复结果。
管理员 `force=1` 仍等待新的上游结果；默认详情的实时评论和讨论行为不变。
结构化目录响应支持 `ETag` / `If-None-Match`；304保留客户端数据，并通过 `X-Cache-Expires-At`、`X-Cache-Stale` 更新新鲜度。
新流式结果的版本位于 `complete.cache.etag`。上游失败最多回退到过期14天内的数据；缺图数据不作失败回退。
每日清理最多扫描5页、删除1000个过期对象，并保存下一轮的游标。
每次 Bangumi 上游请求及其响应正文读取最多等待 10 秒，不重试。这是单次请求预算，
结构化详情共用18秒上游预算；bangumi-data 的备用来源共用10秒预算。
上游不存在返回404，限流返回429并转发Retry-After，网络失败与超时分别返回502和504；已开始的流以error事件报告状态。
定时刷新在上海时区每日午夜，预热今日、旧前后7天及新明确7天时间表、本季列表和首页使用的8条热门结果。
Workers Logs 已启用，缓存读写失败和上游错误可在 Cloudflare Observability 中查看。

### 单集信息

* **GET** `/v1/episodes/{id}/comments`  
  获取单集评论信息

示例：

```
GET /v1/episodes/1656040/comments
```

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

### 2. 创建 R2 存储桶

```bash
wrangler r2 bucket create melon-api-cache
```

### 3. 配置环境变量（Secrets）

1. 将 *.dev.vars.example* 修改为 *.dev.vars* 并填入信息  
Access_token 在[这里](https://next.bgm.tv/demo/access-token)获取  
ADMIN_TOKEN 请随意填写任意值  

```bash
wrangler secret put BANGUMI_ACCESS_TOKEN
wrangler secret put ADMIN_TOKEN
```

2. 将 *wrangler.toml.example* 修改为 *wrangler.toml*  
一般而言不需要修改，如果你想可以改一下 `BANGUMI_USER_AGENT`、`r2_buckets.bucket_name`  
如果你有自定义域名，可以新增一块：

```text
[[routes]]
pattern = "your-weburl"
custom_domain = true
```

### 4. 部署项目

```bash
pnpm install
pnpm run deploy
```

或直接使用 wrangler：

```bash
wrangler deploy
```

### 5.（可选）本地开发

```bash
pnpm dev
```
