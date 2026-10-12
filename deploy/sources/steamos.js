// The Valve adapter: SteamOS (the Steam Deck) from the Steam news of app 1675200.
//
// Valve posts SteamOS releases to the Steam Deck news next to Steam Client updates. Only a
// title that names a SteamOS version is an OS release; "Steam Beta Client Update: ..." and
// the like are skipped. The primary source is the news API (JSON); the same posts are also
// published as RSS (FALLBACK_URL), which parse() reads as well. See ADR 0006 for how both
// were verified.
//
// An adapter is { id, vendor, urls, parse }. `urls` is the allowlist the Worker fetches.
// The RSS feed is not on it: the Worker treats one failing URL as a failed source and
// merges the results of all of them, so a second URL would be a requirement, not a fallback.

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

// "SteamOS 3.7.13", "SteamOS 3.8.1 Preview (20250522.1)", "SteamOS 3.7.13 Stable: Deck update".
// The prefix is strict; the rest of the title is read loosely (see TITLE_OK).
const TITLE_RE = new RegExp(`^(${FAMILIES.join('|')})\\s+(\\d+(?:\\.\\d+){1,3})(?=$|[\\s:,(])`, 'i');
// A title is at most 200 characters with no markup or control characters.
const TITLE_OK = /^[^<>\u0000-\u001f]{1,200}$/;
const BUILD_RE = /(?:^|[\s(])(\d{8}\.\d{1,3})(?=$|[\s)])/;
const GID_RE = /^\d{1,24}$/;

/**
 * Parse a post title and its tags; null when it is not a SteamOS release. The channel comes
 * from the tags, else from the words in the title. A build on the stable channel is released,
 * so `stablechannel` (or the word Stable) decides first, even when Valve also tags the post
 * for the beta and preview channels it rolls out to. Otherwise `betachannel`,
 * `previewchannel` or the words Beta and Preview mean a beta. A post that names no channel is
 * skipped rather than guessed. This rule is unverified against a real SteamOS post (ADR 0006).
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

function linkOf(value) {
  return typeof value === 'string' && LINK_HOSTS.some((host) => isHttpsOn(value, host)) ? value : NEWS_PAGE;
}

/** Releases in a GetNewsForApp JSON document, newest first; [] for anything unreadable. */
export function parseNews(jsonText) {
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
    const gid = typeof item.gid === 'string' ? item.gid : '';
    const seconds = item.date;
    if (!parsed || !GID_RE.test(gid)) continue;
    if (!Number.isSafeInteger(seconds) || seconds <= 0) continue;
    const time = new Date(seconds * 1000);
    if (!Number.isFinite(time.getTime())) continue;
    releases.push({
      id: gid,
      ...parsed,
      title,
      date: time.toISOString().replace('.000Z', 'Z'),
      url: linkOf(item.url),
      source: ID,
    });
  }
  return mergeReleases([], releases);
}

/** Releases in the RSS form of the same news; it carries no tags, so only the title decides. */
export function parseFeed(xmlText) {
  const releases = [];
  for (const item of rssItems(xmlText).slice(0, MAX_ITEMS)) {
    const title = field(item, 'title');
    const parsed = parseTitle(title);
    const link = field(item, 'link');
    const id = field(item, 'guid') || link;
    const date = parseDate(field(item, 'pubDate'));
    if (!parsed || !id || !date) continue;
    releases.push({ id, ...parsed, title, date, url: linkOf(link), source: ID });
  }
  return mergeReleases([], releases);
}

/** Either document: JSON when it starts with a brace, otherwise RSS. */
export function parse(text) {
  const body = String(text ?? '').trimStart();
  return body.startsWith('{') ? parseNews(body) : parseFeed(body);
}

export default {
  id: ID,
  vendor: VENDOR,
  urls: [NEWS_URL],
  parse,
};
