const SOURCE_URL = "https://www.cibos2.dk/parkeringranders";
const ID_LEVEL = 3;

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

export default {
  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
    };

    try {
      const resp = await fetch(SOURCE_URL, { cf: { cacheTtl: 0 } });
      if (!resp.ok) throw new Error("upstream http " + resp.status);
      const html = await resp.text();
      const entry = extractParkInfo(html).find((e) => e.id_level === ID_LEVEL);
      if (!entry) throw new Error("id_level " + ID_LEVEL + " not found");

      return new Response(
        JSON.stringify({
          available: entry.availableCount,
          max: entry.max_count,
          checked_at: new Date().toISOString(),
        }),
        { headers: { "Content-Type": "application/json", ...cors } }
      );
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...cors },
      });
    }
  },
};
