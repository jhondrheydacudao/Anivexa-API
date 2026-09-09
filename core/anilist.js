// src/core/anilist.js
const __name = (fn, _) => fn;

var resolved = new Map();
var inflight = new Map();
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
var ARM = "https://arm.haglund.dev/api/v2/ids";
var JIKAN = "https://api.jikan.moe/v4";
var MAL_API = "https://api.myanimelist.net/v2";
var MAL_CLIENT_ID = process.env.MAL_CLIENT_ID ?? null;
var ANIKOTO = "https://anikoto.wispbyte.app";
var DEFAULT_TIMEOUT_MS = 5000;

var STATUS_MAP = {
  "Currently Airing": "RELEASING",
  "Finished Airing": "FINISHED",
  "Not yet aired": "NOT_YET_RELEASED",
  "On Hiatus": "HIATUS"
};

var MAL_V2_STATUS_MAP = {
  currently_airing: "RELEASING",
  finished_airing: "FINISHED",
  not_yet_aired: "NOT_YET_RELEASED",
};

var AL_STATUS_MAP = {
  RELEASING: "RELEASING",
  FINISHED: "FINISHED",
  NOT_YET_RELEASED: "NOT_YET_RELEASED",
  CANCELLED: "FINISHED",
  HIATUS: "HIATUS",
};

// Wraps fetch with an abort-based timeout. Returns null on timeout/network error — never throws.
async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
__name(fetchWithTimeout, "fetchWithTimeout");

// Plain GET + parse-JSON helper, for REST endpoints (ARM, Jikan, MAL v2, Anikoto).
async function fetchJSON(url, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const res = await fetchWithTimeout(url, { method: "GET", headers }, timeoutMs);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (error) {
    console.error("Fetch error:", error);
    return null;
  }
}
__name(fetchJSON, "fetchJSON");

// POST + GraphQL helper, for AniList.
async function fetchGraphQL(url, query, variables = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
      body: JSON.stringify({ query, variables })
    }, timeoutMs);
    if (!res || !res.ok) {
      console.error("Fetch error:", res?.status);
      return null;
    }
    const json = await res.json();
    if (json.errors) {
      console.error(json.errors);
      return null;
    }
    return json.data?.Media ?? null;
  } catch (error) {
    console.error("Fetch error:", error);
    return null;
  }
}
__name(fetchGraphQL, "fetchGraphQL");

async function fetchFromAniList(id) {
  const query = `query($id:Int){Media(id:$id,type:ANIME){id idMal title{english romaji native} status format episodes seasonYear startDate{year} synonyms nextAiringEpisode{episode airingAt timeUntilAiring}}}`;
  const media = await fetchGraphQL("https://graphql.anilist.co", query, { id });
  if (!media) return null;
  return { ...media, status: AL_STATUS_MAP[media.status] ?? media.status };
}
__name(fetchFromAniList, "fetchFromAniList");

async function fetchFromARM(id) {
  const data = await fetchJSON(`${ARM}/id/${id}`, { Accept: "application/json", "User-Agent": UA });
  if (!data) return null;
  // ARM only maps IDs across services — no title/status/episode info to give back.
  return { id: data.anilist ?? id, idMal: data.myanimelist ?? null, title: null, status: null, format: null, episodes: null, seasonYear: null, startDate: null, nextAiringEpisode: null, synonyms: [] };
}
__name(fetchFromARM, "fetchFromARM");

async function fetchFromJikan(id) {
  const json = await fetchJSON(`${JIKAN}/anime/${id}`, { Accept: "application/json", "User-Agent": UA });
  const data = json?.data;
  if (!data) return null;
  return {
    id,
    idMal: data.mal_id ?? id,
    title: { english: data.title_english ?? null, romaji: data.title ?? null, native: data.title_japanese ?? null },
    status: STATUS_MAP[data.status] ?? data.status ?? null,
    format: data.type ?? null,
    episodes: data.episodes ?? null,
    seasonYear: data.year ?? data.aired?.prop?.from?.year ?? null,
    startDate: data.aired?.prop?.from?.year ? { year: data.aired.prop.from.year } : null,
    nextAiringEpisode: null,
    synonyms: data.title_synonyms ?? []
  };
}
__name(fetchFromJikan, "fetchFromJikan");

async function fetchFromMALv2(malId) {
  if (!MAL_CLIENT_ID || !malId) return null;
  const fields = "id,title,alternative_titles,status,media_type,num_episodes,start_date,start_season";
  const data = await fetchJSON(`${MAL_API}/anime/${malId}?fields=${fields}`, { "X-MAL-CLIENT-ID": MAL_CLIENT_ID, Accept: "application/json", "User-Agent": UA });
  if (!data) return null;
  return {
    id: null,
    idMal: data.id ?? malId,
    title: { english: data.alternative_titles?.en || null, romaji: data.title ?? null, native: data.alternative_titles?.ja || null },
    status: MAL_V2_STATUS_MAP[data.status] ?? data.status ?? null,
    format: data.media_type ?? null,
    episodes: data.num_episodes ?? null,
    seasonYear: data.start_season?.year ?? null,
    startDate: data.start_date ? { year: Number(data.start_date.slice(0, 4)) } : null,
    nextAiringEpisode: null,
    synonyms: data.alternative_titles?.synonyms ?? []
  };
}
__name(fetchFromMALv2, "fetchFromMALv2");

// Turns a title into the kind of slug anikoto expects (e.g. "One Piece" -> "one-piece").
// Best-effort only — real anikoto slugs sometimes carry extra suffixes that can't be
// derived from the title alone.
function slugify(title) {
  if (!title) return null;
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}
__name(slugify, "slugify");

async function fetchFromAnikoto(name) {
  if (!name) return null;
  const slug = slugify(name);
  if (!slug) return null;

  const pageRes = await fetchWithTimeout(`${ANIKOTO}/page?name=${encodeURIComponent(slug)}`, { headers: { Accept: "application/json", "User-Agent": UA } });
  if (!pageRes || !pageRes.ok) return null;

  const pageText = await pageRes.text();
  const dataId = pageText.trim().replace(/^"(.*)"$/, "$1");
  if (!dataId) return null;

  const epRes = await fetchWithTimeout(`${ANIKOTO}/episodes?id=${encodeURIComponent(dataId)}`, { headers: { Accept: "application/json", "User-Agent": UA } });
  if (!epRes || !epRes.ok) return null;

  const epData = await epRes.json();
  return {
    id: null, idMal: null, idAnikoto: dataId,
    title: { english: null, romaji: name, native: null },
    status: "RELEASING", format: null,
    episodes: Array.isArray(epData) ? epData.length : null,
    seasonYear: null, startDate: null, nextAiringEpisode: null, synonyms: []
  };
}
__name(fetchFromAnikoto, "fetchFromAnikoto");

async function getMedia(anilistId, options = {}) {
  const anikotoName = options.anikotoName ?? null;
  const id = Number(anilistId);
  if (resolved.has(id)) return resolved.get(id);
  if (inflight.has(id)) return inflight.get(id);

  const promise = (async () => {
    let data = await fetchFromAniList(id);
    let malId = data?.idMal ?? null;

    if (!data) {
      data = await fetchFromARM(id);
      malId = data?.idMal ?? malId;
    }
    if (!data) {
      data = await fetchFromJikan(id);
      malId = data?.idMal ?? malId;
    }
    if (!data && MAL_CLIENT_ID) {
      data = await fetchFromMALv2(malId ?? id);
    }
    if (!data) {
      data = await fetchFromAnikoto(anikotoName);
    }
    if (!data) throw new Error(`No data found for AniList ID ${id}`);

    resolved.set(id, data);
    inflight.delete(id);
    return data;
  })().catch((e) => {
    inflight.delete(id);
    console.error("Error fetching media:", e);
    throw e;
  });

  inflight.set(id, promise);
  return promise;
}
__name(getMedia, "getMedia");

function forgetMedia(anilistId) {
  const id = Number(anilistId);
  resolved.delete(id);
  inflight.delete(id);
}
__name(forgetMedia, "forgetMedia");

export { getMedia, forgetMedia };
