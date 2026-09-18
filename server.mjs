import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";

const execFileAsync = promisify(execFile);

// ── Config ──────────────────────────────────────────────────

const PORT = process.env.PORT || 8083;
const PERXONA_API_BASE_URL = process.env.PERXONA_API_BASE_URL;
// Only the /asia or /eu region segment is read out of PERXONA_API_BASE_URL —
// the host is always the public console, never whatever host
// PERXONA_API_BASE_URL itself points at. GET /api/config is unauthenticated
// (see the "config (unauthenticated)" tests), so forwarding
// PERXONA_API_BASE_URL through verbatim would hand any browser that asks
// whatever host this server happens to be configured against; hard-coding
// the console host and deriving only the region avoids that regardless of
// what PERXONA_API_BASE_URL is set to. Falls back to asia when no
// recognizable region segment is present (e.g. PERXONA_API_BASE_URL unset in
// mock mode) — warned about below so a guessed region is never silent.
const CONSOLE_REGION_MATCH = PERXONA_API_BASE_URL?.match(/\/(asia|eu)(?:\/|$)/);
const CONSOLE_REGION = CONSOLE_REGION_MATCH?.[1] ?? "asia";
const SUBSCRIPTION_URL = `https://console.perxona.ai/${CONSOLE_REGION}/organization/subscription/`;
if (PERXONA_API_BASE_URL && !CONSOLE_REGION_MATCH) {
  console.warn(
    `WARNING: no /asia or /eu segment found in PERXONA_API_BASE_URL, so the subscription-issue console link guesses "${CONSOLE_REGION}".\n` +
      "If this organization is in a different region, point PERXONA_API_BASE_URL at a URL containing that region segment.",
  );
}
const USE_MOCK = process.env.USE_MOCK === "true";
const PRESENTER_URL =
  process.env.PRESENTER_URL ||
  "https://cdn.perxona.ai/prod/latest/widget/entry/presenter.js";
const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();
const LLM_API_KEY = process.env.LLM_API_KEY;
// Vertex AI auth is OAuth2, not a static key: local dev shells out to the
// gcloud CLI (already authenticated on this machine — `gcloud auth list`)
// instead of adding a service-account/google-auth-library dependency for a
// test route. Not meant for a deployment that doesn't have gcloud installed
// and logged in — see the README note near LLM_PROVIDER=vertex.
const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || "us-central1";
// ElevenLabs TTS — opt-in, used by the friend-chat demo's /api/tts route. When
// ELEVENLABS_API_KEY is set the avatar speaks replies with an ElevenLabs voice
// (BYO-TTS through presenter.presentWithAudio()); unset, it falls back to the
// Connect voice via present(). The voice/model defaults are ElevenLabs'
// documented premade values — Rachel and the multilingual model, which keeps
// the "reply in whatever language" behavior working across languages.
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_BASE_URL =
  process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io";
const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Rachel (premade)
// Optional Japanese voice for /api/tts when the request says lang="ja" —
// premade voices are all EN-accented, so a native JA voice (added from the
// ElevenLabs Voice Library) sounds much better in Japanese mode. Falls back
// to ELEVENLABS_VOICE_ID when unset.
const ELEVENLABS_VOICE_ID_JA =
  process.env.ELEVENLABS_VOICE_ID_JA || ELEVENLABS_VOICE_ID;
const ELEVENLABS_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
let vertexTokenCache = { token: null, expiresAt: 0 };
async function getVertexAccessToken() {
  if (vertexTokenCache.token && Date.now() < vertexTokenCache.expiresAt) {
    return vertexTokenCache.token;
  }
  // shell: true — on Windows, gcloud is a .cmd wrapper; execFile only
  // resolves exact executable names on PATH without it (spawn ... ENOENT).
  const { stdout } = await execFileAsync(
    "gcloud",
    ["auth", "print-access-token"],
    { shell: true },
  );
  const token = stdout.trim();
  // Real tokens last ~1h; refresh a few minutes early to avoid a request
  // landing right on the expiry boundary.
  vertexTokenCache = { token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return token;
}
const PRESENTER_TARGET = {
  avatarId: process.env.DEMO_FIXED_AVATAR_ID,
  sceneId: process.env.DEMO_FIXED_SCENE_ID,
  voiceId: process.env.DEMO_FIXED_VOICE_ID,
};
const FIXED_CHATBOT_ID = process.env.DEMO_FIXED_CHATBOT_ID;
const hasConfiguredPresenterTarget = Boolean(
  PRESENTER_TARGET.avatarId ||
    PRESENTER_TARGET.sceneId ||
    PRESENTER_TARGET.voiceId,
);
const hasCompletePresenterTarget = Boolean(
  PRESENTER_TARGET.avatarId && PRESENTER_TARGET.sceneId,
);
const fixedPresenterTarget = hasCompletePresenterTarget
  ? {
      avatarId: PRESENTER_TARGET.avatarId,
      sceneId: PRESENTER_TARGET.sceneId,
      ...(PRESENTER_TARGET.voiceId
        ? { voiceId: PRESENTER_TARGET.voiceId }
        : {}),
    }
  : null;
// Server-side credentials for the one shared Connect API identity this sample
// uses — see README "Auth model". Every browser hitting this server acts
// through the same upstream account; there is no per-user login.
//
// Two keys, on opposite sides of the trust boundary: the secret one never
// leaves this process, the publishable one is what the browser is given.
const CONNECT_SECRET_KEY = process.env.PERXONA_CONNECT_SECRET_KEY;
const CONNECT_PUBLISHABLE_KEY = process.env.PERXONA_CONNECT_PUBLISHABLE_KEY;

// All blank is fine — resolveEmbedConfig() picks from the catalog. Half-filled
// is not: it does nothing silently, so name what is missing.
if (hasConfiguredPresenterTarget && !hasCompletePresenterTarget) {
  const missing = ["DEMO_FIXED_AVATAR_ID", "DEMO_FIXED_SCENE_ID"].filter(
    (name) => !process.env[name],
  );
  console.warn(
    `WARNING: ${missing.join(" and ")} not set, so the DEMO_FIXED_* values are ignored.\n` +
      "Set DEMO_FIXED_AVATAR_ID and DEMO_FIXED_SCENE_ID together to pin a target, or clear every DEMO_FIXED_* value to let the server pick the first avatar and scene in your catalog. DEMO_FIXED_VOICE_ID is optional — blank selects BYO-TTS.",
  );
}

// Real credentials are only needed when actually calling the upstream API.
// USE_MOCK=true skips callUpstream() entirely (see api selection below), so
// don't force dummy values into these fields just to pass a startup check.
if (!USE_MOCK) {
  if (!PERXONA_API_BASE_URL) {
    console.error(
      "ERROR: PERXONA_API_BASE_URL is required. Copy .env.example to .env and fill it in.",
    );
    process.exit(1);
  }

  if (!CONNECT_SECRET_KEY || !CONNECT_PUBLISHABLE_KEY) {
    // Which side each key belongs on. Swapping them is not reported anywhere:
    // the upstream accepts either, so a secret key would simply be served to
    // the browser.
    const sides =
      "PERXONA_CONNECT_SECRET_KEY authenticates this server and must never reach a browser.\n" +
      "PERXONA_CONNECT_PUBLISHABLE_KEY is the one handed to the presenter.\n";
    const onlyOneKey =
      Boolean(CONNECT_SECRET_KEY) !== Boolean(CONNECT_PUBLISHABLE_KEY);
    const missing = CONNECT_SECRET_KEY
      ? "PERXONA_CONNECT_PUBLISHABLE_KEY"
      : "PERXONA_CONNECT_SECRET_KEY";
    // Reached only by a .env written for the login mode this sample used to
    // have. Without it that .env looks like a typo rather than a removal.
    const removedLogin =
      process.env.PERXONA_CONNECT_EMAIL || process.env.PERXONA_CONNECT_PASSWORD
        ? "PERXONA_CONNECT_EMAIL and PERXONA_CONNECT_PASSWORD are no longer read — this sample authenticates with a Connect API key instead.\n"
        : "";

    console.error(
      (onlyOneKey
        ? `ERROR: ${missing} is not set. Both Connect API keys are required — one is not enough.\n`
        : "ERROR: PERXONA_CONNECT_SECRET_KEY and PERXONA_CONNECT_PUBLISHABLE_KEY are required.\n") +
        removedLogin +
        sides +
        "Create both at https://console.perxona.ai, then copy .env.example to .env and fill them in.",
    );
    process.exit(1);
  }
}

// ── Upstream API implementation ────────────────────────────────────────────

/**
 * Send an authenticated request to the Perxona upstream API.
 *
 * X-Connect-Key is the only credential header this server sends. A request
 * carrying an Authorization as well is rejected upstream with 400, so the two
 * are never combined — here or anywhere else.
 * @param {string} path  - Upstream path, e.g. '/api/v1/connect/voices'
 * @param {object} opts  - fetch options (method, body, headers…)
 * @param {string} [credential] - Connect API key; omit for unauthenticated calls
 */
async function callUpstream(path, opts, credential) {
  const headers = { "Content-Type": "application/json", ...opts.headers };
  if (credential) headers["X-Connect-Key"] = credential;
  return fetch(`${PERXONA_API_BASE_URL}${path}`, { ...opts, headers });
}

/**
 * Parse a callUpstream() Response as JSON, throwing a structured error
 * ({ status, payload }) on any non-2xx status. Centralising this means every
 * connectApi method — not just the ones that used to check r.ok by hand —
 * surfaces the upstream status the same way, which is what lets route() map it
 * onto the response instead of collapsing it to a 502.
 * @param {Response} r
 * @param {string} label  Used in the thrown error message, e.g. "voices".
 */
async function upstreamJson(r, label) {
  if (!r.ok) {
    const payload = await r.json().catch(() => ({}));
    throw Object.assign(new Error(`upstream ${label} failed`), {
      status: r.status,
      payload,
    });
  }
  return r.json();
}

/**
 * Send an authenticated request to the upstream API without forcing Content-Type.
 * Used for multipart/form-data endpoints (chatbot create/update) where fetch must
 * set the Content-Type + boundary automatically from the FormData body.
 * @param {string} path  - Upstream path, e.g. '/api/v1/connect/chatbots'
 * @param {"POST"|"PATCH"} method
 * @param {FormData} form
 * @param {string} [credential] - Connect API key
 */
async function callUpstreamFormData(path, method, form, credential) {
  const headers = credential ? { "X-Connect-Key": credential } : {};
  return fetch(`${PERXONA_API_BASE_URL}${path}`, {
    method,
    headers,
    body: form,
  });
}

/**
 * Probe whether the presenter engine is reachable at PRESENTER_URL.
 * Non-fatal diagnostic only — a HEAD request with a short timeout so startup
 * never blocks. Catches the common "PRESENTER_URL points at a channel that
 * isn't published yet" case (404) before the browser hits a blank stage.
 * @returns {Promise<"reachable" | string>} "reachable", "unreachable (<status>)", or "unreachable"
 */
async function checkPresenter() {
  try {
    const r = await fetch(PRESENTER_URL, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
    return r.ok ? "reachable" : `unreachable (${r.status})`;
  } catch {
    return "unreachable";
  }
}

// connectApi — real upstream implementation, thin wrappers around call().
// Route handlers reference api.* and never touch USE_MOCK directly.
const connectApi = {
  async checkUpstream() {
    try {
      const r = await fetch(`${PERXONA_API_BASE_URL}/ready`);
      return r.ok ? "reachable" : "unreachable";
    } catch {
      return "unreachable";
    }
  },

  async voices(credential) {
    const r = await callUpstream("/api/v1/connect/voices", {}, credential);
    return upstreamJson(r, "voices"); // Page[ConnectVoiceResponse] — items already have { id, name, … }
  },

  // Normalize avatar list: backend uses avatar_id; frontend dropdowns expect id.
  async avatars(credential) {
    const r = await callUpstream(
      "/api/v1/connect/assets/avatars",
      {},
      credential,
    );
    const page = await upstreamJson(r, "avatars");
    return {
      ...page,
      items: (page.items ?? []).map(({ avatar_id, ...rest }) => ({
        id: avatar_id,
        ...rest,
      })),
    };
  },

  // Raw avatar detail — the frontend never calls this directly; it's exposed as a
  // standalone REST resource for reference (see docs/openapi.yaml).
  async avatar(id, credential) {
    const r = await callUpstream(
      `/api/v1/connect/assets/avatars/${id}`,
      {},
      credential,
    );
    return upstreamJson(r, "avatar detail");
  },

  // Motions are a sub-resource of an avatar, not a top-level collection.
  async avatarMotions(avatarId, credential) {
    const r = await callUpstream(
      `/api/v1/connect/assets/avatars/${encodeURIComponent(avatarId)}/motions`,
      {},
      credential,
    );
    return upstreamJson(r, "avatar motions"); // Page[ConnectMotionAssetResponse]
  },

  // Normalize scene list: backend uses scene_id; frontend dropdowns expect id.
  async scenes(credential) {
    const r = await callUpstream(
      "/api/v1/connect/assets/scenes",
      {},
      credential,
    );
    const page = await upstreamJson(r, "scenes");
    return {
      ...page,
      items: (page.items ?? []).map(({ scene_id, ...rest }) => ({
        id: scene_id,
        ...rest,
      })),
    };
  },

  // Raw scene detail — the frontend never calls this directly; it's exposed as a
  // standalone REST resource for reference (see docs/openapi.yaml).
  async scene(id, credential) {
    const r = await callUpstream(
      `/api/v1/connect/assets/scenes/${id}`,
      {},
      credential,
    );
    return upstreamJson(r, "scene detail");
  },

  // ── Chatbot CRUD ──────────────────────────────────────────────────────────
  //
  // Create/update use multipart/form-data because the upstream supports an
  // optional knowledge_file upload. The Express proxy accepts plain JSON from
  // the browser and re-encodes it as FormData before forwarding. This keeps
  // the browser-facing API simple (JSON), while matching what the upstream expects.

  async listChatbots(credential) {
    const r = await callUpstream(
      "/api/v1/connect/chatbots?size=50",
      {},
      credential,
    );
    return upstreamJson(r, "chatbots");
  },

  async getChatbot(id, credential) {
    const r = await callUpstream(
      `/api/v1/connect/chatbots/${encodeURIComponent(id)}`,
      {},
      credential,
    );
    return upstreamJson(r, "chatbot detail");
  },

  async createChatbot({ name, custom_instructions, tools }, credential) {
    const form = new FormData();
    form.append("name", name);
    if (custom_instructions != null)
      form.append("custom_instructions", custom_instructions);
    if (tools !== undefined) form.append("tools", JSON.stringify(tools));
    const r = await callUpstreamFormData(
      "/api/v1/connect/chatbots",
      "POST",
      form,
      credential,
    );
    return upstreamJson(r, "create chatbot");
  },

  async updateChatbot(
    id,
    { name, custom_instructions, tools, remove_knowledge },
    credential,
  ) {
    const form = new FormData();
    if (name != null) form.append("name", name);
    if (custom_instructions !== undefined)
      form.append("custom_instructions", custom_instructions ?? "");
    if (tools !== undefined) form.append("tools", JSON.stringify(tools));
    if (remove_knowledge) form.append("remove_knowledge", "true");
    const r = await callUpstreamFormData(
      `/api/v1/connect/chatbots/${encodeURIComponent(id)}`,
      "PATCH",
      form,
      credential,
    );
    return upstreamJson(r, "update chatbot");
  },

  // Upload a knowledge file for a chatbot by PATCHing with knowledge_file.
  // The caller supplies a Buffer so this method stays independent of Express.
  async uploadChatbotKnowledge(id, fileBuffer, filename, mimeType, credential) {
    const form = new FormData();
    form.append(
      "knowledge_file",
      new Blob([fileBuffer], { type: mimeType }),
      filename,
    );
    const r = await callUpstreamFormData(
      `/api/v1/connect/chatbots/${encodeURIComponent(id)}`,
      "PATCH",
      form,
      credential,
    );
    return upstreamJson(r, "upload chatbot knowledge");
  },

  async deleteChatbot(id, credential) {
    const r = await callUpstream(
      `/api/v1/connect/chatbots/${encodeURIComponent(id)}`,
      { method: "DELETE" },
      credential,
    );
    if (!r.ok) {
      const payload = await r.json().catch(() => ({}));
      throw Object.assign(new Error("upstream delete chatbot failed"), {
        status: r.status,
        payload,
      });
    }
    // 204 No Content — intentionally returns nothing
  },

  async chatWithChatbot(id, messages, credential) {
    const r = await callUpstream(
      `/api/v1/connect/chatbots/${encodeURIComponent(id)}/chat`,
      { method: "POST", body: JSON.stringify({ messages }) },
      credential,
    );
    return upstreamJson(r, "chat with chatbot");
  },
};

// Select implementation at boot: mock (internal dev only) or real upstream.
let api;
if (USE_MOCK) {
  try {
    api = await import("./mocks/upstream.mjs");
  } catch {
    console.error(
      "ERROR: USE_MOCK=true but mocks/upstream.mjs is not present.\n" +
        "The mock implementation is internal-only and is not included in this " +
        "public sample — set USE_MOCK=false (or remove it) and fill in real " +
        "PERXONA_API_BASE_URL / PERXONA_CONNECT_SECRET_KEY / PERXONA_CONNECT_PUBLISHABLE_KEY instead.",
    );
    process.exit(1);
  }
} else {
  api = connectApi;
}

// ── Upstream identity ───────────────────────────────────────────────────────
//
// Every upstream call carries CONNECT_SECRET_KEY, shared by every browser that
// hits this server — see README "Auth model". Nothing is retried on a 401/403:
// a key is refused only when it is revoked, expired, or missing a scope, so the
// same key fails the same way and the upstream status reaches the browser
// unchanged.

/**
 * The target and chatbot the Embed demo runs on, reported on GET /api/config.
 * Pinned by DEMO_FIXED_*, otherwise the first of each in the account. Which of
 * the two happened goes to the startup log, never to the page.
 * @returns {Promise<{target: object|null, chatbotId: string|null}>}
 */
let embedConfigPromise = null;
async function resolveEmbedConfig() {
  // Mock mode's catalog cannot drive the presenter and its chatbot routes 501,
  // so auto-picking would return ids that resolve to nothing. Pinned values
  // cost no upstream call and still stand.
  if (USE_MOCK)
    return {
      target: fixedPresenterTarget,
      chatbotId: FIXED_CHATBOT_ID ?? null,
    };

  embedConfigPromise ??= (async () => {
    const [target, chatbotId] = await Promise.all([
      resolveTarget(),
      resolveChatbotId(),
    ]);
    // Cache only a complete success: the resolvers cannot tell a missing
    // credential from a one-off upstream failure, and a chatbot created later
    // must be picked up without a restart.
    if (!target || !chatbotId) embedConfigPromise = null;
    return { target, chatbotId };
  })();
  return embedConfigPromise;
}

/**
 * Forces the next resolveEmbedConfig() call to re-resolve from upstream
 * rather than keep serving a stale cached value — e.g. after a chatbot is
 * deleted. Kept next to embedConfigPromise so this is the only place that
 * assigns it; callers never touch the variable directly.
 */
function invalidateEmbedConfig() {
  embedConfigPromise = null;
}

/** Avatar + scene + voice: pinned via DEMO_FIXED_*, else first in the catalog. */
async function resolveTarget() {
  if (fixedPresenterTarget) return fixedPresenterTarget;
  try {
    const [avatars, scenes, voices] = await Promise.all([
      api.avatars(CONNECT_SECRET_KEY),
      api.scenes(CONNECT_SECRET_KEY),
      api.voices(CONNECT_SECRET_KEY),
    ]);
    const avatarId = avatars?.items?.[0]?.id;
    const sceneId = scenes?.items?.[0]?.id;
    // Auto-pick includes a voice; a pinned target does not. present() fails
    // without one, but a blank DEMO_FIXED_VOICE_ID means BYO-TTS on purpose.
    const voiceId = voices?.items?.[0]?.id;
    if (!avatarId || !sceneId) return null;
    if (!voiceId) {
      console.warn(
        "WARNING: no voices in this account's catalog, so the auto-selected target has none.\n" +
          "present() will fail — use presentWithAudio(), or set DEMO_FIXED_VOICE_ID.",
      );
    }
    console.log(
      `Auto-selected presenter target: avatar ${avatarId}, scene ${sceneId}` +
        `${voiceId ? `, voice ${voiceId}` : ""}. ` +
        "Set DEMO_FIXED_AVATAR_ID / DEMO_FIXED_SCENE_ID in .env to pin your own.",
    );
    return { avatarId, sceneId, ...(voiceId ? { voiceId } : {}) };
  } catch (err) {
    console.warn(
      `WARNING: could not auto-select a presenter target: ${err.message}`,
    );
    return null;
  }
}

/** The chatbot Embed converses against: DEMO_FIXED_CHATBOT_ID, else the first. */
async function resolveChatbotId() {
  if (FIXED_CHATBOT_ID) return FIXED_CHATBOT_ID;
  try {
    const { items } = await api.listChatbots(CONNECT_SECRET_KEY);
    // Disabled chatbots stay in the list but reject every message.
    const chatbotId =
      items?.find(({ status }) => status !== "disabled")?.id ?? null;
    if (!chatbotId) {
      console.warn(
        "No chatbots in this account yet, so the Embed demo has nothing to talk to.\n" +
          "Create one in the Studio demo (/demos/studio/) — it is picked up on the next page load,\n" +
          "no restart needed — or set DEMO_FIXED_CHATBOT_ID in .env.",
      );
      return null;
    }
    console.log(
      `Auto-selected chatbot ${chatbotId}. Set DEMO_FIXED_CHATBOT_ID in .env to pin your own.`,
    );
    return chatbotId;
  } catch (err) {
    console.warn(`WARNING: could not auto-select a chatbot: ${err.message}`);
    return null;
  }
}

// ── Express app ────────────────────────────────────────────────────────────

const app = express();
app.disable("x-powered-by");

// ── Static frontend ────────────────────────────────────────────────────────

// Disable ETags in dev so a plain browser refresh always fetches the latest
// files from disk. Production keeps ETags for efficient caching.
const IS_DEV = process.env.NODE_ENV !== "production";

// ── Middleware ─────────────────────────────────────────────────────────────

app.use(express.static("public", { etag: !IS_DEV }));

// The knowledge upload route needs a larger JSON body than the 100 KB default,
// and body-parser is a no-op once a body has already been parsed, so its parser
// must run before the global one. Mounting it by path lets Express match it the
// same way it matches the route itself (trailing slash, case-insensitive).
// base64 adds ~33% overhead, so a 1 MB file needs ~1.4 MB of JSON. The 5 MB
// limit is deliberately looser: it bounds what this process will buffer, while
// KNOWLEDGE_MAX_FILE_BYTES is the limit users are held to.
app.use(
  "/api/chatbots/:id/knowledge",
  express.json({ limit: "5mb" }),
  // body-parser answers an oversized body with an HTML stack trace; restate it
  // as the same JSON error the decoded-size check in the route returns.
  (err, _req, res, next) => {
    if (err?.type === "entity.too.large") {
      res.status(413).json({ error: KNOWLEDGE_TOO_LARGE_MESSAGE });
      return;
    }
    next(err);
  },
);
app.use(express.json());

/**
 * Wrap a route handler so any thrown error (an upstream failure surfaced by
 * upstreamJson) becomes a JSON error response instead of an
 * unhandled rejection — Express 4 does not catch async handler rejections on
 * its own.
 *
 * This is also the only place a runtime request failure is logged server-side
 * — every other console.* call in this file runs at boot. Without it, a
 * refused key, an exhausted rate limit, or a disabled chatbot leaves the
 * terminal running `npm run dev`/`npm start` silent; only the browser (and,
 * for a subscription issue, the page itself) would show anything went
 * wrong.
 * @param {(req: express.Request, res: express.Response) => Promise<void>} handler
 */
function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      const status = err.status ?? 502;
      const payload = err.payload ?? { error: String(err) };
      const reason =
        (Array.isArray(payload.detail)
          ? payload.detail[0]?.msg
          : payload.detail) ??
        payload.details ??
        payload.error ??
        err.message;
      console.error(`${req.method} ${req.path} → ${status}: ${reason}`);
      res.status(status).json(payload);
    }
  };
}

// ── Health & config ─────────────────────────────────────────────────────────

// GET /api/health → { status: "ok", upstream: "reachable"|"unreachable"|"mock" }. Always 200.
// Liveness plus the one dynamic field: `upstream` probes the backend on every
// call (and reads "mock" in mock mode). Static per-process flags (mock, chat)
// live in /api/config, which needs no network round-trip.
app.get("/api/health", async (_req, res) => {
  res.json({
    status: "ok",
    upstream: await api.checkUpstream(),
  });
});

// GET /api/config → { mock, chat, elevenlabs, presenterUrl, fixedTarget, chatbotId, subscriptionUrl }.
// Cheap to poll: `chat` reports whether chat is configured (see chatEnabled()), and
// resolveEmbedConfig()'s catalog lookup is memoized. No field says whether a
// value was pinned or auto-picked — nothing may render that. This route has no
// request-layer auth, so subscriptionUrl carries only the derived
// CONSOLE_REGION ("asia"/"eu"), never PERXONA_API_BASE_URL itself — that
// variable is a stage/dev host in some internal workflows, and this is the
// only field here built from a server-side env var's value rather than just
// its presence.
app.get(
  "/api/config",
  route(async (_req, res) => {
    const { target, chatbotId } = await resolveEmbedConfig();
    res.json({
      mock: USE_MOCK,
      chat: chatEnabled(),
      elevenlabs: Boolean(ELEVENLABS_API_KEY),
      presenterUrl: PRESENTER_URL,
      fixedTarget: target,
      chatbotId,
      subscriptionUrl: SUBSCRIPTION_URL,
    });
  }),
);

// GET /api/connect-key
// Returns: { connect_key } — the PUBLISHABLE key the browser passes into
//          presenter.initializeWithConnectKey(connectKey, target). From there,
//          <sv-presenter> talks to the Connect API directly to resolve the
//          target and mint its own speech token.
//          This is never PERXONA_CONNECT_SECRET_KEY. That keeps the secret key
//          out of the browser — it does not put the chatbot routes out of
//          reach, since the /api/* routes below have no request-layer
//          authorization of their own. See README "Auth model".
app.get(
  "/api/connect-key",
  route(async (_req, res) => {
    res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
    // Mock mode has no keys to serve. Saying so beats 200 with an empty body,
    // which is the one shape that reads as success.
    if (USE_MOCK) {
      res.status(501).json({ error: "No Connect key to serve in mock mode." });
      return;
    }
    res.json({ connect_key: CONNECT_PUBLISHABLE_KEY });
  }),
);

// ── Catalog routes ──────────────────────────────────────────────────────────
// GET  /api/voices
// GET  /api/avatars          GET  /api/avatars/:id    GET  /api/avatars/:id/motions
// GET  /api/scenes           GET  /api/scenes/:id
// POST /api/chat             (disabled when chat isn't configured → 501)
//
// All routes below send CONNECT_SECRET_KEY upstream. There is no per-request
// auth check on this server either — see README "Auth model".

// Catalog — read-only lists + single items used to populate UI dropdowns.
//   GET /api/voices              → Page { items: [{ id, name, … }] }
//   GET /api/avatars             → Page { items: [{ id, name, … }] }  (id normalized from avatar_id)
//   GET /api/avatars/:id         → raw avatar detail (avatar_id, lod_urls, lipsync_configs, …)
//   GET /api/avatars/:id/motions → Page { items: [ … ] }
//   GET /api/scenes              → Page { items: [{ id, name, … }] }  (id normalized from scene_id)
//   GET /api/scenes/:id          → raw scene detail
app.get(
  "/api/voices",
  route(async (_req, res) => {
    res.json(await api.voices(CONNECT_SECRET_KEY));
  }),
);

app.get(
  "/api/avatars",
  route(async (_req, res) => {
    res.json(await api.avatars(CONNECT_SECRET_KEY));
  }),
);

app.get(
  "/api/avatars/:id",
  route(async (req, res) => {
    const id = encodeURIComponent(req.params.id);
    res.json(await api.avatar(id, CONNECT_SECRET_KEY));
  }),
);

// Motions are a sub-resource of an avatar (no top-level collection endpoint).
app.get(
  "/api/avatars/:id/motions",
  route(async (req, res) => {
    const id = encodeURIComponent(req.params.id);
    res.json(await api.avatarMotions(id, CONNECT_SECRET_KEY));
  }),
);

app.get(
  "/api/scenes",
  route(async (_req, res) => {
    res.json(await api.scenes(CONNECT_SECRET_KEY));
  }),
);

app.get(
  "/api/scenes/:id",
  route(async (req, res) => {
    const id = encodeURIComponent(req.params.id);
    res.json(await api.scene(id, CONNECT_SECRET_KEY));
  }),
);

// Base URL and model both follow LLM_PROVIDER — keep the pair together when
// adding one, or an unset LLM_MODEL sends the wrong provider's model name.
const LLM_DEFAULTS = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
  },
  vertex: { baseUrl: null, model: "gemini-2.5-flash" },
};

// "Chat enabled" = a static LLM_API_KEY for the openai/anthropic providers,
// or LLM_PROVIDER=vertex with a project set — Vertex authenticates with
// gcloud OAuth, not a key, so requiring LLM_API_KEY there would 501 a fully
// configured vertex setup. /api/config and POST /api/chat share this check.
function chatEnabled() {
  return (
    Boolean(LLM_API_KEY) ||
    (LLM_PROVIDER === "vertex" && Boolean(VERTEX_PROJECT_ID))
  );
}

async function llmRequestConfig(messages) {
  const fallback = LLM_DEFAULTS[LLM_PROVIDER] ?? LLM_DEFAULTS.openai;
  const model = process.env.LLM_MODEL || fallback.model;
  if (LLM_PROVIDER === "vertex") {
    if (!VERTEX_PROJECT_ID) {
      throw Object.assign(
        new Error("VERTEX_PROJECT_ID is required when LLM_PROVIDER=vertex."),
        { status: 500 },
      );
    }
    // Gemini's generateContent shape: system prompt is its own field, and
    // roles are "user"/"model" rather than "user"/"assistant".
    const systemText = messages
      .filter(({ role }) => role === "system")
      .map(({ content }) => content)
      .join("\n");
    const contents = messages
      .filter(({ role }) => role !== "system")
      .map(({ role, content }) => ({
        role: role === "assistant" ? "model" : "user",
        parts: [{ text: content }],
      }));
    const token = await getVertexAccessToken();
    return {
      url:
        `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}` +
        `/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: {
        contents,
        ...(systemText
          ? { systemInstruction: { parts: [{ text: systemText }] } }
          : {}),
      },
    };
  }
  if (LLM_PROVIDER === "anthropic") {
    const system = messages
      .filter(({ role }) => role === "system")
      .map(({ content }) => content)
      .join("\n");
    const userMessages = messages
      .filter(({ role }) => role !== "system")
      .map(({ role, content }) => ({ role, content }));
    return {
      url: `${process.env.LLM_BASE_URL || fallback.baseUrl}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": LLM_API_KEY,
      },
      body: {
        model,
        max_tokens: 1024,
        ...(system ? { system } : {}),
        messages: userMessages,
      },
    };
  }
  return {
    url: `${process.env.LLM_BASE_URL || fallback.baseUrl}/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: { model, messages },
  };
}

async function requestLlmCompletion(messages) {
  if (!["openai", "anthropic", "vertex"].includes(LLM_PROVIDER)) {
    throw Object.assign(
      new Error(
        "LLM_PROVIDER must be one of 'openai', 'anthropic', or 'vertex'.",
      ),
      { status: 500 },
    );
  }
  const request = await llmRequestConfig(messages);
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(
      new Error(
        `LLM request failed: ${payload?.error?.message ?? response.status}`,
      ),
      { status: 502, payload },
    );
  }
  return payload;
}

function llmResponseText(payload) {
  if (LLM_PROVIDER === "anthropic") {
    return payload.content?.find(({ type }) => type === "text")?.text;
  }
  if (LLM_PROVIDER === "vertex") {
    return payload.candidates?.[0]?.content?.parts
      ?.map(({ text }) => text ?? "")
      .join("");
  }
  return payload.choices?.[0]?.message?.content;
}

function openAiCompatibleResponse(payload) {
  if (LLM_PROVIDER === "openai") return payload;
  return {
    choices: [
      {
        message: { role: "assistant", content: llmResponseText(payload) ?? "" },
      },
    ],
  };
}

// ── Tools for the Vertex AI chat path (weather, web search) ────────────────
//
// Vertex AI Gemini refuses to combine a custom function tool with the
// built-in googleSearch grounding tool in one request — confirmed by hand
// against this project: "Multiple tools are supported only when they are all
// search tools." So "web search" is its own function tool whose
// implementation makes a SEPARATE Gemini call using only googleSearch, and
// hands the grounded answer back into the main function-calling turn.
const WEATHER_TOOL_DECL = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "OBJECT",
    properties: {
      location: { type: "STRING", description: "City name, e.g. Tokyo or Hanoi" },
    },
    required: ["location"],
  },
};
const WEB_SEARCH_TOOL_DECL = {
  name: "web_search",
  description:
    "Search the live web for current information (news, facts, prices, " +
    "anything not in the model's training data) and return a summarized answer.",
  parameters: {
    type: "OBJECT",
    properties: { query: { type: "STRING", description: "The search query" } },
    required: ["query"],
  },
};
const WEATHER_CODES = {
  0: "clear sky", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "depositing rime fog",
  51: "light drizzle", 53: "moderate drizzle", 55: "dense drizzle",
  61: "light rain", 63: "moderate rain", 65: "heavy rain",
  71: "light snow", 73: "moderate snow", 75: "heavy snow",
  80: "light rain showers", 81: "moderate rain showers", 82: "violent rain showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

/** Open-Meteo — free, no API key, no signup. https://open-meteo.com/ */
async function toolGetWeather({ location }) {
  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location ?? "")}&count=1`,
  ).then((r) => r.json());
  const place = geo.results?.[0];
  if (!place) return { error: `No location found matching "${location}".` };
  const wx = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`,
  ).then((r) => r.json());
  const c = wx.current ?? {};
  return {
    location: `${place.name}, ${place.country}`,
    temperature_celsius: c.temperature_2m,
    condition: WEATHER_CODES[c.weather_code] ?? `code ${c.weather_code}`,
    wind_speed_kmh: c.wind_speed_10m,
    local_time: c.time,
  };
}

/** Wraps Vertex's built-in Google Search grounding as a callable function —
 * see the note above on why it can't just be a second tool on the same call. */
async function toolWebSearch({ query }) {
  const token = await getVertexAccessToken();
  const model = process.env.LLM_MODEL || LLM_DEFAULTS.vertex.model;
  const res = await fetch(
    `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}` +
      `/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: `Search the web and answer concisely: ${query}` }] },
        ],
        tools: [{ googleSearch: {} }],
      }),
    },
  );
  const payload = await res.json();
  const text = payload.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("");
  return { answer: text || "No results found." };
}

const TOOL_IMPLS = { get_weather: toolGetWeather, web_search: toolWebSearch };

/**
 * Runs the Vertex AI function-calling loop for POST /api/chat: sends the
 * conversation with the weather/web-search tools, executes any function call
 * the model makes, feeds the result back as a "function" role turn, and
 * repeats until the model answers with plain text (capped at 5 turns so a
 * misbehaving loop can't run forever). Returns an OpenAI-shaped completion
 * payload ({ choices: [...] }), same shape openAiCompatibleResponse() makes
 * for the other providers.
 */
async function runVertexChatWithTools(messages) {
  const systemText = messages
    .filter(({ role }) => role === "system")
    .map(({ content }) => content)
    .join("\n");
  const contents = messages
    .filter(({ role }) => role !== "system")
    .map(({ role, content }) => ({
      role: role === "assistant" ? "model" : "user",
      parts: [{ text: content }],
    }));
  const model = process.env.LLM_MODEL || LLM_DEFAULTS.vertex.model;
  const url =
    `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${VERTEX_PROJECT_ID}` +
    `/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;

  for (let turn = 0; turn < 5; turn++) {
    const token = await getVertexAccessToken();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        tools: [{ functionDeclarations: [WEATHER_TOOL_DECL, WEB_SEARCH_TOOL_DECL] }],
      }),
    });
    const payload = await res.json();
    if (!res.ok)
      throw Object.assign(
        new Error(
          `LLM request failed: ${payload?.error?.message ?? res.status}`,
        ),
        { status: 502, payload },
      );

    const modelContent = payload.candidates?.[0]?.content;
    const calls = (modelContent?.parts ?? [])
      .filter((p) => p.functionCall)
      .map((p) => p.functionCall);
    if (calls.length === 0) {
      const text = modelContent?.parts?.map((p) => p.text ?? "").join("") ?? "";
      return { choices: [{ message: { role: "assistant", content: text } }] };
    }

    contents.push(modelContent);
    const responseParts = [];
    for (const call of calls) {
      const impl = TOOL_IMPLS[call.name];
      const output = impl
        ? await impl(call.args ?? {}).catch((err) => ({ error: err.message }))
        : { error: `unknown tool ${call.name}` };
      responseParts.push({ functionResponse: { name: call.name, response: { output } } });
    }
    contents.push({ role: "function", parts: responseParts });
  }
  throw Object.assign(new Error("Tool-calling loop did not resolve in time."), {
    status: 502,
  });
}

// ── Chatbot routes ──────────────────────────────────────────────────────────
// GET    /api/chatbots              → Page { items: [{ id, name, status }] }
// POST   /api/chatbots              → ChatBotDetailResponse (201 proxied as 200)
// GET    /api/chatbots/:id          → ChatBotDetailResponse (id, name, custom_instructions, status, tools)
// PATCH  /api/chatbots/:id          → ChatBotDetailResponse
// DELETE /api/chatbots/:id          → 204 No Content
// POST   /api/chatbots/:id/chat     → { id, status, reply_text }
//
// Create and update are forwarded as multipart/form-data (see callUpstreamFormData).
// The browser sends JSON; the proxy re-encodes it before forwarding upstream.

app.get(
  "/api/chatbots",
  route(async (_req, res) => {
    if (USE_MOCK) {
      res
        .status(501)
        .json({ error: "Chatbot API is not available in mock mode." });
      return;
    }
    res.json(await api.listChatbots(CONNECT_SECRET_KEY));
  }),
);

app.post(
  "/api/chatbots",
  route(async (req, res) => {
    if (USE_MOCK) {
      res
        .status(501)
        .json({ error: "Chatbot API is not available in mock mode." });
      return;
    }
    const { name, custom_instructions, tools } = req.body ?? {};
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "'name' is required." });
      return;
    }
    const created = await api.createChatbot(
      { name, custom_instructions, tools },
      CONNECT_SECRET_KEY,
    );
    // upstream returns 201; surface as 200 for consistent demo fetch handling
    res.json(created);
  }),
);

app.get(
  "/api/chatbots/:id",
  route(async (req, res) => {
    if (USE_MOCK) {
      res
        .status(501)
        .json({ error: "Chatbot API is not available in mock mode." });
      return;
    }
    const id = req.params.id;
    res.json(await api.getChatbot(id, CONNECT_SECRET_KEY));
  }),
);

app.patch(
  "/api/chatbots/:id",
  route(async (req, res) => {
    if (USE_MOCK) {
      res
        .status(501)
        .json({ error: "Chatbot API is not available in mock mode." });
      return;
    }
    const id = req.params.id;
    const { name, custom_instructions, tools, remove_knowledge } =
      req.body ?? {};
    res.json(
      await api.updateChatbot(
        id,
        { name, custom_instructions, tools, remove_knowledge },
        CONNECT_SECRET_KEY,
      ),
    );
  }),
);

app.delete(
  "/api/chatbots/:id",
  route(async (req, res) => {
    if (USE_MOCK) {
      res
        .status(501)
        .json({ error: "Chatbot API is not available in mock mode." });
      return;
    }
    const id = req.params.id;
    await api.deleteChatbot(id, CONNECT_SECRET_KEY);
    // Embed's auto-picked chatbotId may be this one; force the next
    // GET /api/config to re-resolve rather than keep serving a dead id.
    invalidateEmbedConfig();
    res.status(204).end();
  }),
);

// Allowlisted file extensions and MIME types for knowledge uploads.
// Matches the frontend <input accept=".txt,.pdf,.doc,.docx,.csv"> constraint so
// the server rejects any attempt to bypass the client-side restriction.
const KNOWLEDGE_ALLOWED_EXTENSIONS = new Set([
  ".txt",
  ".pdf",
  ".doc",
  ".docx",
  ".csv",
]);
const KNOWLEDGE_ALLOWED_MIME_TYPES = new Set([
  "text/plain",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/csv",
  "application/octet-stream", // fallback when browser cannot detect MIME
]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// Largest knowledge file accepted, measured after base64 decoding.
const KNOWLEDGE_MAX_FILE_BYTES = 1 * 1024 * 1024;
const KNOWLEDGE_TOO_LARGE_MESSAGE = `File is too large. Maximum size is ${KNOWLEDGE_MAX_FILE_BYTES / (1024 * 1024)} MB.`;

// POST /api/chatbots/:id/knowledge
// Body: { filename, content_base64, mime_type }
// Reads the base64-encoded file from the JSON body, converts it to a Buffer,
// and PATCHes the upstream chatbot with knowledge_file as multipart/form-data.
// Separating knowledge upload avoids needing a multipart parser on this server.
// The JSON body is parsed by the 5 MB parser mounted on this path above.
app.post(
  "/api/chatbots/:id/knowledge",
  route(async (req, res) => {
    if (USE_MOCK) {
      res
        .status(501)
        .json({ error: "Chatbot API is not available in mock mode." });
      return;
    }
    const id = req.params.id;
    const { filename, content_base64, mime_type } = req.body ?? {};
    if (!filename || !content_base64) {
      res
        .status(400)
        .json({ error: "'filename' and 'content_base64' are required." });
      return;
    }

    // Reject filenames containing path separators to prevent directory traversal.
    if (filename.includes("/") || filename.includes("\\")) {
      res.status(400).json({ error: "Invalid filename." });
      return;
    }

    // Enforce extension allowlist (aligns with frontend <input accept> constraint).
    const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    if (!KNOWLEDGE_ALLOWED_EXTENSIONS.has(ext)) {
      res.status(400).json({
        error: `File type not allowed. Accepted extensions: ${[...KNOWLEDGE_ALLOWED_EXTENSIONS].join(", ")}.`,
      });
      return;
    }

    // Validate MIME type if provided.
    const effectiveMime = mime_type || "application/octet-stream";
    if (!KNOWLEDGE_ALLOWED_MIME_TYPES.has(effectiveMime)) {
      res.status(400).json({
        error: `MIME type not allowed: ${effectiveMime}.`,
      });
      return;
    }

    // Basic base64 format check before decoding.
    if (!BASE64_RE.test(content_base64)) {
      res.status(400).json({ error: "Invalid base64 content." });
      return;
    }

    const buffer = Buffer.from(content_base64, "base64");
    if (buffer.length > KNOWLEDGE_MAX_FILE_BYTES) {
      res.status(413).json({ error: KNOWLEDGE_TOO_LARGE_MESSAGE });
      return;
    }
    res.json(
      await api.uploadChatbotKnowledge(
        id,
        buffer,
        filename,
        effectiveMime,
        CONNECT_SECRET_KEY,
      ),
    );
  }),
);

// DELETE /api/chatbots/:id/knowledge
// Sends remove_knowledge=true via PATCH to clear the chatbot's knowledge file.
app.delete(
  "/api/chatbots/:id/knowledge",
  route(async (req, res) => {
    if (USE_MOCK) {
      res
        .status(501)
        .json({ error: "Chatbot API is not available in mock mode." });
      return;
    }
    const id = req.params.id;
    res.json(
      await api.updateChatbot(
        id,
        { remove_knowledge: true },
        CONNECT_SECRET_KEY,
      ),
    );
  }),
);

// Both chat routes are unauthenticated and spend something — LLM_API_KEY's
// provider, or the Connect account's quota — so both carry this cap.
const CHAT_MAX_MESSAGES = 40; // Studio sends at most 21 (1 system + 20 history)
const CHAT_MAX_TOTAL_CHARS = 24_000;

/** @returns {string|null} why the payload is refused — handles `content` and `parts`. */
function chatPayloadError(messages) {
  if (!Array.isArray(messages) || messages.length === 0)
    return "'messages' must be a non-empty array.";
  if (messages.length > CHAT_MAX_MESSAGES)
    return `'messages' must contain ${CHAT_MAX_MESSAGES} entries or fewer.`;
  const totalChars = messages.reduce((sum, { content, parts }) => {
    if (typeof content === "string") return sum + content.length;
    if (content !== undefined)
      return sum + JSON.stringify(content ?? "").length;
    return sum + JSON.stringify(parts ?? "").length;
  }, 0);
  return totalChars > CHAT_MAX_TOTAL_CHARS
    ? `'messages' must total ${CHAT_MAX_TOTAL_CHARS} characters or fewer.`
    : null;
}

app.post(
  "/api/chatbots/:id/chat",
  route(async (req, res) => {
    if (USE_MOCK) {
      res
        .status(501)
        .json({ error: "Chatbot API is not available in mock mode." });
      return;
    }
    const id = req.params.id;
    const messages = req.body?.messages;
    const invalid = chatPayloadError(messages);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    res.json(await api.chatWithChatbot(id, messages, CONNECT_SECRET_KEY));
  }),
);

// POST /api/chat
// Request: { messages: [...] } (OpenAI chat format).
// Returns: the OpenAI-compatible chat-completion JSON from the configured endpoint.
// Errors:  501 until chat is configured · 502 LLM upstream unreachable.
// Note: chat talks directly to the configured LLM endpoint, not the Connect API,
// so it does not send CONNECT_SECRET_KEY.
// The size caps below are the only thing standing between this route and an
// unbounded bill: it forwards whatever the browser sends to an endpoint the
// operator pays for, and there is no auth in front of it. The route the demo
// used to call (/api/demo-script) capped the prompt at 2000 characters and
// built the system message server-side; Studio's own-LLM source hands the
// browser the whole array, so the ceiling has to be re-stated here.
// A demo-grade guard, not a rate limiter — see README's Limitations.
app.post("/api/chat", async (req, res) => {
  if (!chatEnabled()) {
    res.status(501).json({
      error:
        "Chat not configured. Set LLM_API_KEY, or LLM_PROVIDER=vertex with VERTEX_PROJECT_ID, in .env to enable chat.",
    });
    return;
  }
  const messages = req.body?.messages;
  const invalid = chatPayloadError(messages);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  try {
    const result =
      LLM_PROVIDER === "vertex"
        ? await runVertexChatWithTools(messages)
        : openAiCompatibleResponse(await requestLlmCompletion(messages));
    res.json(result);
  } catch (err) {
    // This route doesn't go through route() — it has its own try/catch
    // because requestLlmCompletion() isn't an upstreamJson() caller — so it
    // needs its own copy of the same server-console logging.
    console.error(`POST /api/chat → ${err.status ?? 502}: ${err.message}`);
    res
      .status(err.status ?? 502)
      .json({ error: "LLM upstream unreachable", message: String(err) });
  }
});

// POST /api/tts
// Request:  { text, lang? } — one spoken line; lang="ja" selects
//           ELEVENLABS_VOICE_ID_JA (falls back to the default voice).
// Returns:  raw PCM audio (s16le mono 24 kHz) as application/octet-stream; the
//           browser wraps it in a WAV header and hands it to
//           presenter.presentWithAudio(). Errors come back as JSON instead.
// Errors:   501 until ELEVENLABS_API_KEY is set · 502 ElevenLabs unreachable.
// ElevenLabs only ever sees plain spoken text — Perxona's [MOTION ...] /
// (emo:...) markup would be read aloud, so callers strip it before sending
// (the markup travels separately in presentWithAudio()'s content arg, where
// the widget resolves it). Same spending caveat as /api/chat: this route is
// unauthenticated and every call bills the ELEVENLABS_API_KEY account, so the
// text gets a hard cap — replies are prompted to be 1-3 sentences anyway.
const TTS_MAX_CHARS = 2000;

app.post(
  "/api/tts",
  route(async (req, res) => {
    if (!ELEVENLABS_API_KEY) {
      res.status(501).json({
        error:
          "ELEVENLABS_API_KEY not configured. Set it in .env to enable ElevenLabs TTS.",
      });
      return;
    }
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "'text' is required." });
      return;
    }
    if (text.length > TTS_MAX_CHARS) {
      res
        .status(400)
        .json({ error: `'text' must be ${TTS_MAX_CHARS} characters or fewer.` });
      return;
    }
    const voiceId =
      req.body?.lang === "ja" ? ELEVENLABS_VOICE_ID_JA : ELEVENLABS_VOICE_ID;
    const r = await fetch(
      `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
        "?output_format=pcm_24000",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL_ID }),
      },
    );
    if (!r.ok) {
      const payload = await r.json().catch(() => ({}));
      throw Object.assign(new Error("ElevenLabs TTS failed"), {
        status: 502,
        payload: {
          error:
            payload?.detail?.message ??
            (typeof payload?.detail === "string" ? payload.detail : null) ??
            `ElevenLabs TTS failed with status ${r.status}`,
        },
      });
    }
    res.set("Content-Type", "application/octet-stream");
    res.send(Buffer.from(await r.arrayBuffer()));
  }),
);

// ── Gemini Live relay (WebSocket) ───────────────────────────────────────────
//
// True speech-to-speech: the browser streams mic audio in, Gemini Live
// streams synthesized speech back out — no intermediate "present() reads
// this chatbot text aloud" step. This is NOT the same pipeline as
// POST /api/chat above (that's still text in, text out, then Perxona's own
// TTS via present()). Needs LLM_PROVIDER=vertex; reuses VERTEX_PROJECT_ID /
// VERTEX_LOCATION and the same gcloud ADC login already required for that.
//
// Confirmed against this account by hand before wiring this up: the
// `generateContent`-only "gemini-2.5-flash" model cannot open a Live session
// at all (404); the live model has its own name and only supports AUDIO
// response modality, not TEXT.
const GEMINI_LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL || "gemini-live-2.5-flash-native-audio";
// Same Buddy persona as friend-chat's SYSTEM_PROMPT, reworded for voice.
// The reply language is per connection: the browser appends ?lang=en|ja to
// /live-ws and the directive is tacked on here — keep the base prompt
// language-neutral so it composes with either. Keep the persona half in
// sync with friend-chat's SYSTEM_PROMPT when it changes.
const LIVE_SYSTEM_PROMPT_BASE =
  "You are Buddy, a warm, steady companion inside a company's employee " +
  "app — part onboarding buddy for new hires, part wellbeing check-in for " +
  "everyone. Listen first, encourage genuinely. If asked to tease or roast, " +
  "play along — light, affectionate banter, never mean. If asked for a " +
  "riddle, pose one and wait for their guess before revealing the answer. " +
  "For anything serious " +
  "gently point the person to their manager or HR. Keep responses short " +
  "and natural, like real speech.";
function liveSystemPrompt(lang) {
  const langName = lang === "ja" ? "Japanese" : "English";
  return `${LIVE_SYSTEM_PROMPT_BASE} Reply in ${langName} only.`;
}

function startLiveRelay(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/live-ws" });

  wss.on("connection", async (browserWs, req) => {
    const lang =
      new URL(req.url, "http://localhost").searchParams.get("lang") === "ja"
        ? "ja"
        : "en";
    if (LLM_PROVIDER !== "vertex" || !VERTEX_PROJECT_ID) {
      browserWs.send(
        JSON.stringify({
          type: "error",
          message:
            "Live mode needs LLM_PROVIDER=vertex and VERTEX_PROJECT_ID set in .env.",
        }),
      );
      browserWs.close();
      return;
    }

    let geminiSession = null;
    // Messages the browser sends before the Gemini session finishes opening
    // (the very first audio chunks, typically) would otherwise be dropped.
    const pendingFromBrowser = [];
    // One-line-per-connection diagnostics: the two failure modes that look
    // identical in the browser ("Listening" but no reply) are "no mic audio
    // ever arrived" vs "audio arrived but Gemini never answered".
    let browserAudioSeen = false;
    let geminiReplied = false;
    const relay = (raw) => {
      relayBrowserMessage(geminiSession, raw);
      if (!browserAudioSeen) {
        browserAudioSeen = true;
        console.log(`  Live : first browser audio chunk → Gemini (lang=${lang})`);
      }
    };

    browserWs.on("message", (raw) => {
      if (!geminiSession) {
        pendingFromBrowser.push(raw);
        return;
      }
      relay(raw);
    });
    browserWs.on("close", () => geminiSession?.close());

    try {
      const ai = new GoogleGenAI({
        vertexai: true,
        project: VERTEX_PROJECT_ID,
        location: VERTEX_LOCATION,
      });
      geminiSession = await ai.live.connect({
        model: GEMINI_LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          // What Gemini heard — forwarded so the page can caption the
          // user's own speech back, and so "did the mic reach Gemini" is
          // visible in the demo instead of guesswork.
          inputAudioTranscription: {},
          systemInstruction: { parts: [{ text: liveSystemPrompt(lang) }] },
        },
        callbacks: {
          onmessage: (message) => {
            if (!geminiReplied && message.serverContent?.modelTurn) {
              geminiReplied = true;
              console.log("  Live : first Gemini audio → browser");
            }
            forwardGeminiMessage(browserWs, message);
          },
          onerror: (err) => {
            browserWs.send(
              JSON.stringify({ type: "error", message: err.message ?? String(err) }),
            );
          },
          onclose: () => browserWs.close(),
        },
      });
      console.log(`  Live : Gemini session opened (lang=${lang})`);
      for (const raw of pendingFromBrowser) relay(raw);
    } catch (err) {
      browserWs.send(
        JSON.stringify({ type: "error", message: err.message ?? String(err) }),
      );
      browserWs.close();
    }
  });
}

/** Browser → Gemini: only "audio" messages are expected (mic chunks). */
function relayBrowserMessage(geminiSession, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (msg.type === "audio" && msg.data) {
    geminiSession.sendRealtimeInput({
      media: { data: msg.data, mimeType: msg.mimeType || "audio/pcm;rate=16000" },
    });
  }
}

/** Gemini → browser: forward audio chunks, transcript text, and turn/interrupt signals. */
function forwardGeminiMessage(browserWs, message) {
  const content = message.serverContent;
  if (!content) return;
  for (const part of content.modelTurn?.parts ?? []) {
    if (part.inlineData?.data) {
      browserWs.send(
        JSON.stringify({
          type: "audio",
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType || "audio/pcm;rate=24000",
        }),
      );
    }
  }
  if (content.outputTranscription?.text) {
    browserWs.send(
      JSON.stringify({ type: "transcript", text: content.outputTranscription.text }),
    );
  }
  if (content.inputTranscription?.text) {
    browserWs.send(
      JSON.stringify({ type: "inputTranscript", text: content.inputTranscription.text }),
    );
  }
  if (content.interrupted) browserWs.send(JSON.stringify({ type: "interrupted" }));
  if (content.turnComplete) browserWs.send(JSON.stringify({ type: "turnComplete" }));
}

// ── Start ──────────────────────────────────────────────────────────────────

const CHECK_ICONS = { reachable: "✓", unreachable: "✗", mock: "–" };

const httpServer = app.listen(PORT, () => {
  console.log(`\nPerxona Connect Kit`);
  console.log(`  URL  : http://localhost:${PORT}`);
  console.log(`  Mode : ${USE_MOCK ? "MOCK (no real API calls)" : "live"}`);
  // Deferred probes so the banner prints immediately and startup never blocks.
  // Labeled API/CDN so each line reads as that resource's reachability.
  api.checkUpstream().then((status) => {
    const icon = CHECK_ICONS[status] ?? "✗";
    const hint =
      status === "unreachable" ? " — check PERXONA_API_BASE_URL" : "";
    console.log(`  API  : ${icon} ${status}  ${PERXONA_API_BASE_URL}${hint}`);
  });
  // Fire-and-forget, so the picked ids reach the startup log and the first
  // visitor skips the catalog round-trip. Failures are handled inside.
  if (!USE_MOCK) resolveEmbedConfig();
  checkPresenter().then((status) => {
    const icon = CHECK_ICONS[status] ?? "✗";
    const hint =
      status === "reachable"
        ? ""
        : " — set PRESENTER_URL to a reachable engine (see .env)";
    console.log(`  CDN  : ${icon} ${status}  ${PRESENTER_URL}${hint}`);
  });
});

startLiveRelay(httpServer);
if (LLM_PROVIDER === "vertex" && VERTEX_PROJECT_ID) {
  console.log(`  Live : ws://localhost:${PORT}/live-ws  (model: ${GEMINI_LIVE_MODEL})`);
}
