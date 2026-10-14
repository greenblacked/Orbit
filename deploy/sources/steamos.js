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
// Bounds on what is emitted: a post dated more than a day after the clock is refused, and at
// most MAX_ITEMS posts are read. There is no time window (ADR 0007): every SteamOS release the
// news API returns is emitted, newest first. The request asks for the newest 100 Steam posts, so
// how far back that reaches depends on how often Valve posts; the static snapshot keeps what
// older refreshes saw. The dial filters by date on the client, so wider data does not widen it.

import { familyIds } from '../families.js';
import { cleanSummary, field, isHttpsOn, parseDate, rssItems, sortReleases } from '../releases.js';

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

/**
 * The headline words of a post title that follow the release name: "SteamOS 3.7.13 Stable:
 * Deck update" gives "Deck update". The version, the channel words (Stable, Beta, Preview),
 * a build in brackets and the punctuation between them are not a summary, so a title that
 * is only those gives ''. The text is the title Valve wrote, cleaned like any summary.
 */
export function summaryOfTitle(title) {
  const m = TITLE_RE.exec(String(title ?? '').trim());
  if (!m) return '';
  let rest = String(title).trim().slice(m[0].length);
  // Peel separators and builds (bracketed or bare) off the front.
  const peel = (text) => {
    for (;;) {
      const next = text
        .replace(/^[\s:,;\-\u2013\u2014]+/, '')
        .replace(/^\([^)]*\)/, '')
        .replace(/^\d{8}\.\d{1,3}\b/, '');
      if (next === text) return text;
      text = next;
    }
  };
  // One channel word at most, and only straight after the version or its build, so a later
  // "Preview" in the summary itself stays.
  rest = peel(rest).replace(/^(?:stable|beta|preview)\b/i, '');
  rest = peel(rest);
  return cleanSummary(rest);
}

/** The release with the post's headline as its summary, when the title has one. */
function summarised(release) {
  const summary = summaryOfTitle(release.title);
  return summary ? { ...release, summary } : release;
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

// Refuse a post dated far ahead of the clock, newest first.
function bounded(releases, now) {
  return sortReleases(releases.filter((release) => Date.parse(release.date) <= now + MAX_SKEW_MS));
}

/**
 * Releases in a GetNewsForApp JSON document, newest first; [] for anything unreadable. `now`
 * is for tests: the registered parse() does not pass it.
 */
export function parseNews(jsonText, now = Date.now()) {
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
    releases.push(
      summarised({
        id: idOf(title),
        ...parsed,
        title,
        date: time.toISOString().replace('.000Z', 'Z'),
        url: linkOf(item.url),
        source: ID,
      }),
    );
  }
  return bounded(releases, now);
}

/** Releases in the RSS form of the same news; it carries no tags, so only the title decides. */
export function parseFeed(xmlText, now = Date.now()) {
  const releases = [];
  for (const item of rssItems(xmlText).slice(0, MAX_ITEMS)) {
    const title = field(item, 'title');
    const parsed = parseTitle(title);
    const link = field(item, 'link');
    const date = parseDate(field(item, 'pubDate'));
    if (!parsed || !date) continue;
    releases.push(
      summarised({ id: idOf(title), ...parsed, title, date, url: linkOf(link), source: ID }),
    );
  }
  return bounded(releases, now);
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
