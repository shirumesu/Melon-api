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

### 热门与新番

* **GET** `/v1/trending/current` 
  本季热门番剧

* **GET** `/v1/seasons/current`  
  本季新番列表

### 放送时间表

* **GET** `/v1/schedule/today`  
  今日放送时间表

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

### 单集信息

* **GET** `/v1/episodes/{id}/comments`  
  获取单集评论信息

示例：

```
GET /v1/episodes/1656040/comments
```

## 如何部署

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

Access_token 在[这里](https://next.bgm.tv/demo/access-token)获取  

```bash
wrangler secret put BANGUMI_ACCESS_TOKEN
wrangler secret put ADMIN_TOKEN
```

### 4. 部署项目

```bash
pnpm install
pnpm deploy
```

或直接使用 wrangler：

```bash
wrangler deploy
```

### 5.（可选）本地开发测试

```bash
pnpm dev
```
