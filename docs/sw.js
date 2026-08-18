const WORKER_URL = "https://parking-proxy.patrickkoomadsen.workers.dev";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

function updateBody(state) {
  return `${state.available} ledige (af ${state.max}) — opdateret ${new Date(state.checked_at).toLocaleTimeString("da-DK")}`;
}

async function showUpdate(state) {
  await self.registration.showNotification("P Gasværksgrunden", {
    tag: "parking-status",
    body: updateBody(state),
    icon: "icon.svg",
    badge: "icon.svg",
    silent: true,
    requireInteraction: false,
    actions: [{ action: "refresh", title: "Opdater nu" }],
    data: { url: "./index.html" },
  });
}

async function showAlert(kind, state) {
  const isLow = kind === "alert-low";
  await self.registration.showNotification(isLow ? "Randers P-plads lav" : "Randers P-plads normal igen", {
    tag: "parking-alert",
    body: isLow
      ? `Kun ${state.available} ledige pladser (grænse ${state.threshold}).`
      : `${state.available} ledige pladser igen.`,
    icon: "icon.svg",
    badge: "icon.svg",
    vibrate: [200, 100, 200],
    requireInteraction: isLow,
    silent: false,
    data: { url: "./index.html" },
  });
}

async function fetchAndShowUpdate() {
  try {
    const r = await fetch(WORKER_URL, { cache: "no-store" });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    await showUpdate(d);
  } catch (err) {
    await self.registration.showNotification("P Gasværksgrunden", {
      tag: "parking-status",
      body: "Kunne ikke opdatere lige nu",
      icon: "icon.svg",
      silent: true,
    });
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload = null;
      try {
        payload = event.data ? event.data.json() : null;
      } catch (err) {
        payload = null;
      }

      if (!payload) {
        return fetchAndShowUpdate();
      }
      if (payload.kind === "alert-low" || payload.kind === "alert-normal") {
        return showAlert(payload.kind, payload);
      }
      return showUpdate(payload);
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "refresh") {
    event.waitUntil(fetchAndShowUpdate());
    return;
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clientsArr) => {
      const url = (event.notification.data && event.notification.data.url) || "./index.html";
      const existing = clientsArr.find((c) => c.url.includes("index.html"));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
