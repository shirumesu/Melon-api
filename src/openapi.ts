export function openApiSpec(publicBaseUrl: string): unknown {
  const cacheSchema = schemaRef("CacheMeta");
  const errorResponse = response("错误响应", schemaRef("ApiError"));

  return {
    openapi: "3.1.0",
    info: {
      title: "Melon API",
      version: "0.1.2",
      description: [
        "Melon API 是给 melonbang 追番客户端使用的 Bangumi-first 动画信息聚合 API。",
        "优先使用 Bangumi v0 API 获取 subject、章节、角色、制作人员等结构化数据；Bangumi 官方 API 暂未覆盖的吐槽箱、讨论版、单集评论会从公开网页 HTML 做 best-effort 解析。",
        "Worker 会把聚合结果缓存在 R2，客户端请求一般读取缓存，避免一次请求立刻 fan out 到多个外部来源。",
        "所有番剧条目都尽量保留 subjectId；章节相关接口保留 episodeId，方便客户端跳转到 Bangumi 对应页面。",
      ].join("\n\n"),
    },
    servers: [{ url: publicBaseUrl, description: "正式 API 域名" }],
    tags: [
      { name: "基础", description: "服务状态、OpenAPI 文档。" },
      {
        name: "搜索",
        description: "按名称、标签、日期、评分、排名搜索 Bangumi 动画条目。",
      },
      {
        name: "番剧",
        description: "番剧详情、章节、角色、制作人员、吐槽箱、讨论版。",
      },
      { name: "章节", description: "单集详情和单集评论。" },
      { name: "时间表", description: "从 bangumi-data 聚合的播出时间表。" },
      { name: "季度", description: "当前季度列表和热播列表。" },
      { name: "内部", description: "缓存刷新等运维接口。" },
    ],
    paths: {
      "/health": {
        get: {
          tags: ["基础"],
          summary: "健康检查",
          description:
            "用于确认 Worker 是否正常响应。不访问 Bangumi，也不读写 R2。",
          responses: {
            "200": response(
              "服务正常",
              objectSchema(
                {
                  ok: { type: "boolean" },
                  now: { type: "string", format: "date-time" },
                },
                ["ok", "now"],
              ),
            ),
          },
        },
      },
      "/openapi.json": {
        get: {
          tags: ["基础"],
          summary: "OpenAPI 规格",
          description:
            "返回当前服务的 OpenAPI 3.1 JSON。Swagger UI 的 /docs 也是读取这个文件。",
          responses: { "200": { description: "OpenAPI JSON" } },
        },
      },
      "/docs": {
        get: {
          tags: ["基础"],
          summary: "Swagger UI 文档页",
          description: "浏览器打开后可以查看中文接口说明，并直接试请求。",
          responses: { "200": { description: "HTML 文档页" } },
        },
      },
      "/v1/subjects/search": {
        get: {
          tags: ["搜索"],
          summary: "搜索番剧 subject",
          description: [
            "基于 Bangumi /v0/search/subjects 搜索动画条目，固定筛选 type=2，因此只返回动画类 subject。",
            "适合搜索页、输入框联想、按标签找番。返回的是简略列表，每个结果都包含 subjectId。",
            '数组参数支持重复 query 写法，例如 ?tag=TV&tag=校园；也支持 JSON 数组字符串，例如 ?tag=["TV","校园"]。',
          ].join("\n\n"),
          parameters: [
            queryParam(
              "q",
              "string",
              "搜索关键词。可传中文名、日文名、英文名或为空。",
              { example: "黑猫" },
            ),
            arrayQueryParam(
              "tag",
              "普通标签筛选，例如 TV、漫画改、原创。Bangumi 会按标签过滤。",
              ["TV", "漫画改"],
            ),
            arrayQueryParam(
              "metaTag",
              "Bangumi meta_tags 筛选，适合平台/地区/类型一类标签。",
              ["日本", "校园"],
            ),
            arrayQueryParam(
              "airDate",
              "开播日期筛选，传给 Bangumi filter.air_date。支持 Bangumi API 的比较写法。",
              [">=2026-04-01", "<=2026-06-30"],
            ),
            arrayQueryParam(
              "rating",
              "评分筛选，传给 Bangumi filter.rating。",
              [">=6"],
            ),
            arrayQueryParam("rank", "排名筛选，传给 Bangumi filter.rank。", [
              "<=5000",
            ]),
            queryParam(
              "sort",
              "string",
              "排序方式：match 匹配度，heat 热度，rank 排名，score 评分。",
              { enum: ["match", "heat", "rank", "score"], default: "match" },
            ),
            queryParam("limit", "integer", "每页数量，最大 100。", {
              default: 20,
              maximum: 100,
              minimum: 1,
            }),
            queryParam("offset", "integer", "分页偏移。", {
              default: 0,
              minimum: 0,
            }),
            queryParam(
              "includeNsfw",
              "boolean",
              "是否允许 NSFW 结果。默认 false。",
              { default: false },
            ),
            forceQueryParam(
              "是否绕过 R2 缓存重新请求 Bangumi。调试时使用，客户端正常不要传。",
            ),
          ],
          security: optionalBearerSecurity(),
          responses: {
            "200": response(
              "分页番剧列表",
              allOf([
                schemaRef("PagedSubjectList"),
                objectSchema({ cache: cacheSchema }),
              ]),
            ),
            "500": errorResponse,
          },
        },
      },
      "/v1/subjects/{subjectId}": {
        get: {
          tags: ["番剧"],
          summary: "获取番剧详情",
          description: [
            "获取单个 Bangumi subject 的详情。默认 full=true，会聚合 subject 基础信息、章节、角色/声优、制作人员、关联条目、吐槽箱、讨论版、播出时间。",
            "full=false 时只返回简略 SubjectListItem，适合列表补全或低成本探测。",
            "comments 和 topics 来自 Bangumi 网页 HTML 解析，不是官方结构化 API；full=true 时每次响应都会实时解析并覆盖缓存详情里的 comments/topics，解析失败时接口仍会返回 subject 主体，并在 source.notes 标出失败原因。",
          ].join("\n\n"),
          parameters: [
            pathId("subjectId", "Bangumi subject ID。"),
            queryParam("full", "boolean", "是否返回聚合详情。默认 true。", {
              default: true,
            }),
            forceQueryParam(),
          ],
          security: optionalBearerSecurity(),
          responses: {
            "200": response(
              "番剧详情",
              objectSchema(
                {
                  data: {
                    oneOf: [
                      schemaRef("SubjectDetail"),
                      schemaRef("SubjectListItem"),
                    ],
                  },
                  cache: cacheSchema,
                },
                ["data", "cache"],
              ),
            ),
            "404": errorResponse,
            "500": errorResponse,
          },
        },
      },
      "/v1/subjects/{subjectId}/episodes": listChildEndpoint(
        "番剧章节列表",
        "获取某个 subject 的主线章节列表，只返回 type=main 的章节。",
        "Episode",
      ),
      "/v1/subjects/{subjectId}/characters": listChildEndpoint(
        "番剧角色和声优",
        "获取角色列表，并尽量包含关联声优、角色图、声优图。",
        "CharacterCredit",
      ),
      "/v1/subjects/{subjectId}/staff": listChildEndpoint(
        "番剧制作人员",
        "获取制作团队/制作人员信息，包含 relation/role、头像、Bangumi person 链接。",
        "StaffCredit",
      ),
      "/v1/subjects/{subjectId}/comments": htmlListEndpoint(
        "番剧吐槽箱",
        "从 Bangumi subject 页面实时解析公开吐槽箱，不读写 R2 缓存。官方 v0 API 暂不提供该数据，因此这是 best-effort 数据源。",
        "SubjectComment",
      ),
      "/v1/subjects/{subjectId}/topics": htmlListEndpoint(
        "番剧讨论版主题",
        "从 Bangumi subject 页面实时解析公开讨论版主题，不读写 R2 缓存。适合详情页展示最近讨论。",
        "Topic",
      ),
      "/v1/episodes/{episodeId}": {
        get: {
          tags: ["章节"],
          summary: "获取单集详情",
          description:
            "通过 Bangumi episodeId 获取章节名、中文名、播出日期、时长、简介、评论数和 Bangumi URL。",
          parameters: [
            pathId("episodeId", "Bangumi episode ID。"),
            forceQueryParam(),
          ],
          security: optionalBearerSecurity(),
          responses: {
            "200": response(
              "单集详情",
              objectSchema({ data: schemaRef("Episode"), cache: cacheSchema }, [
                "data",
                "cache",
              ]),
            ),
            "404": errorResponse,
            "500": errorResponse,
          },
        },
      },
      "/v1/episodes/{episodeId}/comments": {
        get: {
          tags: ["章节"],
          summary: "获取单集评论",
          description: [
            "从 Bangumi 单集页面 HTML 实时解析公开评论，不读写 R2 缓存。官方 v0 API 暂不提供 episode comments。",
            "如果 Bangumi 页面结构变化、评论需要登录、或被访问限制，data 可能为空；此时 source.available=false。",
          ].join("\n\n"),
          parameters: [pathId("episodeId", "Bangumi episode ID。")],
          security: optionalBearerSecurity(),
          responses: {
            "200": response("单集评论列表", htmlListResponse("EpisodeComment")),
            "500": errorResponse,
          },
        },
      },
      "/v1/schedule/latest": {
        get: {
          tags: ["时间表"],
          summary: "获取日期窗口内的播出时间表",
          description: [
            "以 date 为中心，返回前后 days 天的播出条目。默认 date 是上海时区今天，days=7，因此窗口是前 7 天到后 7 天。",
            "数据源优先使用 bangumi-data 的 broadcast 规则，并从 sites 中提取 Bangumi subjectId。没有 broadcast 但有 begin 的条目会使用 begin-weekly-fallback 兜底。",
            "服务端会额外读取 Bangumi /calendar，并按窗口涉及的季度做少量 Bangumi 搜索补全：能匹配 subjectId 的条目会尽量补 coverUrl、episodeTotal、tags、metaTags、nsfw。补不到时不会丢条目，而是通过 needsFallback 和 nsfwStatus 明确告诉客户端需要兜底。",
            "返回同时包含扁平 items 和按日期分组的 byDate，客户端可以直接做今日更新、前后 7 日时间轴或日历视图。默认不截断数量。",
          ].join("\n\n"),
          parameters: [
            queryParam(
              "date",
              "string",
              "中心日期，格式 YYYY-MM-DD。默认上海时区今天。",
              { format: "date", example: "2026-06-22" },
            ),
            queryParam(
              "days",
              "integer",
              "前后窗口天数。0 表示只看 date 当天，最大 31。",
              { default: 7, minimum: 0, maximum: 31 },
            ),
            queryParam(
              "requireBroadcast",
              "boolean",
              "是否只返回有明确 broadcast 规则的条目。默认 false，会允许 begin 周更兜底。",
              { default: false },
            ),
            queryParam(
              "includeNsfw",
              "boolean",
              "是否包含已确认 NSFW 的条目。默认 false，会过滤 nsfw=true；nsfwStatus=unknown 的条目默认保留。",
              { default: false },
            ),
            queryParam(
              "includeUnknownNsfw",
              "boolean",
              "是否保留 NSFW 状态未知的条目。默认 true。若你要严格安全展示，可以传 false，只保留 nsfwStatus=safe 的条目。",
              { default: true },
            ),
            forceQueryParam("是否绕过 R2 缓存重新生成。"),
          ],
          security: optionalBearerSecurity(),
          responses: {
            "200": response(
              "播出时间表",
              allOf([
                schemaRef("ScheduleResponse"),
                objectSchema({ cache: cacheSchema }),
              ]),
            ),
            "500": errorResponse,
          },
        },
      },
      "/v1/schedule/today": {
        get: {
          tags: ["时间表"],
          summary: "获取今日更新",
          description:
            "读取 /v1/schedule/latest 的缓存结果，并按上海时区今天过滤 byDate。适合首页“今日更新”模块。默认不截断数量；字段含义与 /v1/schedule/latest 的 ScheduleOccurrence 相同。",
          parameters: [
            queryParam(
              "date",
              "string",
              "用于生成缓存窗口的中心日期；一般不需要传。",
              { format: "date" },
            ),
            queryParam(
              "days",
              "integer",
              "用于生成缓存窗口的前后天数；默认 7。",
              { default: 7, minimum: 0, maximum: 31 },
            ),
            queryParam(
              "requireBroadcast",
              "boolean",
              "是否只返回有明确 broadcast 规则的条目。",
              { default: false },
            ),
            queryParam(
              "includeNsfw",
              "boolean",
              "是否包含已确认 NSFW 的条目。默认 false。",
              { default: false },
            ),
            queryParam(
              "includeUnknownNsfw",
              "boolean",
              "是否保留 NSFW 状态未知的条目。默认 true。",
              { default: true },
            ),
            forceQueryParam(),
          ],
          security: optionalBearerSecurity(),
          responses: {
            "200": response(
              "今日更新",
              objectSchema(
                {
                  generatedAt: { type: "string", format: "date-time" },
                  date: { type: "string", format: "date" },
                  items: arrayOf("ScheduleOccurrence"),
                  cache: cacheSchema,
                },
                ["generatedAt", "date", "items", "cache"],
              ),
            ),
            "500": errorResponse,
          },
        },
      },
      "/v1/seasons/current": seasonEndpoint(
        "当前季度番剧",
        "返回当前季度动画列表。季度按开播日期动态计算，不写死年份；可通过 season 参数查看指定季度。",
        "rank",
      ),
      "/v1/trending/current": seasonEndpoint(
        "当前季度热播",
        "返回当前季度热播动画，默认按 Bangumi heat 排序。适合首页“本季度热播”。",
        "heat",
      ),
      "/v1/internal/refresh": {
        post: {
          tags: ["内部"],
          summary: "刷新物化缓存",
          description: [
            "触发 Worker 后台刷新 schedule、当前季度列表、当前季度热播列表。接口会立即返回 accepted=true，实际刷新在 waitUntil 中继续执行。",
            "如果配置了 ADMIN_TOKEN，必须带 Authorization: Bearer <ADMIN_TOKEN>。生产环境应始终配置 ADMIN_TOKEN。",
          ].join("\n\n"),
          security: [{ bearerAuth: [] }],
          responses: {
            "200": response(
              "刷新任务已接受",
              objectSchema(
                {
                  accepted: { type: "boolean" },
                  startedAt: { type: "string", format: "date-time" },
                },
                ["accepted", "startedAt"],
              ),
            ),
            "401": errorResponse,
            "500": errorResponse,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "ADMIN_TOKEN",
          description: "仅 /v1/internal/refresh 使用。",
        },
      },
      schemas: schemas(),
    },
  };
}

export function docsHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Melon API 文档</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body { margin: 0; background: #f7faf9; }
      .swagger-ui .topbar { display: none; }
      .swagger-ui .info { margin: 32px 0; }
      .swagger-ui .info .title { color: #12313a; }
      .swagger-ui .scheme-container { box-shadow: none; border: 1px solid #d8e5e0; border-radius: 8px; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        displayRequestDuration: true,
        defaultModelsExpandDepth: -1,
        defaultModelExpandDepth: 1,
        docExpansion: "none",
        persistAuthorization: true
      });
      const zhText = new Map([
        ["Servers", "服务器"],
        ["Authorize", "授权"],
        ["Schemas", "数据模型"],
        ["Responses", "响应"],
        ["Parameters", "参数"],
        ["Request body", "请求体"],
        ["Try it out", "试请求"],
        ["Execute", "发送请求"],
        ["Clear", "清空"],
        ["Cancel", "取消"],
        ["Response content type", "响应内容类型"],
        ["Code", "状态码"],
        ["Description", "说明"],
        ["Example Value", "示例值"],
        ["Schema", "结构"],
        ["No parameters", "无参数"],
        ["Models", "数据模型"]
      ]);

      function translateSwaggerChrome() {
        const root = document.getElementById("swagger-ui");
        if (!root) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const value = node.nodeValue.trim();
          const translated = zhText.get(value);
          if (translated) node.nodeValue = node.nodeValue.replace(value, translated);
        }
      }

      translateSwaggerChrome();
      new MutationObserver(translateSwaggerChrome).observe(document.getElementById("swagger-ui"), {
        childList: true,
        subtree: true
      });
    </script>
  </body>
</html>`;
}

function schemas(): Record<string, unknown> {
  return {
    ApiError: objectSchema(
      {
        error: objectSchema(
          {
            code: { type: "string", example: "UNAUTHORIZED" },
            message: {
              type: "string",
              example: "Missing or invalid admin token.",
            },
            details: {},
          },
          ["code", "message"],
        ),
      },
      ["error"],
    ),
    CacheMeta: objectSchema({
      key: { type: "string", description: "R2 缓存 key。" },
      hit: { type: "boolean", description: "是否命中缓存。" },
      stale: {
        type: "boolean",
        description:
          "是否返回了已过期的旧缓存。仅在外部数据源刷新失败且存在旧缓存时出现。",
      },
      cachedAt: { type: "string", format: "date-time" },
      expiresAt: { type: "string", format: "date-time" },
    }),
    PagedSubjectList: objectSchema(
      {
        total: { type: "integer" },
        limit: { type: "integer" },
        offset: { type: "integer" },
        hasMore: { type: "boolean" },
        data: arrayOf("SubjectListItem"),
      },
      ["total", "limit", "offset", "hasMore", "data"],
    ),
    SubjectListItem: objectSchema(
      {
        subjectId: idSchema("Bangumi subject ID。"),
        name: { type: "string" },
        nameCn: { type: "string" },
        displayName: { type: "string" },
        type: { type: "string", enum: ["anime"] },
        coverUrl: { type: "string", format: "uri" },
        summary: { type: "string" },
        shortSummary: { type: "string" },
        airDate: { type: "string", format: "date" },
        season: schemaRef("SeasonInfo"),
        platform: { type: "string", example: "TV" },
        episodeTotal: { type: "integer" },
        nsfw: {
          type: "boolean",
          description: "Bangumi 返回的 NSFW 标记；缺失表示未知。",
        },
        score: { type: "number" },
        rank: { type: "integer" },
        tags: arrayOf("SubjectTag"),
        metaTags: { type: "array", items: { type: "string" } },
        url: { type: "string", format: "uri" },
      },
      ["subjectId", "name", "displayName", "type", "tags", "metaTags", "url"],
    ),
    SubjectDetail: allOf([
      schemaRef("SubjectListItem"),
      objectSchema(
        {
          ratingCount: { type: "integer" },
          rating: schemaRef("Rating"),
          collectionStats: schemaRef("SubjectCollectionStats"),
          infoBox: arrayOf("SubjectInfoBoxItem"),
          episodes: arrayOf("Episode"),
          characters: arrayOf("CharacterCredit"),
          staff: arrayOf("StaffCredit"),
          relatedSubjects: arrayOf("RelatedSubject"),
          comments: arrayOf("SubjectComment"),
          topics: arrayOf("Topic"),
          schedule: schemaRef("SubjectSchedule"),
          source: schemaRef("SourceInfo"),
        },
        [
          "infoBox",
          "episodes",
          "characters",
          "staff",
          "relatedSubjects",
          "comments",
          "topics",
          "source",
        ],
      ),
    ]),
    SubjectTag: objectSchema(
      { name: { type: "string" }, count: { type: "integer" } },
      ["name"],
    ),
    SeasonInfo: objectSchema(
      {
        year: { type: "integer", example: 2026 },
        quarter: { type: "integer", enum: [1, 2, 3, 4] },
        code: { type: "string", example: "2026-summer" },
        label: { type: "string", example: "2026 SUMMER" },
        name: { type: "string", enum: ["WINTER", "SPRING", "SUMMER", "FALL"] },
      },
      ["year", "quarter", "code", "label", "name"],
    ),
    Rating: objectSchema({
      score: { type: "number", example: 7.2 },
      rank: { type: "integer", example: 7400 },
      total: { type: "integer" },
      count: { type: "object", additionalProperties: { type: "integer" } },
    }),
    SubjectCollectionStats: objectSchema({
      wish: { type: "integer", description: "想看" },
      watching: { type: "integer", description: "在看" },
      completed: { type: "integer", description: "看过" },
      on_hold: { type: "integer", description: "搁置" },
      dropped: { type: "integer", description: "抛弃" },
    }),
    SubjectInfoBoxItem: objectSchema(
      {
        key: { type: "string", example: "放送开始" },
        value: { type: "string", example: "2026年4月" },
      },
      ["key", "value"],
    ),
    Episode: objectSchema(
      {
        episodeId: idSchema("Bangumi episode ID。"),
        subjectId: idSchema("所属 subject ID。"),
        type: {
          type: "string",
          enum: ["main", "special", "op", "ed", "trailer", "mad", "other"],
        },
        sort: { type: "number" },
        ep: { type: "number" },
        name: { type: "string" },
        nameCn: { type: "string" },
        displayName: { type: "string" },
        airdate: { type: "string", format: "date" },
        duration: { type: "string" },
        desc: { type: "string" },
        commentCount: { type: "integer" },
        url: { type: "string", format: "uri" },
      },
      ["episodeId", "subjectId", "type", "sort", "name", "displayName", "url"],
    ),
    CharacterCredit: objectSchema(
      {
        characterId: idSchema("Bangumi character ID。"),
        name: { type: "string" },
        nameCn: { type: "string" },
        displayName: { type: "string" },
        role: { type: "string", example: "主角" },
        imageUrl: { type: "string", format: "uri" },
        actors: arrayOf("PersonCredit"),
        url: { type: "string", format: "uri" },
      },
      ["characterId", "name", "displayName", "actors", "url"],
    ),
    PersonCredit: objectSchema(
      {
        personId: idSchema("Bangumi person ID。"),
        name: { type: "string" },
        nameCn: { type: "string" },
        displayName: { type: "string" },
        imageUrl: { type: "string", format: "uri" },
        relation: { type: "string" },
        career: { type: "array", items: { type: "string" } },
        url: { type: "string", format: "uri" },
      },
      ["personId", "name", "displayName", "url"],
    ),
    StaffCredit: allOf([
      schemaRef("PersonCredit"),
      objectSchema({ role: { type: "string", example: "导演" } }),
    ]),
    RelatedSubject: objectSchema(
      {
        subjectId: idSchema("Bangumi subject ID。"),
        name: { type: "string" },
        nameCn: { type: "string" },
        displayName: { type: "string" },
        relation: { type: "string", example: "续集" },
        coverUrl: { type: "string", format: "uri" },
        url: { type: "string", format: "uri" },
      },
      ["subjectId", "name", "displayName", "url"],
    ),
    SubjectComment: objectSchema(
      {
        id: { type: "string" },
        user: schemaRef("CommentUser"),
        score: { type: "number" },
        status: { type: "string", example: "在看" },
        createdAt: { type: "string" },
        text: { type: "string" },
        url: { type: "string", format: "uri" },
      },
      ["user", "text"],
    ),
    EpisodeComment: objectSchema(
      {
        floor: { type: "integer" },
        user: schemaRef("CommentUser"),
        createdAt: { type: "string" },
        text: { type: "string" },
        url: { type: "string", format: "uri" },
      },
      ["user", "text"],
    ),
    CommentUser: objectSchema(
      {
        username: { type: "string" },
        nickname: { type: "string" },
        avatarUrl: { type: "string", format: "uri" },
      },
      ["nickname"],
    ),
    Topic: objectSchema(
      {
        topicId: { type: "integer" },
        title: { type: "string" },
        author: { type: "string" },
        replies: { type: "integer" },
        updatedAt: { type: "string" },
        url: { type: "string", format: "uri" },
      },
      ["title"],
    ),
    HtmlSource: objectSchema(
      {
        provider: { type: "string", enum: ["bangumi-web"] },
        available: { type: "boolean" },
        note: { type: "string" },
      },
      ["provider", "available", "note"],
    ),
    SubjectSchedule: objectSchema({
      firstAiringAt: { type: "string", format: "date-time" },
      firstAiringAtShanghai: { type: "string", example: "2026-06-22 00:00" },
      weekday: { type: "string", example: "周一" },
      recurrence: { type: "string", enum: ["P0D", "P1D", "P7D", "P1M"] },
      nextAiringAt: { type: "string", format: "date-time" },
      nextAiringAtShanghai: { type: "string" },
      source: {
        type: "string",
        enum: ["bangumi-data", "bangumi-date", "unknown"],
      },
    }),
    ScheduleResponse: objectSchema(
      {
        generatedAt: { type: "string", format: "date-time" },
        centerDate: { type: "string", format: "date" },
        days: { type: "integer" },
        window: objectSchema(
          {
            start: { type: "string", example: "2026-06-15 00:00" },
            endExclusive: { type: "string", example: "2026-06-30 00:00" },
          },
          ["start", "endExclusive"],
        ),
        items: arrayOf("ScheduleOccurrence"),
        byDate: {
          type: "object",
          additionalProperties: {
            type: "array",
            items: schemaRef("ScheduleOccurrence"),
          },
        },
      },
      ["generatedAt", "centerDate", "days", "window", "items", "byDate"],
    ),
    ScheduleOccurrence: objectSchema(
      {
        airingAt: { type: "string", format: "date-time" },
        airingAtShanghai: { type: "string", example: "2026-06-22 00:00" },
        weekday: { type: "string", example: "周一" },
        subjectId: idSchema("Bangumi subject ID，可能缺失。"),
        name: { type: "string" },
        nameCn: { type: "string" },
        displayName: { type: "string" },
        type: { type: "string", example: "tv" },
        coverUrl: { type: "string", format: "uri" },
        episodeTotal: { type: "integer" },
        tags: arrayOf("SubjectTag"),
        metaTags: { type: "array", items: { type: "string" } },
        nsfw: {
          type: "boolean",
          description: "已补全时的 Bangumi NSFW 标记；缺失表示未知。",
        },
        nsfwStatus: {
          type: "string",
          enum: ["safe", "nsfw", "unknown"],
          description:
            "safe=已确认非 NSFW；nsfw=已确认 NSFW；unknown=当前数据源无法确认。",
        },
        hasSubjectId: {
          type: "boolean",
          description: "是否从 bangumi-data sites 中提取到 Bangumi subjectId。",
        },
        detailAvailable: {
          type: "boolean",
          description: "客户端是否可以直接跳转 /v1/subjects/{subjectId}。",
        },
        needsFallback: objectSchema(
          {
            cover: {
              type: "boolean",
              description: "true 表示前端应使用渐变/占位封面。",
            },
            episodeTotal: {
              type: "boolean",
              description: "true 表示总集数未知。",
            },
            nsfw: {
              type: "boolean",
              description: "true 表示后端无法确认 NSFW 状态。",
            },
          },
          ["cover", "episodeTotal", "nsfw"],
        ),
        url: { type: "string", format: "uri" },
        sites: {
          type: "array",
          items: objectSchema({
            site: { type: "string" },
            id: {
              oneOf: [
                { type: "string" },
                { type: "integer" },
                { type: "null" },
              ],
            },
            url: { type: "string", format: "uri" },
          }),
        },
        source: objectSchema(
          {
            ruleKind: {
              type: "string",
              enum: ["broadcast", "begin-weekly-fallback"],
            },
            broadcast: { type: "string" },
            begin: { type: "string" },
            end: { type: "string" },
          },
          ["ruleKind"],
        ),
      },
      [
        "airingAt",
        "airingAtShanghai",
        "weekday",
        "name",
        "displayName",
        "type",
        "tags",
        "metaTags",
        "nsfwStatus",
        "hasSubjectId",
        "detailAvailable",
        "needsFallback",
        "sites",
        "source",
      ],
    ),
    SourceInfo: objectSchema(
      {
        provider: { type: "string", enum: ["bangumi"] },
        subjectUrl: { type: "string", format: "uri" },
        apiCoverage: objectSchema({
          subject: { type: "boolean" },
          episodes: { type: "boolean" },
          characters: { type: "boolean" },
          staff: { type: "boolean" },
          relatedSubjects: { type: "boolean" },
          comments: { type: "boolean" },
          topics: { type: "boolean" },
        }),
        notes: { type: "array", items: { type: "string" } },
      },
      ["provider", "apiCoverage", "notes"],
    ),
  };
}

function listChildEndpoint(
  summary: string,
  description: string,
  itemSchema: string,
): unknown {
  return {
    get: {
      tags: ["番剧"],
      summary,
      description,
      parameters: [
        pathId("subjectId", "Bangumi subject ID。"),
        forceQueryParam(),
      ],
      security: optionalBearerSecurity(),
      responses: {
        "200": response(
          summary,
          objectSchema(
            { data: arrayOf(itemSchema), cache: schemaRef("CacheMeta") },
            ["data", "cache"],
          ),
        ),
        "404": response("未找到", schemaRef("ApiError")),
        "500": response("错误响应", schemaRef("ApiError")),
      },
    },
  };
}

function htmlListEndpoint(
  summary: string,
  description: string,
  itemSchema: string,
): unknown {
  return {
    get: {
      tags: ["番剧"],
      summary,
      description,
      parameters: [pathId("subjectId", "Bangumi subject ID。")],
      security: optionalBearerSecurity(),
      responses: {
        "200": response(summary, htmlListResponse(itemSchema)),
        "500": response("错误响应", schemaRef("ApiError")),
      },
    },
  };
}

function seasonEndpoint(
  summary: string,
  description: string,
  defaultSort: "rank" | "heat",
): unknown {
  return {
    get: {
      tags: ["季度"],
      summary,
      description: [
        description,
        "season 不传时按当前日期动态计算当前季度；例如 2026 年 6 月属于 2026 SPRING，2026 年 7 月属于 2026 SUMMER。",
      ].join("\n\n"),
      parameters: [
        queryParam(
          "season",
          "string",
          "指定季度。支持 current、2026-summer、2026 SUMMER、2026Q3 等常见写法。",
          { default: "current", example: "2026-summer" },
        ),
        arrayQueryParam("tag", "追加 Bangumi 标签筛选。", ["TV"]),
        arrayQueryParam("metaTag", "追加 Bangumi meta_tags 筛选。", ["日本"]),
        queryParam("sort", "string", `排序方式。该接口默认 ${defaultSort}。`, {
          enum: ["match", "heat", "rank", "score"],
          default: defaultSort,
        }),
        queryParam(
          "limit",
          "integer",
          "返回数量。默认使用 Bangumi 单次搜索上限 100，避免首页/季度页无参数时丢数据。",
          { default: 100, minimum: 1, maximum: 100 },
        ),
        queryParam("offset", "integer", "分页偏移。", {
          default: 0,
          minimum: 0,
        }),
        queryParam(
          "includeNsfw",
          "boolean",
          "是否允许 NSFW 结果。默认 false。",
          { default: false },
        ),
        forceQueryParam(),
      ],
      security: optionalBearerSecurity(),
      responses: {
        "200": response(
          summary,
          allOf([
            objectSchema(
              {
                season: schemaRef("SeasonInfo"),
                range: objectSchema(
                  {
                    start: { type: "string", format: "date" },
                    end: { type: "string", format: "date" },
                  },
                  ["start", "end"],
                ),
                cache: schemaRef("CacheMeta"),
              },
              ["season", "range", "cache"],
            ),
            schemaRef("PagedSubjectList"),
          ]),
        ),
        "500": response("错误响应", schemaRef("ApiError")),
      },
    },
  };
}

function htmlListResponse(itemSchema: string): unknown {
  return objectSchema(
    {
      data: arrayOf(itemSchema),
      source: schemaRef("HtmlSource"),
    },
    ["data", "source"],
  );
}

function response(description: string, schema: unknown): unknown {
  return { description, content: { "application/json": { schema } } };
}

function pathId(name: string, description: string): unknown {
  return {
    name,
    in: "path",
    required: true,
    description,
    schema: { type: "integer", minimum: 1 },
  };
}

function queryParam(
  name: string,
  type: string,
  description: string,
  extra: Record<string, unknown> = {},
): unknown {
  return { name, in: "query", description, schema: { type, ...extra } };
}

function forceQueryParam(description = "是否绕过 R2 缓存。"): unknown {
  return queryParam(
    "force",
    "boolean",
    `${description} 需要 Authorization: Bearer <ADMIN_TOKEN>。`,
    { default: false },
  );
}

function optionalBearerSecurity(): unknown[] {
  return [{ bearerAuth: [] }, {}];
}

function arrayQueryParam(
  name: string,
  description: string,
  example: string[],
): unknown {
  return {
    name,
    in: "query",
    description,
    style: "form",
    explode: true,
    schema: { type: "array", items: { type: "string" }, example },
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): unknown {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  };
}

function arrayOf(schemaName: string): unknown {
  return { type: "array", items: schemaRef(schemaName) };
}

function schemaRef(name: string): unknown {
  return { $ref: `#/components/schemas/${name}` };
}

function allOf(items: unknown[]): unknown {
  return { allOf: items };
}

function idSchema(description: string): unknown {
  return { type: "integer", minimum: 1, description };
}
