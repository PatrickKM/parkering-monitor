const SOURCE_URL = "https://www.cibos2.dk/parkeringranders";
const ID_LEVEL = 3;
const THRESHOLD = 20;
const STATE_KEY = "state";
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

async function sendNtfy(env, title, message, priority, tags) {
  await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
    method: "POST",
    headers: { Title: title, Priority: priority, Tags: tags },
    body: message,
  });
}

async function checkAndNotify(env) {
  const { available, max } = await fetchLive();
  const below = available <= THRESHOLD;

  const prevRaw = await env.PARK_KV.get(STATE_KEY);
  const prev = prevRaw ? JSON.parse(prevRaw) : null;
  const wasBelow = !!(prev && prev.below_threshold);

  if (below && !wasBelow) {
    await sendNtfy(
      env,
      "Randers P-plads lav",
      `Gasværksgrunden, Jernbanegade: kun ${available} ledige pladser (grænse ${THRESHOLD}).`,
      "urgent",
      "warning,parking"
    );
  } else if (!below && wasBelow) {
    await sendNtfy(
      env,
      "Randers P-plads normal igen",
      `Gasværksgrunden, Jernbanegade: ${available} ledige pladser igen.`,
      "default",
      "white_check_mark"
    );
  }

  const state = {
    available,
    max,
    threshold: THRESHOLD,
    below_threshold: below,
    checked_at: new Date().toISOString(),
  };
  await env.PARK_KV.put(STATE_KEY, JSON.stringify(state));
  return state;
}

// ---- Web Push (VAPID, no payload encryption — push carries no data, the
// service worker fetches fresh state itself when woken) ----

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

async function sendWebPush(subscription, env) {
  const authHeader = await buildVapidAuthHeader(subscription.endpoint, env);
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      TTL: "60",
      "Content-Length": "0",
    },
  });
}

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

async function notifySubscribers(env) {
  const subs = await getAllSubscriptions(env);
  for (const sub of subs) {
    try {
      const resp = await sendWebPush(sub, env);
      if (resp.status === 404 || resp.status === 410) {
        await env.PARK_KV.delete("sub:" + sub.endpoint);
      }
    } catch (err) {
      console.error("push failed", err);
    }
  }
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
      const state = await checkAndNotify(env);
      return new Response(JSON.stringify(state), {
        headers: { "Content-Type": "application/json", ...cors },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      checkAndNotify(env)
        .then(() => notifySubscribers(env))
        .catch((err) => console.error(err))
    );
  },
};
