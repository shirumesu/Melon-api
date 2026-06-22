export function openApiSpec(origin: string): unknown {
  return {
    openapi: "3.1.0",
    info: {
      title: "Melon API",
      version: "0.1.0",
      description: "Bangumi-first anime metadata aggregation API for melonbang."
    },
    servers: [{ url: origin }],
    paths: {
      "/v1/subjects/search": {
        get: {
          summary: "Search anime subjects",
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "tag", in: "query", schema: { type: "array", items: { type: "string" } }, style: "form", explode: true },
            { name: "metaTag", in: "query", schema: { type: "array", items: { type: "string" } }, style: "form", explode: true },
            { name: "airDate", in: "query", schema: { type: "array", items: { type: "string" } }, style: "form", explode: true },
            { name: "sort", in: "query", schema: { type: "string", enum: ["match", "heat", "rank", "score"], default: "match" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } }
          ],
          responses: { "200": { description: "Paged subject list" } }
        }
      },
      "/v1/subjects/{subjectId}": {
        get: {
          summary: "Get full subject detail",
          parameters: [
            { name: "subjectId", in: "path", required: true, schema: { type: "integer" } },
            { name: "full", in: "query", schema: { type: "boolean", default: true } },
            { name: "force", in: "query", schema: { type: "boolean", default: false } }
          ],
          responses: { "200": { description: "Subject detail" } }
        }
      },
      "/v1/subjects/{subjectId}/episodes": {
        get: {
          summary: "Get main episodes for a subject",
          parameters: [{ name: "subjectId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "Episode list" } }
        }
      },
      "/v1/subjects/{subjectId}/characters": {
        get: {
          summary: "Get subject characters with actors",
          parameters: [{ name: "subjectId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "Character credits" } }
        }
      },
      "/v1/subjects/{subjectId}/staff": {
        get: {
          summary: "Get subject production staff",
          parameters: [{ name: "subjectId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "Staff credits" } }
        }
      },
      "/v1/subjects/{subjectId}/comments": {
        get: {
          summary: "Best-effort Bangumi subject comments from web HTML",
          parameters: [{ name: "subjectId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "Subject comments" } }
        }
      },
      "/v1/subjects/{subjectId}/topics": {
        get: {
          summary: "Best-effort Bangumi subject board topics from web HTML",
          parameters: [{ name: "subjectId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "Subject topics" } }
        }
      },
      "/v1/episodes/{episodeId}": {
        get: {
          summary: "Get episode detail",
          parameters: [{ name: "episodeId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "Episode detail" } }
        }
      },
      "/v1/episodes/{episodeId}/comments": {
        get: {
          summary: "Best-effort Bangumi episode comments from web HTML",
          parameters: [{ name: "episodeId", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "Episode comments" } }
        }
      },
      "/v1/schedule/latest": {
        get: {
          summary: "Get schedule for date +/- days",
          parameters: [
            { name: "date", in: "query", schema: { type: "string", format: "date" } },
            { name: "days", in: "query", schema: { type: "integer", default: 7, maximum: 31 } }
          ],
          responses: { "200": { description: "Schedule response" } }
        }
      },
      "/v1/schedule/today": {
        get: {
          summary: "Get today's schedule in Asia/Shanghai",
          responses: { "200": { description: "Today schedule response" } }
        }
      },
      "/v1/seasons/current": {
        get: {
          summary: "Get current season anime",
          responses: { "200": { description: "Current season subject list" } }
        }
      },
      "/v1/trending/current": {
        get: {
          summary: "Get current season hot anime sorted by heat",
          responses: { "200": { description: "Trending subject list" } }
        }
      },
      "/v1/internal/refresh": {
        post: {
          summary: "Refresh materialized caches",
          security: [{ bearerAuth: [] }],
          responses: { "200": { description: "Refresh result" } }
        }
      }
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" }
      }
    }
  };
}

export function docsHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Melon API Docs</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({ url: "/openapi.json", dom_id: "#swagger-ui" });
    </script>
  </body>
</html>`;
}
