export function openApiSpec(publicBaseUrl: string): unknown {
  const cacheSchema = schemaRef("CacheMeta");
  const errorResponse = response("错误响应", schemaRef("ApiError"));

  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Melon API",
      version: "0.1.9",
      description: [
        "Melon API 只提供 melonbang 客户端需要“所有用户共享一次计算”或“由维护者统一下发”的数据：季度完整目录索引、bangumi-data 与 Bangumi 日历合成的播出时间表、按 subjectId 关联的地区译名，以及在线来源规则快照。",
        "条目详情、章节、角色、制作人员、搜索和社区内容由客户端直接读取 Bangumi，不经过本服务。",
        "结构化目录响应支持 ETag / If-None-Match。304 与 200 都通过 X-Cache-Expires-At、X-Cache-Stale 给出新鲜度。无效日期、整数、布尔值、排序和季度参数返回 400。",
      ].join("\n\n"),
    },
    servers: [{ url: publicBaseUrl, description: "正式 API 域名" }],
    tags: [
      { name: "基础", description: "服务状态、OpenAPI 文档。" },
      { name: "番剧", description: "按 subjectId 关联的 bangumi-data 地区译名。" },
      { name: "时间表", description: "从 bangumi-data 聚合的播出时间表。" },
      { name: "季度", description: "当前季度列表和热播列表。" },
      { name: "内部", description: "缓存刷新等运维接口。" },
    ],
    paths: {
      "/sources/rules": {
        get: {
          tags: ["基础"],
          summary: "在线来源声明式规则",
          description: "返回维护者管理的规则快照。支持 If-None-Match / ETag。高于客户端 engine 的规则仍返回，以便客户端提示更新应用；带 builtinBefore 且高于客户端 engine 的规则不返回，因为旧客户端已内置该来源。规则不包含可执行脚本。",
          parameters: [queryParam("engine", "integer", "客户端引擎版本。", { default: 1, minimum: 0 })],
          responses: {
            "200": response("规则快照", objectSchema({
              engine: { type: "integer" }, version: { type: "string" },
              updatedAt: { type: "string", format: "date-time" },
              rules: { type: "array", items: { type: "object" } },
              requiresUpdate: { type: "array", items: { type: "string" } },
            }, ["engine", "version", "updatedAt", "rules"])),
            "304": { description: "规则未变化。" },
          },
        },
      },
      "/v1/auth/bangumi/token": {
        post: {
          tags: ["基础"],
          summary: "Bangumi OAuth 令牌交换",
          description: "代客户端补上 Bangumi 应用密钥后转发到 bgm.tv/oauth/access_token，原样返回状态和结果。只接受 authorization_code（code、redirect_uri、state）与 refresh_token（refresh_token、redirect_uri）两种 grant。不存储、不缓存、不记录令牌。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: objectSchema({
                  grant_type: { type: "string", enum: ["authorization_code", "refresh_token"] },
                  client_id: { type: "string" },
                  code: { type: "string" },
                  refresh_token: { type: "string" },
                  redirect_uri: { type: "string" },
                  state: { type: "string" },
                }, ["grant_type", "client_id"]),
              },
            },
          },
          responses: {
            "200": response("Bangumi 令牌", { type: "object" }),
            "503": { description: "服务端尚未配置 Bangumi 应用密钥。" },
          },
        },
      },
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
      "/v1/subjects/{subjectId}/aliases": {
        get: {
          tags: ["番剧"],
          summary: "番剧地区译名",
          description: "按 Bangumi subjectId 关联 bangumi-data 的原名及各地区译名，用于资源搜索与弹幕匹配；不根据相似标题推断。没有关联条目时 data 为空数组。",
          parameters: [pathId("subjectId", "Bangumi subject ID。"), forceQueryParam()],
          security: optionalBearerSecurity(),
          responses: {
            "200": response(
              "译名列表",
              objectSchema({ data: { type: "array", items: { type: "string" } }, cache: cacheSchema }, ["data", "cache"]),
            ),
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
            "旧 days 是日期半径，因此 days=7 返回15天。推荐 startDate + dayCount 指定明确区间（如7天），view=byDate 或 items 避免重复数据；默认 both 保留旧响应。",
            "缺失封面在后台修复，不阻塞当前时间表；文字资料使用24小时TTL并支持过期后台更新，缺图不缩短整份时间表的有效期。季度资料补全读取完整目录。",
          ].join("\n\n"),
          parameters: [
            queryParam("startDate", "string", "明确窗口起点（含），与 dayCount 配合；提供后不使用 date/days 窗口。", { format: "date" }),
            queryParam("dayCount", "integer", "从 startDate 起的总天数，不是前后半径。", { default: 7, minimum: 1, maximum: 63 }),
            queryParam("view", "string", "选择一个数据表示避免重复传输。", { enum: ["both", "items", "byDate"], default: "both" }),
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
            "使用与 /v1/schedule/latest 相同的时间表生成与缓存逻辑，默认只构建上海时区今天（days=0）。适合首页“今日更新”模块。默认不截断数量；字段含义与 /v1/schedule/latest 的 ScheduleOccurrence 相同。",
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
              "用于生成缓存窗口的前后天数；默认 0，只构建当天。",
              { default: 0, minimum: 0, maximum: 31 },
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
        true,
      ),
      "/v1/trending/current": seasonEndpoint(
        "当前季度热播",
        "返回当前季度热播动画，按 Bangumi heat 排序。适合首页“本季度热播”。",
        false,
      ),
      "/v1/internal/refresh": {
        post: {
          tags: ["内部"],
          summary: "刷新物化缓存",
          description: [
            "触发 Worker 后台刷新当季与上一季的完整目录、bangumi-data、Bangumi 日历，再生成常用时间表。接口会立即返回 accepted=true，实际刷新在 waitUntil 中继续执行。",
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
  for (const [path, operation] of Object.entries(spec.paths)) {
    if (!path.startsWith("/v1/")) continue;
    const get = (operation as { get?: { parameters?: unknown[]; responses: Record<string, unknown> } }).get;
    if (!get) continue;
    get.parameters ??= [];
    get.parameters.push({ name: "If-None-Match", in: "header", schema: { type: "string" }, description: "已有的 ETag；版本未变化时返回304。" });
    Object.assign(get.responses, {
      "304": { description: "版本未变化。保留本地数据，读取 ETag、X-Cache-Expires-At 与 X-Cache-Stale 更新缓存新鲜度。" },
      "400": errorResponse,
      "429": { description: "上游限流；可能包含 Retry-After。" },
      "502": errorResponse,
      "504": errorResponse,
    });
  }
  return spec;
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
          "是否返回了已过期的旧缓存。后台重验或上游刷新失败时可返回已有数据。",
      },
      cachedAt: { type: "string", format: "date-time" },
      expiresAt: { type: "string", format: "date-time" },
      etag: { type: "string", description: "可用于 If-None-Match 的不透明缓存版本。" },
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
    ScheduleResponse: objectSchema(
      {
        generatedAt: { type: "string", format: "date-time" },
        centerDate: { type: "string", format: "date" },
        days: { type: "integer" },
        startDate: { type: "string", format: "date" },
        dayCount: { type: "integer", minimum: 1, maximum: 63 },
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
      ["generatedAt", "centerDate", "days", "window"],
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
  };
}

function seasonEndpoint(
  summary: string,
  description: string,
  sortable: boolean,
): unknown {
  return {
    get: {
      tags: ["季度"],
      summary,
      description: [
        description,
        "season 不传时按当前日期动态计算当前季度；例如 2026 年 6 月属于 2026 SPRING，2026 年 7 月属于 2026 SUMMER。",
        "响应切自该季度预先整理的完整目录索引，不接受关键词、标签或评分筛选。",
      ].join("\n\n"),
      parameters: [
        queryParam(
          "season",
          "string",
          "指定季度。支持 current、2026-summer、2026 SUMMER、2026Q3 等常见写法。",
          { default: "current", example: "2026-summer" },
        ),
        ...(sortable ? [queryParam("sort", "string", "排序方式。", { enum: ["heat", "rank"], default: "rank" })] : []),
        queryParam(
          "limit",
          "integer",
          "返回数量。默认使用 Bangumi 单次搜索上限 100，避免首页/季度页无参数时丢数据。",
          { default: 100, minimum: 1, maximum: 100 },
        ),
        queryParam("offset", "integer", "分页偏移。", {
          default: 0,
          minimum: 0,
          maximum: 5000,
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
