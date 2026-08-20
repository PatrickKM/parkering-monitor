const SOURCE_URL = "https://www.cibos2.dk/parkeringranders";
const ID_LEVEL = 3;
const THRESHOLD = 20;
const STATE_KEY = "state";
const TIMEZONE = "Europe/Copenhagen";
const SNAPSHOT_HOUR = 7; // record history entries during the 07:00-07:59 local window
const VAPID_SUBJECT = "mailto:pkm@grafikr.dk";
// Public half of the VAPID key pair — not secret, must match docs/index.html's VAPID_PUBLIC_KEY.
const VAPID_PUBLIC_KEY = "BMXdPepcic_OEKsEY-agIMF1lvxUQWCgOai38w8E2f5D5YVNz5mcwE4N0X6GuFLEqHGFYQbNsmW1heVkmZMcr4w";

function extractParkInfo(html) {
  const marker = "var parkInfo = ";
  const start = html.indexOf(marker);
  if (start === -1) throw new Error("parkInfo not found");
  const startArr = start + marker.length;
  let depth = 0, end = -1;
  for (let i = startArr; i < html.length; i++) {
    if (html[i] === "[") depth++;
    else if (html[i] === "]") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error("unterminated parkInfo array");
  return JSON.parse(html.slice(startArr, end));
}

async function fetchLive() {
  const resp = await fetch(SOURCE_URL, { cf: { cacheTtl: 0 } });
  if (!resp.ok) throw new Error("upstream http " + resp.status);
  const html = await resp.text();
  const entry = extractParkInfo(html).find((e) => e.id_level === ID_LEVEL);
  if (!entry) throw new Error("id_level " + ID_LEVEL + " not found");
  return { available: entry.availableCount, max: entry.max_count };
}

async function checkState(env) {
  const { available, max } = await fetchLive();
  const below = available <= THRESHOLD;

  const prevRaw = await env.PARK_KV.get(STATE_KEY);
  const prev = prevRaw ? JSON.parse(prevRaw) : null;
  const wasBelow = !!(prev && prev.below_threshold);

  let crossed = null;
  if (below && !wasBelow) crossed = "low";
  else if (!below && wasBelow) crossed = "normal";

  const state = {
    available,
    max,
    threshold: THRESHOLD,
    below_threshold: below,
    checked_at: new Date().toISOString(),
  };
  await env.PARK_KV.put(STATE_KEY, JSON.stringify(state));
  return { state, crossed };
}

function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { dateStr: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10), minute: parts.minute };
}

async function recordMorningSnapshot(env, state) {
  const { dateStr, hour, minute } = localParts(new Date(), TIMEZONE);
  if (hour !== SNAPSHOT_HOUR) return;
  const key = "history:" + dateStr;
  const raw = await env.PARK_KV.get(key);
  const list = raw ? JSON.parse(raw) : [];
  const time = `${String(hour).padStart(2, "0")}:${minute}`;
  if (list.some((s) => s.time === time)) return; // already recorded this minute
  list.push({ time, available: state.available, max: state.max });
  await env.PARK_KV.put(key, JSON.stringify(list), { expirationTtl: 60 * 60 * 24 * 60 });
}

// ---- base64url helpers ----

function b64urlToBytes(b64url) {
  const padding = "=".repeat((4 - (b64url.length % 4)) % 4);
  const base64 = (b64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// ---- VAPID (request authentication) ----

async function importVapidPrivateKey(env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_KEY_JWK);
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function buildVapidAuthHeader(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud, exp: now + 12 * 3600, sub: VAPID_SUBJECT };
  const enc = new TextEncoder();
  const encHeader = bytesToB64url(enc.encode(JSON.stringify(header)));
  const encPayload = bytesToB64url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;
  const key = await importVapidPrivateKey(env);
  const sigBuf = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  const jwt = `${signingInput}.${bytesToB64url(new Uint8Array(sigBuf))}`;
  return `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`;
}

// ---- Web Push payload encryption (RFC 8291 / RFC 8188 aes128gcm) ----

async function encryptPayload(subscription, payloadBytes) {
  const uaPublicBytes = b64urlToBytes(subscription.keys.p256dh);
  const authSecret = b64urlToBytes(subscription.keys.auth);

  const asKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));

  const uaPublicKey = await crypto.subtle.importKey("raw", uaPublicBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asKeyPair.privateKey, 256)
  );

  const enc = new TextEncoder();
  const keyInfo = concatBytes([enc.encode("WebPush: info"), new Uint8Array([0]), uaPublicBytes, asPublicRaw]);

  const ecdhKey = await crypto.subtle.importKey("raw", ecdhSecret, { name: "HKDF" }, false, ["deriveBits"]);
  const contentIkm = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: authSecret, info: keyInfo }, ecdhKey, 256)
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentIkmKey = await crypto.subtle.importKey("raw", contentIkm, { name: "HKDF" }, false, ["deriveBits"]);

  const cekInfo = concatBytes([enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])]);
  const cek = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: cekInfo }, contentIkmKey, 128)
  );

  const nonceInfo = concatBytes([enc.encode("Content-Encoding: nonce"), new Uint8Array([0])]);
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: nonceInfo }, contentIkmKey, 96)
  );

  const plaintext = concatBytes([payloadBytes, new Uint8Array([2])]); // last-record padding delimiter

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext)
  );

  const rs = 4096;
  const header = concatBytes([
    salt,
    new Uint8Array([(rs >>> 24) & 0xff, (rs >>> 16) & 0xff, (rs >>> 8) & 0xff, rs & 0xff]),
    new Uint8Array([asPublicRaw.length]),
    asPublicRaw,
  ]);

  return concatBytes([header, ciphertext]);
}

async function sendWebPush(subscription, env, payloadObj, urgency = "normal", ttl = 60) {
  const authHeader = await buildVapidAuthHeader(subscription.endpoint, env);
  const headers = { Authorization: authHeader, TTL: String(ttl), Urgency: urgency };
  let body;
  if (payloadObj !== undefined) {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
    body = await encryptPayload(subscription, payloadBytes);
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Encoding"] = "aes128gcm";
  } else {
    headers["Content-Length"] = "0";
  }
  return fetch(subscription.endpoint, { method: "POST", headers, body });
}

// ---- subscriptions ----

async function saveSubscription(env, sub) {
  await env.PARK_KV.put("sub:" + sub.endpoint, JSON.stringify(sub));
}

async function getAllSubscriptions(env) {
  const list = await env.PARK_KV.list({ prefix: "sub:" });
  const subs = [];
  for (const k of list.keys) {
    const raw = await env.PARK_KV.get(k.name);
    if (raw) subs.push(JSON.parse(raw));
  }
  return subs;
}

async function pushToAll(env, payloadObj, urgency = "normal", ttl = 60) {
  const subs = await getAllSubscriptions(env);
  const results = [];
  for (const sub of subs) {
    try {
      const resp = await sendWebPush(sub, env, payloadObj, urgency, ttl);
      if (resp.status === 404 || resp.status === 410) {
        await env.PARK_KV.delete("sub:" + sub.endpoint);
      }
      results.push({ endpoint: sub.endpoint.slice(0, 60), status: resp.status });
    } catch (err) {
      results.push({ endpoint: sub.endpoint.slice(0, 60), error: String(err) });
    }
  }
  return { subscriberCount: subs.length, results };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === "/history") {
      const dateStr = url.searchParams.get("date") || localParts(new Date(), TIMEZONE).dateStr;
      const raw = await env.PARK_KV.get("history:" + dateStr);
      const snapshots = raw ? JSON.parse(raw) : [];
      return new Response(JSON.stringify({ date: dateStr, snapshots }), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    }

    if (url.pathname === "/debug") {
      const subs = await getAllSubscriptions(env);
      return new Response(
        JSON.stringify({ subscriberCount: subs.length, endpoints: subs.map((s) => s.endpoint.slice(0, 60) + "...") }),
        { headers: { "Content-Type": "application/json", ...cors } }
      );
    }

    if (url.pathname === "/test-push") {
      try {
        const { state } = await checkState(env);
        const result = await pushToAll(env, { kind: "update", ...state }, "low", 900);
        return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", ...cors } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
    }

    if (url.pathname === "/test-alert") {
      try {
        const kind = url.searchParams.get("kind") === "normal" ? "alert-normal" : "alert-low";
        const { state } = await checkState(env);
        const result = await pushToAll(env, { kind, ...state }, "high", 600);
        return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json", ...cors } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
    }

    if (url.pathname === "/subscribe" && request.method === "POST") {
      try {
        const sub = await request.json();
        if (!sub.endpoint) throw new Error("missing endpoint");
        await saveSubscription(env, sub);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json", ...cors },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
    }

    try {
      const { state } = await checkState(env);
      return new Response(JSON.stringify(state), { headers: { "Content-Type": "application/json", ...cors } });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const { state, crossed } = await checkState(env);
        await recordMorningSnapshot(env, state);
        // Routine glance update: low urgency + long TTL — Android/Chrome may hold this
        // until the phone wakes from Doze rather than deliver it immediately, which is
        // the desired "quiet while locked, fresh when you check" behavior.
        await pushToAll(env, { kind: "update", ...state }, "low", 900);
        if (crossed === "low") {
          // Threshold alert: high urgency cuts through Doze and delivers right away.
          await pushToAll(env, { kind: "alert-low", ...state }, "high", 600);
        } else if (crossed === "normal") {
          await pushToAll(env, { kind: "alert-normal", ...state }, "high", 600);
        }
      })().catch((err) => console.error(err))
    );
  },
};
