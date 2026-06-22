import type { Env, EpisodeComment, SubjectComment, Topic } from "./types";
import { baseWeb, htmlDecode, stripTags, userAgent } from "./utils";

export async function fetchSubjectComments(
  env: Env,
  subjectId: number,
): Promise<SubjectComment[]> {
  const html = await fetchBangumiHtml(
    env,
    `/subject/${subjectId}/comments`,
  ).catch(() => "");
  if (!html) return [];
  return subjectCommentBlocks(html)
    .flatMap((block) => {
      const username = firstMatch(block, /data-item-user="([^"]+)"/);
      const nickname = subjectCommentNickname(block);
      const avatar = firstMatch(
        block,
        /<span class="avatarNeue[^"]*"[^>]*style="background-image:url\('([^']+)'\)/,
      );
      const text = subjectCommentMessage(block);
      const score = firstMatch(block, /starlight stars(\d+)/);
      const status = subjectCommentStatus(block);
      const time = subjectCommentTime(block);
      if (!nickname || !text) return [];
      return [
        {
          id: firstMatch(block, /likes_grid_(\d+)/),
          user: {
            username,
            nickname,
            avatarUrl: normalizeUrl(env, avatar),
          },
          score: score ? Number(score) : undefined,
          status: status || undefined,
          createdAt: time || undefined,
          text,
          url: `${baseWeb(env)}/subject/${subjectId}/comments`,
        },
      ];
    });
}

export async function fetchSubjectTopics(
  env: Env,
  subjectId: number,
): Promise<Topic[]> {
  const html = await fetchBangumiHtml(env, `/subject/${subjectId}/board`).catch(
    () => "",
  );
  if (!html) return [];
  const rows = matchAll(html, /<tr[\s\S]*?<\/tr>/g).slice(0, 30);
  return rows.flatMap((row) => {
    const href = firstMatch(row, /href="\/subject\/topic\/(\d+)"/);
    const title = stripTags(
      firstMatch(
        row,
        /<a[^>]+href="\/subject\/topic\/\d+"[^>]*>([\s\S]*?)<\/a>/,
      ) ?? "",
    );
    const author = stripTags(
      firstMatch(row, /<a[^>]+href="\/user\/[^"]+"[^>]*>([\s\S]*?)<\/a>/) ?? "",
    );
    const repliesText = stripTags(
      firstMatch(
        row,
        /<td[^>]+class="[\w\s-]*replies[\w\s-]*"[^>]*>([\s\S]*?)<\/td>/,
      ) ?? "",
    );
    const updatedAt = stripTags(
      firstMatch(row, /<small[^>]*class="grey"[^>]*>([\s\S]*?)<\/small>/) ?? "",
    );
    if (!title) return [];
    return [
      {
        topicId: href ? Number(href) : undefined,
        title,
        author: author || undefined,
        replies: repliesText
          ? Number.parseInt(repliesText, 10) || undefined
          : undefined,
        updatedAt: updatedAt || undefined,
        url: href ? `${baseWeb(env)}/subject/topic/${href}` : undefined,
      },
    ];
  });
}

export async function fetchEpisodeComments(
  env: Env,
  episodeId: number,
): Promise<EpisodeComment[]> {
  const html = await fetchBangumiHtml(env, `/ep/${episodeId}`).catch(() => "");
  if (!html) return [];
  return postBlocks(html)
    .slice(0, 50)
    .flatMap((block) => {
      const floorText = firstMatch(block, /#(\d+)\s*-/);
      const nickname = postNickname(block);
      const avatar = firstMatch(
        block,
        /<span class="avatarNeue[^"]*"[^>]*style="background-image:url\('([^']+)'\)/,
      );
      const text = postMessage(block);
      const time = postTime(block);
      if (!nickname || !text) return [];
      return [
        {
          floor: floorText ? Number(floorText) : undefined,
          user: {
            nickname,
            avatarUrl: normalizeUrl(env, avatar),
          },
          createdAt: time || undefined,
          text,
          url: `${baseWeb(env)}/ep/${episodeId}`,
        },
      ];
    });
}

async function fetchBangumiHtml(env: Env, path: string): Promise<string> {
  const response = await fetch(`${baseWeb(env)}${path}`, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": userAgent(env),
    },
  });
  if (!response.ok) throw new Error(`Bangumi web ${response.status} ${path}`);
  return response.text();
}

function postBlocks(html: string): string[] {
  const starts = Array.from(
    html.matchAll(/<div id="post_\d+"/g),
    (match) => match.index ?? -1,
  ).filter((index) => index >= 0);
  return starts.map((start, index) =>
    html.slice(start, starts[index + 1] ?? html.length),
  );
}

function subjectCommentBlocks(html: string): string[] {
  const commentBox = sliceFromTo(
    html,
    '<div id="comment_box"',
    [
      '<template id="likes_reaction_grid_item"',
      '<div class="page_inner"',
      '<div id="columnInSubjectB"',
    ],
  );
  if (!commentBox) return postBlocks(html).slice(0, 20);
  const starts = Array.from(
    commentBox.matchAll(/<div class="item clearit" data-item-user="[^"]+"/g),
    (match) => match.index ?? -1,
  ).filter((index) => index >= 0);
  return starts.slice(0, 20).map((start, index) =>
    commentBox.slice(start, starts[index + 1] ?? commentBox.length),
  );
}

function subjectCommentNickname(block: string): string {
  return stripTags(
    firstMatch(
      block,
      /<a href="\/user\/[^"]+" class="l">([\s\S]*?)<\/a>/,
    ) ?? "",
  );
}

function subjectCommentMessage(block: string): string {
  return htmlDecode(
    firstMatch(block, /<p class="comment">([\s\S]*?)<\/p>/) ?? "",
  );
}

function subjectCommentStatus(block: string): string {
  const smallTexts = greySmallTexts(block);
  return smallTexts.find((text) => text && !text.startsWith("@")) ?? "";
}

function subjectCommentTime(block: string): string {
  return (
    greySmallTexts(block)
      .find((text) => text.startsWith("@"))
      ?.replace(/^@\s*/, "") ?? ""
  );
}

function greySmallTexts(block: string): string[] {
  return Array.from(
    block.matchAll(/<small[^>]*class="grey"[^>]*>([\s\S]*?)<\/small>/g),
    (match) => stripTags(match[1] ?? ""),
  );
}

function postNickname(block: string): string {
  return stripTags(
    firstMatch(block, /<strong[^>]*>([\s\S]*?)<\/strong>/) ?? "",
  );
}

function postMessage(block: string): string {
  const raw =
    firstMatch(
      block,
      /<div class="message clearit">([\s\S]*?)<\/div>\s*<div class="likes_grid"/,
    ) ??
    firstMatch(
      block,
      /<div class="reply_content">([\s\S]*?)<\/div>\s*<\/div>/,
    ) ??
    "";
  return htmlDecode(raw);
}

function postTime(block: string): string {
  return stripTags(
    firstMatch(block, /<small[^>]*>([\s\S]*?)<\/small>/) ?? "",
  ).replace(/^#\d+\s*-\s*/, "");
}

function matchAll(value: string, pattern: RegExp): string[] {
  return Array.from(value.matchAll(pattern), (match) => match[0]);
}

function firstMatch(value: string, pattern: RegExp): string | undefined {
  return pattern.exec(value)?.[1];
}

function sliceFromTo(
  value: string,
  startNeedle: string,
  endNeedles: string[],
): string {
  const start = value.indexOf(startNeedle);
  if (start < 0) return "";
  const ends = endNeedles
    .map((needle) => value.indexOf(needle, start + startNeedle.length))
    .filter((index) => index > start);
  return value.slice(start, ends.length ? Math.min(...ends) : value.length);
}

function normalizeUrl(env: Env, value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${baseWeb(env)}${value}`;
  return value;
}
