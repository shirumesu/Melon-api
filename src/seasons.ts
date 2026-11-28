import { BangumiClient, mapLimit } from "./bangumi";
import { cacheKey, getOrSetJson } from "./cache";
import type { Env, SeasonInfo, SubjectListItem } from "./types";
import { seasonDateRange } from "./utils";

/** Bangumi pages search results up to this offset. */
const MAX_OFFSET = 5000;

/**
 * Every anime premiering in [season], in Bangumi's [sort] order, kept a day.
 * Bangumi returns 20 results a page whatever the limit, so after the first
 * page tells the total, the rest load a few at a time.
 */
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
    cacheKey(["season-catalogue-v2", season.code, sort, includeNsfw ? "all" : "safe"]),
    { ttlSeconds: 24 * 60 * 60, staleWhileRevalidateSeconds: 24 * 60 * 60, force },
    async () => {
      const client = new BangumiClient(env);
      const page = (offset: number) => client.searchSubjects({
        q: "", limit: 100, offset, sort,
        tags: [], metaTags: [], ratings: [], ranks: [], includeNsfw,
        airDates: [`>=${range.start}`, `<=${range.end}`],
      });
      const first = await page(0);
      const size = first.data.length;
      const offsets: number[] = [];
      for (let offset = size; size > 0 && offset < first.total && offset <= MAX_OFFSET; offset += size) {
        offsets.push(offset);
      }
      const rest = await mapLimit(offsets, 4, page);
      const data: SubjectListItem[] = [...first.data, ...rest.flatMap((result) => result.data)];
      return { total: first.total, data };
    },
    background,
  );
}
