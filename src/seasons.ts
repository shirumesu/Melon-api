import { BangumiClient } from "./bangumi";
import { cacheKey, getOrSetJson } from "./cache";
import type { Env, SeasonInfo, SubjectListItem } from "./types";
import { seasonDateRange } from "./utils";

export function loadSeasonCatalogue(
  env: Env,
  season: SeasonInfo,
  sort: "heat" | "rank",
  includeNsfw: boolean,
  force = false,
  background?: (task: Promise<unknown>) => void,
) {
  const range = seasonDateRange(season);
  return getOrSetJson(
    env,
    cacheKey(["season-catalogue-v1", season.code, sort, includeNsfw ? "all" : "safe"]),
    { ttlSeconds: 24 * 60 * 60, staleWhileRevalidateSeconds: 24 * 60 * 60, force },
    async () => {
      const client = new BangumiClient(env);
      const data: SubjectListItem[] = [];
      for (let offset = 0; ;) {
        const page = await client.searchSubjects({
          q: "", limit: 100, offset, sort,
          tags: [], metaTags: [], ratings: [], ranks: [], includeNsfw,
          airDates: [`>=${range.start}`, `<=${range.end}`],
        });
        data.push(...page.data);
        if (page.data.length === 0 || offset + page.data.length >= page.total || offset + page.data.length > 5000) {
          return { total: page.total, data };
        }
        offset += page.data.length;
      }
    },
    background,
  );
}
