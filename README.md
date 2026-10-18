# Melon API

用来给自家 [MelonBanG](https://github.com/shirumesu/MelonBanG) 用的后端 api  

基于 [Bangumi Api](https://bangumi.github.io/api/)，使用 Cloudflare worker + R2 存储缓存数据，总之大概是这样子  
也欢迎大家fork去部署  

---

## 职责边界

Melon API 只做两类事：

1. **所有用户共享一次计算的数据**：季度完整目录索引、bangumi-data 与 Bangumi 日历合成的播出时间表、按 subjectId 关联的地区译名。
2. **维护者统一下发的数据**：在线来源规则快照。

条目详情、章节、角色、制作人员、关联条目、搜索和社区内容由 MelonBanG 直接读取 Bangumi，本服务不做转发或聚合。

## 📡 API 接口列表

### openapi 自动文档

* **GET** `/docs`

### 健康检查

* **GET** `/health`  
  接口健康状态检查

### 在线来源规则

* **GET** `/sources/rules?engine=2`
  返回维护者管理的声明式来源规则（在线视频源与 BT RSS 索引）；支持 `If-None-Match` / `ETag`，未变化时返回 304。
  `minEngine` 超过客户端版本的规则仍返回，供客户端显示更新提示；
  带 `builtinBefore` 的规则不返回给低于该版本的客户端，因为它们已内置该来源。
  规则保存在 `src/source-rules.json`，不包含执行脚本，也不在服务端探测来源。

### 热门与新番

* **GET** `/v1/trending/current`  
  本季热门番剧（按 heat）

* **GET** `/v1/seasons/current?sort=rank`  
  本季新番列表（`heat` 或 `rank`）

服务端缓存该季度的完整目录，再按 `limit` / `offset` 切片；不接受关键词、标签或评分筛选。
目录有效期为24小时，不同分页共用同一份资料，但 ETag 包含分页身份；NSFW 范围与排序分别缓存。

### 放送时间表

* **GET** `/v1/schedule/today`  
  今日放送时间表

默认仅构建当天（`days=0`），不等待前后 7 天其他条目的资料补全。

* **GET** `/v1/schedule/latest?days=7`  
  前后各 7 天放送时间表（共 15 天）

推荐客户端使用 `GET /v1/schedule/latest?startDate=2026-10-02&dayCount=7&view=byDate`。
`startDate` 是包含在窗口内的第一天，`dayCount` 是总天数（1–63）；旧 `date/days` 半径语义保留。
`view=byDate` 或 `view=items` 只传输一种表示，默认 `both` 保留原响应。

### 地区译名

* **GET** `/v1/subjects/{id}/aliases`  
  按 Bangumi subjectId 关联 bangumi-data 的原名及地区译名（含繁体名称），用于资源搜索与弹幕匹配。
  确无匹配数据时返回空数组，不猜测译名；有效期24小时，支持 ETag。

### 数据完整性与缓存

时间表共用缓存的 bangumi-data 规则、Bangumi 日历和季度资料，仅为资料不完整的条目补取摘要。
每个摘要独立缓存；冷时间表先返回已有资料，缺图在后台补全并更新同一时间表缓存，不阻塞首屏。
时间表前台补充资料预算为15秒，后台修复预算为25秒；文字资料统一使用24小时TTL，缺图不缩短整份时间表的有效期。
季度补全读取完整目录，覆盖超过前100条的作品。没有 Bangumi 条目或上游确实没有图片时，
仍保留 `needsFallback.cover=true`，不猜测封面。

R2 命中的数据会留在最多256项、估算序列化数据24 MiB预算的实例内存中，同一键的并发读取与加载共用请求。
同一版本的 bangumi-data 只建立一次 subjectId 索引，译名与放送规则复用。
季度列表和时间表过期后，可在 24 小时内先返回带 `cache.stale=true` 的已有数据，
并通过 Worker `waitUntil` 刷新；客户端应结合 `cache.expiresAt` 判断服务端数据的新鲜度。
有请求上下文时，新数据写入实例内存后即可响应，R2 持久化在后台完成；同一缓存键的写入保持顺序，避免较慢的旧写覆盖修复结果。
管理员 `force=1` 仍等待新的上游结果。
结构化目录响应支持 `ETag` / `If-None-Match`；304保留客户端数据，并通过 `X-Cache-Expires-At`、`X-Cache-Stale` 更新新鲜度。
上游失败最多回退到过期14天内的数据；缺图时间表也可复用已保存的文字资料。
每日清理最多扫描5页、删除1000个过期对象，并保存下一轮的游标。
每次 Bangumi 上游请求及其响应正文读取最多等待 10 秒，不重试；bangumi-data 的备用来源共用10秒预算。
上游不存在返回404，限流返回429并转发Retry-After，网络失败与超时分别返回502和504。
定时刷新在上海时区每日午夜，更新当季与上一季的完整目录（安全范围的热度/排名、全范围的排名），
并复用这些资料生成今日、前后7天及明确7天时间表。其他季度按需建立目录缓存。
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
