const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");

const API_BASE = "https://api.thirai.uk";
const CACHE_BASE = "https://thirai.uk/cache";
const ACCOUNT_SERVER = "https://account.thirai.uk";

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

const catalogs = [
  {
    type: "movie",
    id: "thirai-continue-watching",
    name: "Thirai - Continue Watching",
    extra: [{ name: "skip", isRequired: false }],
  },
];
for (const lang of LANGUAGES) {
  catalogs.push({
    type: "movie",
    id: `thirai-popular-${lang.id}`,
    name: `Thirai - Popular ${lang.name}`,
    extra: [{ name: "skip", isRequired: false }],
  });

  if (lang.id !== "tamil") {
    catalogs.push({
      type: "movie",
      id: `thirai-recent-${lang.id}`,
      name: `Thirai - Recent ${lang.name}`,
      extra: [{ name: "skip", isRequired: false }],
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
  description: "South Asian Media — thirai.uk",
  logo: "http://thirai.uk/static/favicon.png",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  catalogs,
  // Tells the SDK to add /:config? prefix to all routes and show Configure button
  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: true,
    configurationRequired: true,
  },
  // config schema — SDK uses this to render a default form, but we override
  // the /configure page entirely with our own HTML below
  config: [
    {
      key: "token",
      type: "text",
      title: "Account Token",
      required: true,
    },
  ],
  idPrefixes: ["thirai:"],
};

const builder = new addonBuilder(manifest);

// ── helpers ───────────────────────────────────────────────────────────────────

function pageFromSkip(skip) {
  const s = parseInt(skip || "0", 10);
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

// apiFetch — optionally forward a session token so /watch can auth + track
async function apiFetch(path, token) {
  const headers = {};
  if (token) headers["X-Token"] = token;
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch (_) {}
    throw new Error(`API ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function cacheFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Cache fetch failed ${res.status}: ${url}`);
  return res.json();
}

async function apiFetchTwoPages(pathTemplate, page, token) {
  const [data1, data2] = await Promise.allSettled([
    apiFetch(pathTemplate(page), token),
    apiFetch(pathTemplate(page + 1), token),
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

// Extract session token from the config object the SDK passes into every handler.
// The install URL is:  stremio://host/{"token":"TOK"}/manifest.json
// The SDK JSON-parses that segment and passes it as `config`.
function tokenFromConfig(config) {
  if (!config) return null;
  if (typeof config === "object") return config.token || null;
  return null;
}

// ── catalog handler ───────────────────────────────────────────────────────────

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
  if (type !== "movie") return { metas: [] };

  const token = tokenFromConfig(config);
  const skip = extra && extra.skip ? extra.skip : "0";
  const page = pageFromSkip(skip);

  if (id.startsWith("thirai-search-")) {
    const lang = id.replace("thirai-search-", "");
    const q = extra && extra.search ? extra.search : "";
    if (!q) return { metas: [] };
    const movies = await apiFetchTwoPages(
      (p) => `/search/${lang}?q=${encodeURIComponent(q)}&page=${p}`,
      page,
      token
    );
    return { metas: movies.map(movieToMeta) };
  }

  if (id === "thirai-continue-watching") {
    console.log("[CW catalog] token present:", !!token);
    if (!token) return { metas: [] };
    try {
      const res = await fetch(`${ACCOUNT_SERVER}/history`, {
        headers: { "X-Token": token },
      });
      console.log("[CW catalog] /history status:", res.status);
      if (!res.ok) return { metas: [] };
      const items = await res.json(); // plain array
      const list = Array.isArray(items) ? items : [];
      console.log("[CW catalog] items count:", list.length);
      console.log("[CW catalog] sample URLs:", list.slice(0, 5).map(i => i && (i.url || i.link)));
      console.log("[CW catalog] sample keys:", list.slice(0, 3).map(i => i && Object.keys(i)));
      console.log("[CW catalog] first item full:", JSON.stringify(list[0]));

      function normaliseUrl(url) {
        if (!url) return null;
        // Already a full einthusan URL
        if (url.includes('einthusan.tv')) return url;
        // Already a thirai.uk URL — pass as-is
        if (url.includes('thirai.uk')) return url;
        // Convert relative ./watch?film=X → https://einthusan.tv/movie/watch/X/
        const film = url.match(/[?&]film=([^&]+)/);
        if (film) return `https://einthusan.tv/movie/watch/${film[1]}/`;
        return null;
      }

      // Convert all URLs to thirai.uk format, skip anything unrecognised
      const metas = list
        .map(i => {
          if (!i) return null;
          const rawUrl = i.url || i.link;
          const pageUrl = normaliseUrl(rawUrl);
          if (!pageUrl) return null;
          const id = "thirai:" + Buffer.from(pageUrl).toString("base64url");
          return {
            id,
            type: "movie",
            name: i.title || "Unknown",
            poster: i.img || i.img_url || undefined,
          };
        })
        .filter(Boolean);
      return { metas, cacheMaxAge: 0 };
    } catch (e) {
      console.warn("[CW catalog] error:", e.message);
      return { metas: [] };
    }
  }

  if (id.startsWith("thirai-popular-")) {
    const lang = id.replace("thirai-popular-", "");
    if (page === 1) {
      try {
        const data = await cacheFetch(`${CACHE_BASE}/${lang}popular.json`);
        return { metas: (data.movies || []).map(movieToMeta) };
      } catch (e) {
        console.warn(`Cache miss for ${lang}popular.json, falling back to API:`, e.message);
      }
    }
    const movies = await apiFetchTwoPages(
      (p) => `/language/${lang}?category=popular&page=${p}`,
      page,
      token
    );
    return { metas: movies.map(movieToMeta) };
  }

  if (id.startsWith("thirai-recent-")) {
    const lang = id.replace("thirai-recent-", "");
    const movies = await apiFetchTwoPages(
      (p) => `/language/${lang}?category=recent&page=${p}`,
      page,
      token
    );
    return { metas: movies.map(movieToMeta) };
  }

  return { metas: [] };
});

// ── meta handler ──────────────────────────────────────────────────────────────

builder.defineMetaHandler(async ({ type, id, config }) => {
  if (type !== "movie" || !id.startsWith("thirai:")) return { meta: null };

  const token = tokenFromConfig(config);
  const pageUrl = Buffer.from(id.replace("thirai:", ""), "base64url").toString("utf8");

  // /watch requires auth — if we have no token, return a minimal meta built
  // purely from the data we already encoded in the ID (page URL) so Stremio
  // at least shows something rather than a blank card or an error.
  if (!token) {
    console.warn("meta handler: no token in config, returning minimal meta for", pageUrl);
    return {
      meta: {
        id,
        type: "movie",
        name: decodeURIComponent(pageUrl.split("/").filter(Boolean).pop() || "Unknown"),
        description: "Sign in via the addon configure page to load full details.",
      },
    };
  }

  try {
    // Metadata preview — no ?track=1, just needs auth to reach the endpoint
    const data = await apiFetch(`/watch?url=${encodeURIComponent(pageUrl)}`, token);

    const qualityTags = [
      ...(data.has_uhd ? ["UHD"] : []),
      ...(data.has_hd ? ["HD"] : []),
      ...(data.has_sd ? ["SD"] : []),
      ...(data.has_subtitle ? ["Subtitles"] : []),
      ...(data.language ? [data.language] : []),
    ];

    const trailers = data.trailer_url && data.trailer_url.trim()
      ? [{ source: data.trailer_url, type: "Trailer" }]
      : undefined;

    const imdbId = extractImdbId(data.imdb_url);
    const cinemeta = imdbId ? await fetchCinemeta(imdbId).catch(() => null) : null;

    let meta;

    if (cinemeta) {
      meta = {
        id,
        type: "movie",
        imdb_id: imdbId,
        name: cinemeta.name || data.title,
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
        genre: [...(cinemeta.genre || []), ...qualityTags],
        links: [
          ...(cinemeta.links || []),
          { name: "IMDb", category: "imdb", url: data.imdb_url },
        ],
      };
    } else {
      const ratingValues = data.ratings ? Object.values(data.ratings) : [];
      const avgRating = ratingValues.length
        ? ((ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length) * (10 / 3)).toFixed(1)
        : undefined;

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
    // Only log non-500s as errors; 500s are backend scraping failures on specific films
    if (!e.message.includes("API 500")) {
      console.error("meta error", e.message);
    }
    // Return minimal meta so the card still renders rather than going blank
    return {
      meta: {
        id,
        type: "movie",
        name: decodeURIComponent(pageUrl.split(/[?&]/).find(p => p.startsWith("film="))?.replace("film=", "") || pageUrl.split("/").filter(Boolean).pop() || "Unknown"),
        description: "Unable to load details for this title.",
      },
    };
  }
});

// ── stream handler ────────────────────────────────────────────────────────────

builder.defineStreamHandler(async ({ type, id, config }) => {
  if (type !== "movie" || !id.startsWith("thirai:")) return { streams: [] };

  const token = tokenFromConfig(config);
  if (!token) {
    console.warn("stream handler: no token in config, cannot auth");
    return { streams: [] };
  }

  const pageUrl = Buffer.from(id.replace("thirai:", ""), "base64url").toString("utf8");

  // Block unknown external URLs the API can't handle
  if (!pageUrl.includes("thirai.uk") && !pageUrl.includes("einthusan.tv") && !pageUrl.startsWith("./watch")) {
    return { streams: [] };
  }

  try {
    const MAX_RETRIES = 3;
    let streams = [];

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await apiFetch(
          `/watch?url=${encodeURIComponent(pageUrl)}&track=1`,
          token
        );

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

        if (streams.length > 0) break; // got at least one stream, stop retrying
        console.warn(`stream attempt ${attempt}/${MAX_RETRIES} returned no streams, retrying...`);
      } catch (e) {
        console.warn(`stream attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}`);
        if (attempt === MAX_RETRIES) throw e;
      }

      // wait 1s before retrying
      await new Promise(r => setTimeout(r, 1000));
    }

    return { streams };
  } catch (e) {
    console.error("stream error", e.message);
    return { streams: [] };
  }
});

// ── configure page ────────────────────────────────────────────────────────────
// Shown when the user clicks "Configure" in Stremio before installing.
// They enter their PIN → we verify it → get a token → build the install URL
// with the token baked in as the /:config? path segment.

const CONFIGURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>Thirai · Stremio</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; outline: none; -webkit-tap-highlight-color: transparent; }

    body {
      font-family: 'Inter', sans-serif;
      background: #080808;
      color: #fff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }

    /* ── Logo above card ── */
    .thirai-logo {
      height: 28px;
      margin-bottom: 28px;
      display: block;
    }

    /* ── Modal card ── */
    .modal {
      width: 100%;
      max-width: 340px;
      background: #141414;
      border-radius: 20px;
      padding: 2rem 1.75rem 1.75rem;
      text-align: center;
      position: relative;
    }

    /* ── Avatar icon ── */
    .avatar {
      width: 64px;
      height: 64px;
      background: #222;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.1rem;
      font-size: 1.7rem;
      color: rgba(255,255,255,0.55);
    }

    .modal h1 {
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.01em;
    }

    .modal .sub {
      margin-top: 0.3rem;
      font-size: 0.82rem;
      color: rgba(255,255,255,0.45);
    }

    /* ── PIN boxes ── */
    .pin-row {
      display: flex;
      justify-content: center;
      gap: 8px;
      margin: 1.6rem 0 0;
    }

    .pin-box {
      width: 42px;
      height: 50px;
      background: #222;
      border: 1.5px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      color: #fff;
      font-size: 1.2rem;
      font-family: 'Inter', sans-serif;
      font-weight: 600;
      text-align: center;
      caret-color: #fff;
      transition: border-color 0.15s, background 0.15s;
    }
    .pin-box:focus {
      border-color: rgba(255,255,255,0.35);
      background: #2a2a2a;
    }
    .pin-box.filled {
      border-color: rgba(255,255,255,0.2);
    }

    /* ── Message ── */
    .msg {
      min-height: 1.1em;
      font-size: 0.78rem;
      color: rgba(255,255,255,0.4);
      margin-top: 0.75rem;
    }
    .msg.error { color: #e50914; }
    .msg.ok    { color: #4caf50; }

    /* ── Verify button ── */
    .btn-verify {
      margin-top: 1rem;
      width: 100%;
      height: 48px;
      background: #fff;
      color: #000;
      font-weight: 700;
      font-size: 0.95rem;
      font-family: 'Inter', sans-serif;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: background 0.15s, opacity 0.15s;
    }
    .btn-verify:hover:not(:disabled) { background: #e0e0e0; }
    .btn-verify:disabled { opacity: 0.4; cursor: not-allowed; }

    /* ── Install button (shown after verify) ── */
    .install-wrap { margin-top: 0.75rem; display: none; }
    .btn-install {
      width: 100%;
      height: 48px;
      background: #e50914;
      color: #fff;
      font-weight: 700;
      font-size: 0.95rem;
      font-family: 'Inter', sans-serif;
      border-radius: 12px;
      text-decoration: none;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: background 0.15s;
    }
    .btn-install:hover { background: #c8070f; }

    /* ── Divider ── */
    .or-divider {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 1.25rem 0 1rem;
      color: rgba(255,255,255,0.25);
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .or-divider::before,
    .or-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: rgba(255,255,255,0.1);
    }

    /* ── Request Access button ── */
    .btn-request {
      width: 100%;
      height: 48px;
      background: #1e1e1e;
      color: rgba(255,255,255,0.75);
      font-weight: 600;
      font-size: 0.92rem;
      font-family: 'Inter', sans-serif;
      border: 1.5px solid rgba(255,255,255,0.1);
      border-radius: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      text-decoration: none;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .btn-request:hover {
      background: #252525;
      border-color: rgba(255,255,255,0.18);
      color: #fff;
    }
  </style>
</head>
<body>

  <img class="thirai-logo" src="https://thirai.uk/static/thiraiwhite.png" alt="Thirai" />

  <div class="modal">

    <div class="avatar">
      <i class="fas fa-user"></i>
    </div>

    <h1>Sign In</h1>
    <p class="sub">Enter your 6-digit PIN</p>

    <div class="pin-row" id="pin-row">
      <input class="pin-box" type="text" inputmode="numeric" maxlength="1" autocomplete="off" />
      <input class="pin-box" type="text" inputmode="numeric" maxlength="1" autocomplete="off" />
      <input class="pin-box" type="text" inputmode="numeric" maxlength="1" autocomplete="off" />
      <input class="pin-box" type="text" inputmode="numeric" maxlength="1" autocomplete="off" />
      <input class="pin-box" type="text" inputmode="numeric" maxlength="1" autocomplete="off" />
      <input class="pin-box" type="text" inputmode="numeric" maxlength="1" autocomplete="off" />
    </div>

    <p class="msg" id="msg"></p>

    <button class="btn-verify" id="verify-btn">
      <i class="fas fa-arrow-right-to-bracket"></i> Verify PIN
    </button>

    <div class="install-wrap" id="install-wrap">
      <a class="btn-install" id="install-btn" href="#">
        <i class="fas fa-puzzle-piece"></i> Install in Stremio
      </a>
    </div>

    <div class="or-divider">New here?</div>

    <a class="btn-request" href="https://thirai.uk" target="_blank" rel="noopener">
      <i class="fas fa-user-plus"></i> Request Access
    </a>

  </div>

  <script>
    const boxes   = Array.from(document.querySelectorAll('.pin-box'));
    const verifyBtn = document.getElementById('verify-btn');
    const msgEl     = document.getElementById('msg');
    const installWrap = document.getElementById('install-wrap');
    const installBtn  = document.getElementById('install-btn');

    /* ── PIN box keyboard handling ── */
    boxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        // Keep only last digit typed
        box.value = box.value.replace(/\\D/g, '').slice(-1);
        box.classList.toggle('filled', box.value.length > 0);
        if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      });
      box.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !box.value && i > 0) {
          boxes[i - 1].value = '';
          boxes[i - 1].classList.remove('filled');
          boxes[i - 1].focus();
        }
        if (e.key === 'Enter') verifyBtn.click();
      });
      // Handle paste on any box
      box.addEventListener('paste', e => {
        e.preventDefault();
        const digits = (e.clipboardData.getData('text') || '').replace(/\\D/g, '').slice(0, 6);
        digits.split('').forEach((d, j) => {
          if (boxes[j]) {
            boxes[j].value = d;
            boxes[j].classList.add('filled');
          }
        });
        const next = boxes[Math.min(digits.length, boxes.length - 1)];
        if (next) next.focus();
      });
    });

    function getPin() { return boxes.map(b => b.value).join(''); }

    function showMsg(text, type) {
      msgEl.textContent = text;
      msgEl.className   = 'msg' + (type ? ' ' + type : '');
    }

    /* ── Verify ── */
    verifyBtn.addEventListener('click', async () => {
      const code = getPin();
      if (code.length < 6) { showMsg('Enter all 6 digits', 'error'); return; }
      verifyBtn.disabled = true;
      showMsg('Verifying…', '');
      try {
        const res  = await fetch('/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const data = await res.json();
        if (!data.valid || !data.token) {
          showMsg(data.message || 'Invalid PIN — try again', 'error');
          verifyBtn.disabled = false;
          return;
        }
        const config       = JSON.stringify({ token: data.token });
        const host         = window.location.host;
        const manifestPath = encodeURIComponent(config) + '/manifest.json';
        installBtn.href    = 'stremio://' + host + '/' + manifestPath;
        installWrap.style.display = 'block';
        showMsg('PIN verified! Click below to install.', 'ok');
        verifyBtn.disabled = false;
      } catch (e) {
        showMsg('Could not reach account server', 'error');
        verifyBtn.disabled = false;
      }
    });

    // Focus first box on load
    boxes[0].focus();
  </script>
</body>
</html>`;

// ── serve ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 7000;
const app = express();

// /configure must come BEFORE the SDK router
app.get("/configure", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(CONFIGURE_HTML);
});

app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(CONFIGURE_HTML);
});

// Proxy /verify to the account server so the configure page doesn't hit
// CORS issues when served from localhost. Node fetches server-side, no CORS.
app.post("/verify", express.json(), async (req, res) => {
  try {
    const upstream = await fetch(`${ACCOUNT_SERVER}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ valid: false, message: "Could not reach account server" });
  }
});

// ── continue watching proxy ───────────────────────────────────────────────────
// These proxy to the account/API server so the configure page can display
// and manage the user's continue-watching list without CORS issues.

app.get("/continue", async (req, res) => {
  const token = req.headers["x-token"];
  if (!token) return res.status(401).json({ items: [] });
  try {
    const upstream = await fetch(`${ACCOUNT_SERVER}/history`, {
      headers: { "X-Token": token },
    });
    const data = await upstream.json();
    // account server returns a plain array; wrap it for the configure page
    const items = Array.isArray(data) ? data.map(i => ({
      page_url: i.url || i.link,
      img_url: i.img || i.img_url,
      title: i.title,
      language: i.language,
      quality: i.quality,
      progress: i.progress,
    })) : [];
    res.status(upstream.status).json({ items });
  } catch (e) {
    res.status(502).json({ items: [] });
  }
});

app.post("/continue/remove", express.json(), async (req, res) => {
  const token = req.headers["x-token"];
  if (!token) return res.status(401).json({ ok: false });
  try {
    const upstream = await fetch(`${API_BASE}/continue/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token": token },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ ok: false });
  }
});

app.post("/continue/clear", async (req, res) => {
  const token = req.headers["x-token"];
  if (!token) return res.status(401).json({ ok: false });
  try {
    const upstream = await fetch(`${API_BASE}/continue/clear`, {
      method: "POST",
      headers: { "X-Token": token },
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ ok: false });
  }
});

// SDK handles /manifest.json and /:config/manifest.json, /catalog/*, etc.
app.use(getRouter(builder.getInterface()));

app.listen(PORT, () => {
  console.log(`Thirai Stremio Addon running on http://localhost:${PORT}/manifest.json`);
  console.log(`Configure page:     http://localhost:${PORT}/configure`);
});
