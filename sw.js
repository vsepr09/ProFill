// ProFill 서비스 워커: 한 번 열었던 사이트는 인터넷 없이도 열리게 함
const VERSION = "profill-v1.4.5";
const SHELL = [
  "./", "./index.html", "./app.js", "./style.css", "./data.js", "./firebase-config.js",
  "./manifest.webmanifest", "./icon-round-192.png", "./icon-round-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png",
];
// 함께 저장해 둘 바깥 주소 (Firebase 프로그램, 글꼴). Firebase 데이터 통신은 저장하지 않음
const CDN = ["https://www.gstatic.com/firebasejs/", "https://cdn.jsdelivr.net/", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  if (same) {
    // 사이트 파일과 급식: 인터넷이 되면 항상 새것, 안 되면 저장해 둔 것
    e.respondWith(networkFirst(req, url.pathname.endsWith("meals.json")));
    return;
  }
  if (CDN.some((p) => req.url.startsWith(p))) {
    // Firebase 프로그램, 글꼴: 버전이 고정돼 있어서 저장해 둔 것을 먼저 씀
    e.respondWith(cacheFirst(req));
  }
});

async function networkFirst(req, ignoreSearch) {
  const cache = await caches.open(VERSION);
  try {
    // 브라우저에 저장된 옛 파일 말고 항상 서버에 새 버전이 있는지 확인
    const res = await fetch(req, { cache: "no-cache" });
    if (res.ok) cache.put(ignoreSearch ? req.url.split("?")[0] : req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(ignoreSearch ? req.url.split("?")[0] : req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") { const home = await cache.match("./index.html"); if (home) return home; }
    throw err;
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}
