// ProFill 서비스 워커: 한 번 열었던 사이트는 인터넷 없이도 열리게 함
const VERSION = "profill-v1.6.1";
const SHELL = [
  "./", "./index.html", "./app.js", "./style.css", "./data.js", "./firebase-config.js",
  "./manifest.webmanifest", "./icon-round-192.png", "./icon-round-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png",
];
// 앱이 쓰는 Firebase 프로그램과 글꼴 (처음 설치할 때 미리 받아 둠: 한 번만 열고 인터넷이 끊겨도 열리게)
const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
const CDN_FILES = [
  FB + "firebase-app.js", FB + "firebase-auth.js", FB + "firebase-firestore.js",
  "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css",
  "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&display=swap",
];
// 함께 저장해 둘 바깥 주소 (Firebase 프로그램, 글꼴). Firebase 데이터 통신은 저장하지 않음
const CDN = ["https://www.gstatic.com/firebasejs/", "https://cdn.jsdelivr.net/", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then(async (c) => {
    await c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })));
    // 바깥 파일은 하나가 실패해도 설치는 계속 (다음에 열 때 다시 저장됨)
    await Promise.all(CDN_FILES.map(async (u) => {
      try {
        const res = await fetch(u, { mode: u.startsWith(FB) ? "cors" : "no-cors" });
        if (res.ok || res.type === "opaque") await c.put(u, res);
      } catch (err) { /* 무시 */ }
    }));
  }).then(() => self.skipWaiting()));
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

// 와이파이는 잡혔는데 인터넷이 안 될 때 한없이 기다리지 않게: 3초 안에 답이 없으면 저장해 둔 것을 먼저 보여 줌
const SLOW = 3000;
async function networkFirst(req, ignoreSearch) {
  const cache = await caches.open(VERSION);
  const key = ignoreSearch ? req.url.split("?")[0] : req;
  const cached = () => cache.match(key, { ignoreSearch: true })
    .then((hit) => hit || (req.mode === "navigate" ? cache.match("./index.html") : null));
  // 브라우저에 저장된 옛 파일 말고 항상 서버에 새 버전이 있는지 확인
  const net = fetch(req, { cache: "no-cache" }).then((res) => {
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  net.catch(() => {});   // 늦게 실패해도 오류로 남지 않게
  const slow = new Promise((resolve) => setTimeout(resolve, SLOW)).then(cached);
  try {
    // 먼저 온 쪽을 씀. 저장해 둔 게 없으면 인터넷을 끝까지 기다림
    const first = await Promise.race([net, slow.then((hit) => hit || net)]);
    return first;
  } catch (err) {
    const hit = await cached();
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: false }) || await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}
