const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const API_BASE = "https://api.thirai.uk";
const CACHE_BASE = "https://thirai.uk/cache";

const LANGUAGES = [
  { id: "tamil",     name: "Tamil" },
  { id: "hindi",     name: "Hindi" },
  { id: "telugu",    name: "Telugu" },
  { id: "malayalam", name: "Malayalam" },
  { id: "kannada",   name: "Kannada" },
  { id: "punjabi",   name: "Punjabi" },
  { id: "bengali",   name: "Bengali" },
  { id: "marathi",   name: "Marathi" },
];

const catalogs = [];
for (const lang of LANGUAGES) {
  catalogs.push({
    type: "movie",
    id: `thirai-popular-${lang.id}`,
    name: `Thirai - Popular ${lang.name}`,
    extra: [{ name: "skip", isRequired: false }],
  });

  // Skip recent catalog for Tamil
  if (lang.id !== "tamil") {
    catalogs.push({
      type: "movie",
      id: `thirai-recent-${lang.id}`,
      name: `Thirai - Recent ${lang.name}`,
      extra: [
        { name: "skip", isRequired: false },
      ],
      isInSearch: false,
    });
  }

  catalogs.push({
    type: "movie",
    id: `thirai-search-${lang.id}`,
    name: `Thirai - ${lang.name}`,
    extra: [
      { name: "search", isRequired: true },
      { name: "skip", isRequired: false },
    ],
  });
}

const manifest = {
  id: "me.thirai.stremio",
  version: "1.1.0",
  name: "Thirai",
  description: "South Asian Media Extention from thirai.uk",
  logo: "http://thirai.uk/static/favicon.png",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  catalogs,
  behaviorHints: { adult: false, p2p: false },
  idPrefixes: ["thirai:"],
};

const builder = new addonBuilder(manifest);

// ── helpers ───────────────────────────────────────────────────────────────────

function pageFromSkip(skip) {
  const s = parseInt(skip || "0", 10);
  // Each "page" in Stremio terms is 2 API pages worth (60 items)
  return Math.floor(s / 60) * 2 + 1;
}

function movieToMeta(movie) {
  const id = "thirai:" + Buffer.from(movie.page_url).toString("base64url");
  return {
    id,
    type: "movie",
    name: movie.title,
    poster: movie.img_url || undefined,
    description: movie.description || undefined,
    genre: movie.quality ? [movie.quality] : undefined,
  };
}

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

async function cacheFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Cache fetch failed ${res.status}: ${url}`);
  return res.json();
}

// Fetch two consecutive API pages in parallel and return combined movies
async function apiFetchTwoPages(pathTemplate, page) {
  const [data1, data2] = await Promise.allSettled([
    apiFetch(pathTemplate(page)),
    apiFetch(pathTemplate(page + 1)),
  ]);
  const movies1 = data1.status === "fulfilled" ? (data1.value.movies || []) : [];
  const movies2 = data2.status === "fulfilled" ? (data2.value.movies || []) : [];
  return [...movies1, ...movies2];
}

function extractImdbId(imdbUrl) {
  if (!imdbUrl) return null;
  const match = imdbUrl.match(/tt\d+/);
  return match ? match[0] : null;
}

async function fetchCinemeta(imdbId) {
  const res = await fetch(`https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.meta || null;
}

// ── catalog handler ───────────────────────────────────────────────────────────

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== "movie") return { metas: [] };

  const skip = extra && extra.skip ? extra.skip : "0";
  const page = pageFromSkip(skip);

  // Search — fetch 2 pages at a time
  if (id.startsWith("thirai-search-")) {
    const lang = id.replace("thirai-search-", "");
    const q = extra && extra.search ? extra.search : "";
    if (!q) return { metas: [] };
    const movies = await apiFetchTwoPages(
      (p) => `/search/${lang}?q=${encodeURIComponent(q)}&page=${p}`,
      page
    );
    return { metas: movies.map(movieToMeta) };
  }

  // Popular — use cache JSON for page 1 (all movies), fall back to API (2 pages) for subsequent
  if (id.startsWith("thirai-popular-")) {
    const lang = id.replace("thirai-popular-", "");
    if (page === 1) {
      try {
        const data = await cacheFetch(`${CACHE_BASE}/${lang}popular.json`);
        // Return all cached movies, no slice
        return { metas: (data.movies || []).map(movieToMeta) };
      } catch (e) {
        console.warn(`Cache miss for ${lang}popular.json, falling back to API:`, e.message);
      }
    }
    const movies = await apiFetchTwoPages(
      (p) => `/language/${lang}?category=popular&page=${p}`,
      page
    );
    return { metas: movies.map(movieToMeta) };
  }

  // Recent — fetch 2 API pages at a time
  if (id.startsWith("thirai-recent-")) {
    const lang = id.replace("thirai-recent-", "");
    const movies = await apiFetchTwoPages(
      (p) => `/language/${lang}?category=recent&page=${p}`,
      page
    );
    return { metas: movies.map(movieToMeta) };
  }

  return { metas: [] };
});

// ── meta handler ──────────────────────────────────────────────────────────────

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== "movie" || !id.startsWith("thirai:")) return { meta: null };

  const pageUrl = Buffer.from(id.replace("thirai:", ""), "base64url").toString("utf8");

  try {
    const data = await apiFetch(`/watch?url=${encodeURIComponent(pageUrl)}`);

    // Quality + language tags — always shown regardless of metadata source
    const qualityTags = [
      ...(data.has_uhd ? ["UHD"] : []),
      ...(data.has_hd ? ["HD"] : []),
      ...(data.has_sd ? ["SD"] : []),
      ...(data.has_subtitle ? ["Subtitles"] : []),
      ...(data.language ? [data.language] : []),
    ];

    // Only attach trailers when a URL is actually present — omitting it
    // hides the Trailer button in Stremio entirely
    const trailers = data.trailer_url && data.trailer_url.trim()
      ? [{ source: data.trailer_url, type: "Trailer" }]
      : undefined;

    // ── Try Cinemeta via IMDb ID ──────────────────────────────────────────────
    const imdbId = extractImdbId(data.imdb_url);
    const cinemeta = imdbId ? await fetchCinemeta(imdbId).catch(() => null) : null;

    let meta;

    if (cinemeta) {
      meta = {
        // Keep our thirai: id so stream handler still works
        id,
        type: "movie",
        imdb_id: imdbId,
        name: cinemeta.name || data.title,
        // Prefer Thirai poster (region-specific art), fall back to Cinemeta
        poster: data.img_url || cinemeta.poster,
        background: cinemeta.background || cinemeta.poster || data.img_url,
        logo: cinemeta.logo,
        description: cinemeta.description || data.description,
        year: cinemeta.year,
        imdbRating: cinemeta.imdbRating,
        runtime: cinemeta.runtime,
        country: cinemeta.country,
        director: cinemeta.director,
        cast: cinemeta.cast,
        awards: cinemeta.awards,
        // Merge Cinemeta genres with quality tags so pills still show UHD/HD/etc.
        genre: [...(cinemeta.genre || []), ...qualityTags],
        links: [
          ...(cinemeta.links || []),
          // Ensure our IMDb link is always present
          { name: "IMDb", category: "imdb", url: data.imdb_url },
        ],
      };
    } else {
      // ── Fallback: Thirai API only ─────────────────────────────────────────
      const ratingValues = data.ratings ? Object.values(data.ratings) : [];
      const avgRating = ratingValues.length
        ? ((ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length) * (10 / 3)).toFixed(1)
        : undefined;

      // Cast list: "Name (Role)" for actors, plain name for crew
      const castList = data.cast
        ? data.cast.map((c) => (c.role ? `${c.name} (${c.role})` : c.name))
        : undefined;

      meta = {
        id,
        type: "movie",
        name: data.title,
        poster: data.img_url || undefined,
        background: data.img_url || undefined,
        description: data.description || undefined,
        year: data.year ? parseInt(data.year, 10) || undefined : undefined,
        imdbRating: avgRating,
        cast: castList,
        genre: qualityTags,
        links: data.imdb_url
          ? [{ name: "IMDb", category: "imdb", url: data.imdb_url }]
          : undefined,
      };
    }

    if (trailers) meta.trailers = trailers;
    return { meta };

  } catch (e) {
    console.error("meta error", e.message);
    return { meta: null };
  }
});

// ── stream handler ────────────────────────────────────────────────────────────

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== "movie" || !id.startsWith("thirai:")) return { streams: [] };

  const pageUrl = Buffer.from(id.replace("thirai:", ""), "base64url").toString("utf8");

  try {
    const data = await apiFetch(`/watch?url=${encodeURIComponent(pageUrl)}`);
    const streams = [];

    if (data.uhd_url) {
      streams.push({
        url: `${API_BASE}/proxy?url=${encodeURIComponent(data.uhd_url)}`,
        name: "Thirai",
        description: "UHD",
        behaviorHints: { notWebReady: false },
      });
    }

    if (data.video_url) {
      const quality = data.has_hd ? "HD" : "SD";
      streams.push({
        url: `${API_BASE}/proxy?url=${encodeURIComponent(data.video_url)}`,
        name: "Thirai",
        description: quality,
        behaviorHints: { notWebReady: false },
      });
    }

    return { streams };
  } catch (e) {
    console.error("stream error", e.message);
    return { streams: [] };
  }
});

// ── serve ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Thirai Stremio Addon running on http://localhost:${PORT}/manifest.json`);