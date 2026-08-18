const SOURCE_URL = "https://www.cibos2.dk/parkeringranders";
const ID_LEVEL = 3;
const THRESHOLD = 20;
const STATE_KEY = "state";

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

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
    };
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
    ctx.waitUntil(checkAndNotify(env).catch((err) => console.error(err)));
  },
};
