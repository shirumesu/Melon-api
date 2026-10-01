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

### 番剧搜索

* **GET** `/v1/subjects/search?q={name}`  
  根据关键词搜索番剧

默认每页 10 条，使用 `limit` 和 `offset` 分页；最大 `limit=100`。

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
  最近 7 天放送时间表

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

### 数据完整性与缓存

时间表共用缓存的 bangumi-data 规则、Bangumi 日历和季度资料，仅为资料不完整的条目补取详情摘要。
每个摘要独立缓存；单个条目失效不会丢弃其他番剧的封面。没有 Bangumi 条目或上游确实没有图片时，
仍保留 `needsFallback.cover=true`，不猜测封面。

完整详情只读取目标番剧的放送规则，不再为了一个详情请求重新补全整张时间表。
章节列表会读取所有分页，保留超过 200 话的长篇番剧；后续分页最多四个并行请求。

R2 命中的数据会留在有容量限制的实例内存中，同一键的并发读取与加载共用请求。
搜索、结构化详情、季度列表和时间表过期后，可在 24 小时内先返回带 `cache.stale=true` 的已有数据，
并通过 Worker `waitUntil` 刷新；客户端应结合 `cache.expiresAt` 判断服务端数据的新鲜度。
有请求上下文时，新数据写入实例内存后即可响应，R2 持久化在后台完成。
管理员 `force=1` 仍等待新的上游结果；默认详情的实时评论和讨论行为不变。
每次 Bangumi 上游请求及其响应正文读取最多等待 10 秒，不重试。这是单次请求预算，
完整详情可能因章节分页等多轮请求超过 10 秒；bangumi-data 的备用来源共用 10 秒预算。
定时刷新改为上海时区每日午夜，分别预热今日与前后 7 天时间表，以及本季列表。
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

### 5.（可选）本地开发测试

```bash
pnpm dev
```
