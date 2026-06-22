# Melon API

用来给自家[MelonBanG](https://github.com/shirumesu/MelonBanG)用的后端 api  

基于 Bangumi.tv，使用 Cloudflare worker + R2 存储缓存数据，也欢迎大家fork去部署  

能够返回：
1. 接口健康查询： GET /health
2. 番剧搜索：GET /v1/subjects/search?q={name}
3. 本季热播：GET /v1/trending/current
4. 本季新番：GET /v1/seasons/current
5. 今日时间表：GET /v1/schedule/today
6. 一周放送时间：GET /v1/schedule/latest?days=7
7. 番剧详细(带评论区、角色/声优、制作团队等)：GET /v1/subjects/531063
8. 单集详细：GET /v1/episodes/1656040/comments

总之大概是这样子
