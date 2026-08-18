const WORKER_URL = "https://parking-proxy.patrickkoomadsen.workers.dev";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

async function fetchAndShow() {
  try {
    const r = await fetch(WORKER_URL, { cache: "no-store" });
    const d = await r.json();
    const body = d.error
      ? "Fejl: kunne ikke hente data"
      : `${d.available} ledige (af ${d.max}) — opdateret ${new Date(d.checked_at).toLocaleTimeString("da-DK")}`;
    await self.registration.showNotification("P Gasværksgrunden", {
      tag: "parking-status",
      body,
      icon: "icon.svg",
      badge: "icon.svg",
      silent: true,
      requireInteraction: false,
      actions: [{ action: "refresh", title: "Opdater nu" }],
      data: { url: "./index.html" },
    });
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
  event.waitUntil(fetchAndShow());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "refresh") {
    event.waitUntil(fetchAndShow());
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
