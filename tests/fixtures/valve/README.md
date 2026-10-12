# Valve fixtures

- `getnewsforapp.json` and `news.rss` are the first items the read-only source probe of
  2026-10-12 recorded for the Steam Deck news (app 1675200). They hold only Steam Client updates,
  which the adapter skips.
- `getnewsforapp-steamos-titles.json` is built from the `title_matches` block the probe recorded
  for `GetNewsForApp/v2/?appid=1675200&count=100&maxlength=1`: the 19 complete SteamOS posts of
  the 25 it matched (the probe cut its excerpt at 4,000 characters part-way through the 20th, so
  that one and the five after it are left out). Titles, unix dates and tags are copied as
  recorded, including the moderation tags some posts carry. The JSON shape is the API's
  (`appnews.newsitems`).
- The probe recorded no `gid`, `url` or `feedname` for those posts, so the fixture has none and
  none were invented. The adapter does not depend on a `gid`: a release's id comes from its
  title, and its link falls back to the news page (`NEWS_PAGE`) when the post has no link on
  a Steam host.
