// The Valve adapter: SteamOS (the Steam Deck) from the Steam news of app 1675200.
//
// Valve posts SteamOS releases to the Steam Deck news next to Steam Client updates. Only a
// title that names a SteamOS version is an OS release; "Steam Beta Client Update: ..." and
// the like are skipped. The primary source is the news API (JSON); the same posts are also
// published as RSS (FALLBACK_URL); parseFeed() reads that form, but the registered parse()
// reads the JSON only. See ADR 0006 for how both were verified.
//
// An adapter is { id, vendor, urls, parse }. `urls` is the allowlist the Worker fetches.
// The RSS feed is not on it: the Worker treats one failing URL as a failed source and
// merges the results of all of them, so a second URL would be a requirement, not a fallback.
//
// Bounds on what is emitted: a post dated more than a day after the clock is refused, and only
// posts within WINDOW_DAYS (180, under the dial's 26 weeks) of the clock and of the newest post
// are kept, the newest always, so a slow spell of Steam Client posts cannot widen the dial.

import { familyIds } from '../families.js';
import { field, isHttpsOn, mergeReleases, parseDate, rssItems } from '../releases.js';

export const ID = 'valve-steam-news';
export const VENDOR = 'valve';
// maxlength=1 keeps the post text out of the answer: only titles and tags are read.
export const NEWS_URL =
  'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=1675200&count=100&maxlength=1';
export const FALLBACK_URL = 'https://store.steampowered.com/feeds/news/app/1675200';
export const NEWS_PAGE = 'https://store.steampowered.com/news/app/1675200';
export const FAMILIES = familyIds(VENDOR);
export const LINK_HOSTS = ['store.steampowered.com', 'steamstore-a.akamaihd.net'];

const MAX_ITEMS = 500;
export const WINDOW_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SKEW_MS = DAY_MS; // a post dated further ahead than this is not believed

// "SteamOS 3.7.13", "SteamOS 3.8.1 Preview (20250522.1)", "SteamOS 3.7.13 Stable: Deck update".
// The prefix is strict; the rest of the title is read loosely (see TITLE_OK).
/** The title pattern for these family names, each matched literally. */
export function titlePattern(names) {
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^(${escaped.join('|')})\\s+(\\d+(?:\\.\\d+){1,3})(?=$|[\\s:,(])`, 'i');
}
const TITLE_RE = titlePattern(FAMILIES);
// A title is at most 200 characters with no markup or control characters.
const TITLE_OK = /^[^<>\u0000-\u001f]{1,200}$/;
const BUILD_RE = /(?:^|[\s(])(\d{8}\.\d{1,3})(?=$|[\s)])/;

/**
 * Parse a post title and its tags; null when it is not a SteamOS release. The channel comes
 * from the tags, else from the words in the title. A build on the stable channel is released,
 * so `stablechannel` (or the word Stable) decides first, even when Valve also tags the post
 * for the beta and preview channels it rolls out to. Otherwise `betachannel`,
 * `previewchannel` or the words Beta and Preview mean a beta. A post that names no channel is
 * skipped rather than guessed. Checked against the 25 real SteamOS posts of the 2026-10-12
 * probe (ADR 0006): Valve tags a stable build `stablechannel`, and sometimes also
 * `betachannel` and `previewchannel`; a beta carries both; a preview only `previewchannel`.
 */
export function parseTitle(title, tags = []) {
  if (typeof title !== 'string') return null;
  const text = title.trim();
  if (!TITLE_OK.test(text)) return null;
  const m = TITLE_RE.exec(text);
  if (!m) return null;
  const set = new Set((Array.isArray(tags) ? tags : []).filter((t) => typeof t === 'string'));
  const words = text.toLowerCase();
  let stage = null;
  if (set.has('stablechannel')) stage = 'release';
  else if (set.has('betachannel') || set.has('previewchannel')) stage = 'beta';
  else if (/\bstable\b/.test(words)) stage = 'release';
  else if (/\b(beta|preview)\b/.test(words)) stage = 'beta';
  if (!stage) return null;
  const build = BUILD_RE.exec(text);
  return {
    vendor: VENDOR,
    family: FAMILIES.find((name) => name.toLowerCase() === m[1].toLowerCase()),
    version: m[2],
    major: Number(m[2].split('.')[0]),
    stage,
    beta: null,
    build: build ? build[1] : '',
  };
}

/** A release's id: the news page plus the title as a slug, the same for the same post whichever
 * document it came from (the snapshot rows are made from titles alone, without a gid). */
function idOf(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
  return `${NEWS_PAGE}#${slug}`;
}

// A post's link rebuilt from its host and path: no credentials, port, query or fragment.
export function linkOf(value) {
  if (typeof value !== 'string' || !LINK_HOSTS.some((host) => isHttpsOn(value, host))) {
    return NEWS_PAGE;
  }
  const url = new URL(value);
  if (url.username || url.password || url.port) return NEWS_PAGE;
  return `https://${url.hostname}${url.pathname}`;
}

// Refuse a post dated far ahead of the clock, then keep what is within the window of the clock
// and of the newest post (the newest always), newest first.
function bounded(releases, now, windowDays) {
  const sorted = mergeReleases(
    [],
    releases.filter((release) => Date.parse(release.date) <= now + MAX_SKEW_MS),
  );
  if (sorted.length === 0) return sorted;
  const span = windowDays * DAY_MS;
  const floor = Math.max(now - span, Date.parse(sorted[0].date) - span);
  return sorted.filter((release, i) => i === 0 || Date.parse(release.date) >= floor);
}

/**
 * Releases in a GetNewsForApp JSON document, newest first; [] for anything unreadable. `now`
 * and `windowDays` are for tests: the registered parse() passes neither.
 */
export function parseNews(jsonText, now = Date.now(), windowDays = WINDOW_DAYS) {
  let doc;
  try {
    doc = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const items = doc?.appnews?.newsitems;
  if (!Array.isArray(items)) return [];
  const releases = [];
  for (const item of items.slice(0, MAX_ITEMS)) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.title !== 'string') continue;
    const title = item.title.trim();
    const parsed = parseTitle(title, item.tags);
    const seconds = item.date;
    if (!parsed) continue;
    if (!Number.isSafeInteger(seconds) || seconds <= 0) continue;
    const time = new Date(seconds * 1000);
    if (!Number.isFinite(time.getTime())) continue;
    releases.push({
      id: idOf(title),
      ...parsed,
      title,
      date: time.toISOString().replace('.000Z', 'Z'),
      url: linkOf(item.url),
      source: ID,
    });
  }
  return bounded(releases, now, windowDays);
}

/** Releases in the RSS form of the same news; it carries no tags, so only the title decides. */
export function parseFeed(xmlText, now = Date.now(), windowDays = WINDOW_DAYS) {
  const releases = [];
  for (const item of rssItems(xmlText).slice(0, MAX_ITEMS)) {
    const title = field(item, 'title');
    const parsed = parseTitle(title);
    const link = field(item, 'link');
    const date = parseDate(field(item, 'pubDate'));
    if (!parsed || !date) continue;
    releases.push({ id: idOf(title), ...parsed, title, date, url: linkOf(link), source: ID });
  }
  return bounded(releases, now, windowDays);
}

/**
 * The registered parser: the news JSON only. Anything else, the RSS form included, gives [];
 * the RSS item scanner is not bounded, and the RSS URL is not on the allowlist. The url the
 * Worker passes is ignored; `now` is for tests and defaults to the real clock.
 */
export function parse(text, _url, now = Date.now()) {
  const body = String(text ?? '').trimStart();
  return body.startsWith('{') ? parseNews(body, now) : [];
}

export default {
  id: ID,
  vendor: VENDOR,
  urls: [NEWS_URL],
  parse,
};
