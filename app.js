import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut,
  EmailAuthProvider, reauthenticateWithCredential, deleteUser, updatePassword,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDoc, setDoc, deleteDoc,
  collection, getDocs, query, where, onSnapshot, getDocFromCache,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { GOALS, KINDS } from "./data.js?v=1.4.2";

const APP_VERSION = "1.4.2";
/* ---------- Firebase ---------- */
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  ignoreUndefinedProperties: true,
});
const EMAIL_DOMAIN = "iasa-protein.app"; // 아이디를 이메일 형식으로 바꿀 때만 쓰임 (메일은 보내지 않음)

/* ---------- 인터넷 없이 열기 ---------- */
if ("serviceWorker" in navigator) {
  const reg = () => navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
    .then((r) => { document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") r.update().catch(() => {}); }); })
    .catch((e) => console.warn("sw", e));
  // 새 버전이 설치되면 한 번만 새로고침해서 바로 적용
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    flushSave();
    setTimeout(() => location.reload(), 300);
  });
  if (document.readyState === "complete") reg(); else window.addEventListener("load", reg);
}
function updateOnline() {
  let bar = document.getElementById("offline");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "offline"; bar.className = "offline-bar"; bar.setAttribute("role", "status");
    bar.textContent = "인터넷 없이 쓰는 중이에요. 체크한 건 연결되면 자동으로 저장돼요.";
    document.body.appendChild(bar);
  }
  bar.classList.toggle("show", navigator.onLine === false);
}
window.addEventListener("online", () => { updateOnline(); if (S) fetchMeals(); });
window.addEventListener("offline", updateOnline);
if (document.readyState === "complete") updateOnline(); else window.addEventListener("load", updateOnline);

/* ---------- 상태 ---------- */
const $app = document.getElementById("app");
let uid = null;
let S = null;            // 사용자 데이터 (Firestore users/{uid})
let loadError = false;
let pendingNick = "";
let meals = { days: {} };
let mealsLoaded = false;
let mealsOk = false;   // 급식 파일을 제대로 받았는지
let lastFillPct = 0;
let friends = [];          // 오늘 달성률을 공개한 친구들 (public 컬렉션)
let friendsState = "idle";
const ui = {
  authMode: "login", authError: "", lastId: "",
  filter: "all", query: "", addOpen: false, editingFood: null,
  panel: null, modal: null, mealDay: 0,
};

/* ---------- 도구 ---------- */
const pad = (n) => String(n).padStart(2, "0");
const kst = (t = Date.now()) => new Date(t + 9 * 3600 * 1000); // getUTC*로 읽으면 한국 시간
const dateKey = (d = kst()) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const nowMin = () => { const d = kst(); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const fmtTime = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const parseTime = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const r1 = (n) => Math.round(n * 10) / 10;
const fmtG = (n) => String(r1(n));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const newId = () => Math.random().toString(36).slice(2, 10);
const WD = "일월화수목금토";
const MEAL_NAMES = { 1: "아침", 2: "점심", 3: "저녁" };
const eul = (w) => {
  const c = String(w).trim().slice(-1).charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return `${w}${(c - 0xac00) % 28 ? "을" : "를"}`;
  return `${w}을(를)`;
};
const eun = (w) => {
  const c = String(w).trim().slice(-1).charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return `${w}${(c - 0xac00) % 28 ? "은" : "는"}`;
  return `${w}은(는)`;
};
const val = (id) => document.getElementById(id)?.value ?? "";

/* ---------- 데이터 ---------- */
function freshData(nickname) {
  return {
    nickname, weight: null, goal: "bulk", customFactor: 2, workouts: [],
    theme: document.documentElement.dataset.theme || "light",
    rollover: "empty", customFoods: [], routines: [], autoRoutineId: null,
    today: { date: dateKey(), items: [], parts: [] }, lastItems: [], history: {},
    shareProgress: false, shareDetail: false, showFriends: true, showPlan: true, showWorkout: true, cutoff: "18:20", cutoffV: 2, yesterday: null,
    recent: {}, reportSeen: null, guideSeen: false, program: null,
  };
}
function migrate(d) {
  const base = freshData(d.nickname || "나");
  const out = { ...base, ...d };
  if (!out.today || !Array.isArray(out.today.items)) out.today = base.today;
  out.today.parts = cleanParts(out.today.parts);
  out.program = out.program ? cleanProgram(out.program) : null;
  if (!Array.isArray(d.workouts)) out.workouts = d.workout ? [{ id: newId(), ...d.workout }] : [];
  // 운동 시간: 시작 + 길이 → 시작 + 끝
  out.workouts = out.workouts.map((w) => {
    if (w.end) return { id: w.id || newId(), start: w.start, end: w.end };
    const e = Math.min(parseTime(w.start || "17:00") + (Number(w.duration) || 60), 23 * 60 + 55);
    return { id: w.id || newId(), start: w.start || "17:00", end: fmtTime(e - (e % 5)) };
  });
  if (out.showFriends === undefined) out.showFriends = true;
  if (out.showPlan === undefined) out.showPlan = true;
  if (out.showWorkout === undefined) out.showWorkout = true;
  delete out.workout;
  delete out.hiddenDefaults;
  // 공유 식품(s:)과 기본 식품(d:)을 없애면서, 담아 둔 것도 정리
  const noShared = (x) => !/^(s:|d-)/.test(String(x.foodId));
  out.today.items = out.today.items.filter(noShared);
  out.lastItems = (out.lastItems || []).filter(noShared);
  (out.routines || []).forEach((r) => { r.items = (r.items || []).filter(noShared); });
  if (out.recent) for (const k of Object.keys(out.recent)) if (/^(s:|d-)/.test(k)) delete out.recent[k];
  // 처음 기본값(18:30)을 쓰던 사람은 저녁 급식 시간(18:20)에 맞춰 한 번만 바꿈
  if (d.cutoff === undefined || (d.cutoff === "18:30" && !d.cutoffV)) out.cutoff = "18:20";
  out.cutoffV = 2;
  if (d.guideSeen === undefined) out.guideSeen = true;   // 이미 쓰던 사람에게는 안내를 띄우지 않음
  for (const h of Object.values(out.history || {})) {
    if (Array.isArray(h.f)) h.f = h.f.map((x) => (Array.isArray(x) ? { n: x[0], g: x[1] } : x));
  }
  return out;
}

let saveTimer = null;
// 최근 7일 동안 체크리스트에 담은 날짜를 식품별로 기억 (자주 먹는 식품을 위로)
function noteRecent() {
  if (!S.recent || typeof S.recent !== "object") S.recent = {};
  const today = S.today.date;
  const from = utcToKey(keyToUTC(today) - 6 * 864e5);
  for (const it of S.today.items) {
    if (it.foodId.startsWith("meal:")) continue;
    const list = S.recent[it.foodId] || [];
    if (!list.includes(today)) list.push(today);
    S.recent[it.foodId] = list;
  }
  for (const [id, list] of Object.entries(S.recent)) {
    const keep = list.filter((k) => k >= from);
    if (keep.length) S.recent[id] = keep; else delete S.recent[id];
  }
}
const recentScore = (id) => (S.recent?.[id] || []).length;
const foodPair = (x) => (Array.isArray(x) ? x : [x.n, x.g]);
function recordToday() {
  const f = [];
  let unresolved = false;
  for (const it of S.today.items) {
    const food = getFood(it.foodId);
    if (!food) { if (it.eaten) unresolved = true; continue; }
    if (it.eaten) f.push({ n: food.name, g: r1(itemG(it, food) * it.eaten) });
  }
  const e = totals().eaten;
  const prev = S.history[S.today.date];
  const parts = cleanParts(S.today.parts);
  // 급식 정보를 못 불러와 계산이 빠진 경우, 이미 저장된 더 큰 기록을 덮어쓰지 않음 (운동 부위만 갱신)
  const ex = logDone(S.today.ex);
  if (unresolved && prev && prev.e > e) { prev.parts = parts; prev.ex = ex; return; }
  S.history[S.today.date] = { e, t: target(), f, parts, ex };
  noteRecent();
  const keys = Object.keys(S.history).sort();
  while (keys.length > 370) delete S.history[keys.shift()];
}
let writing = 0;          // 서버로 보내는 중인 저장 수 (이때 들어온 원격 변경은 무시)
let deleting = false;     // 계정 삭제 중에는 저장하지 않음
function save() {
  if (!S || !uid || deleting) return;
  recordToday();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}
async function flushSave() {
  if (!saveTimer || !S || !uid || deleting) return;
  clearTimeout(saveTimer); saveTimer = null;
  const who = uid, data = JSON.parse(JSON.stringify(S));
  writing++;
  try { await setDoc(doc(db, "users", who), data); remotePending = null; }
  catch (e) {
    console.error(e);
    toast(navigator.onLine === false ? "인터넷이 끊겨 있어요. 연결되면 다시 저장해요." : `저장하지 못했어요 (${e.code || e.message || "알 수 없는 오류"})`);
  } finally { writing--; }
  if (uid === who) syncPublic();
}
// 친구 보기: 공개를 켠 사람만 닉네임, 오늘 달성률, 연속 기록을 올림
function myPublic() {
  const t = target();
  const st = streakInfo();
  const out = { nickname: S.nickname, date: S.today.date, pct: t ? Math.round((totals().eaten / t) * 100) : 0, streak: st.now, updatedAt: Date.now(), detail: null };
  if (S.shareDetail) out.detail = myDetail();
  return out;
}
// 나의 자세한 정보 (친구에게 공개할 때와 '내 정보'에서 같이 씀)
function myDetail() {
  recordToday();
  const t = target();
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const k = dateKey(kst(Date.now() - i * 864e5));
    week.push({ k, p: Math.round(dayPct(k) * 100) });
  }
  return {
    e: totals().eaten, t, foods: S.history[S.today.date]?.f || [], week, best: streakInfo().best,
    weight: S.weight, goal: S.goal === "custom" ? "직접 입력" : (GOALS[S.goal] || GOALS.bulk).label, factor: goalInfo().factor,
    parts: cleanParts(S.today.parts), program: cleanProgram(S.program), ex: logDone(S.today.ex), an: anSummary(),
  };
}
// 운동 분석 요약
function anSummary() {
  const list = exStats();
  if (!list.length) return null;
  const wv = weeklyVolume();
  return {
    v: Math.round(wv[wv.length - 1].v), pv: Math.round(wv[wv.length - 2].v),
    g: list.filter((x) => x.status === "up").length, n: list.length, pr: list.reduce((a, x) => a + x.prs, 0),
    x: groupEx(list).flatMap((gr) => gr.items).slice(0, 15).map((x) => ({
      n: x.n, p: exGroup(x.n).name, s: x.status, c: x.change == null ? null : Math.round(x.change * 100), m: r1(x.m1), bw: x.bw,
    })),
  };
}
const AN_ST = ["up", "flat", "down", "new"];
function cleanAn(a) {
  if (!a || typeof a !== "object") return null;
  const x = (Array.isArray(a.x) ? a.x : []).slice(0, 15).filter((y) => y && typeof y === "object").map((y) => ({
    n: str(y.n, 30), p: str(y.p, 40), s: AN_ST.includes(y.s) ? y.s : "flat",
    c: y.c == null ? null : Math.round(num(y.c, -999, 9999)), m: r1(num(y.m, 0, 9999)), bw: !!y.bw,
  })).filter((y) => y.n);
  if (!x.length) return null;
  const int = (v) => Math.round(num(v, 0, 1e8));
  return { v: int(a.v), pv: int(a.pv), g: int(a.g), n: int(a.n), pr: int(a.pr), x };
}
let publicOn = null;      // 서버의 공개 문서 상태를 기억해서, 꺼진 상태면 매번 지우지 않음
async function syncPublic() {
  if (!S || !uid) return;
  try {
    if (S.shareProgress) {
      publicOn = true;
      const mine = myPublic();
      await setDoc(doc(db, "public", uid), mine);
      friends = [{ id: uid, ...mine }, ...friends.filter((x) => x.id !== uid)];
      updateFriends();
    } else if (publicOn !== false) {
      await deleteDoc(doc(db, "public", uid));
      publicOn = false;
    }
  } catch (e) { console.warn("public", e); }
}

// 자정이 지났으면 새 하루로 바꿈
let autoMsg = "";
function ensureToday() {
  const k = dateKey();
  if (S.today.date === k) return false;
  // 지난 날 기록을 마지막으로 남기고, 다음 날 아침에 고칠 수 있게 복사해 둠
  recordToday();
  S.yesterday = null;
  {
    const items = [];
    for (const it of S.today.items) {
      const f = getFood(it.foodId);
      if (!f) continue;
      items.push({ name: f.name, g: r1(itemG(it, f)), qty: it.qty, eaten: it.eaten, ...(it.pre ? { pre: it.pre } : {}) });
    }
    S.yesterday = { date: S.today.date, t: S.history[S.today.date]?.t ?? target(), items, parts: cleanParts(S.today.parts), ex: (S.today.ex || []).map(cleanLog).filter(Boolean), done: false };
  }
  if (S.today.items.length) S.lastItems = S.today.items.map(slim);
  let items = [];
  if (S.rollover === "routine") {
    const r = S.routines.find((r) => r.id === S.autoRoutineId);
    if (r) items = r.items.map((i) => ({ ...slim(i), eaten: 0 }));
  } else if (S.rollover === "yesterday") {
    items = S.lastItems.map((i) => ({ ...slim(i), eaten: 0 }));
  }
  S.today = { date: k, items, parts: [] };   // ex는 운동법에서 새로 가져옴
  // 넘겨받은 끼니는 그날 급식이 있으면 급식으로, 없으면 집밥으로 바꿈
  const seen = new Set();
  S.today.items = S.today.items.map((it) => {
    const m = /^(meal|home):([123])$/.exec(it.foodId);
    if (!m || !mealsOk) return it;   // 급식 파일을 못 받았으면 그대로 둠
    const id = mealFood(m[2]) ? `meal:${m[2]}` : `home:${m[2]}`;
    return { ...it, foodId: id, qty: 1 };
  }).filter((it) => (seen.has(it.foodId) ? false : seen.add(it.foodId)));
  const up = autoProgress();
  if (up.length) autoMsg = `운동법을 올렸어요: ${up.join(", ")}`;
  return true;
}

let mealsReady = null;
function loadMeals() { mealsReady = fetchMeals(); return mealsReady; }
async function fetchMeals() {
  try {
    const r = await fetch(`data/meals.json?t=${Date.now()}`, { cache: "no-store" });
    if (r.ok) { meals = await r.json(); mealsOk = Object.keys(meals?.days || {}).length > 0; }
  } catch (e) { /* 급식 파일이 없어도 나머지는 동작 */ }
  mealsLoaded = true;
  if (S) softRender();
}
let renderPending = false;
const isTyping = () => document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
// 글자를 입력 중이거나 설정 창이 열려 있으면 다시 그리기를 미룸 (입력한 내용이 지워지지 않게)
function softRender() {
  if (isTyping() || ui.modal?.type === "settings") { renderPending = true; return; }
  renderPending = false;
  render();
}
const todayMeals = () => (meals.days || {})[S?.today?.date || dateKey()] || {};
const mealsOn = (k) => (meals.days || {})[k] || {};

const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };
const str = (v, max) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
function cleanPublic(id, d) {
  const out = { id: str(id, 64), nickname: str(d.nickname, 20) || "친구", date: str(d.date, 8),
    pct: Math.round(num(d.pct, 0, 999)), streak: Math.round(num(d.streak, 0, 9999)), detail: null };
  const dt = d.detail;
  if (dt && typeof dt === "object") {
    out.detail = {
      e: r1(num(dt.e, 0, 9999)), t: Math.round(num(dt.t, 0, 9999)), best: Math.round(num(dt.best, 0, 9999)),
      weight: dt.weight == null ? null : r1(num(dt.weight, 0, 500)) || null,
      goal: str(dt.goal, 12), factor: r1(num(dt.factor, 0, 10)),
      foods: (Array.isArray(dt.foods) ? dt.foods : []).slice(0, 60).map((x) => {
        const [n, g] = foodPair(x && typeof x === "object" ? x : {});
        return { n: str(n, 40), g: r1(num(g, 0, 9999)) };
      }),
      parts: cleanParts(dt.parts), program: cleanProgram(dt.program),
      ex: (Array.isArray(dt.ex) ? dt.ex : []).slice(0, 20).map(cleanEx).filter((x) => x && x.s),
      an: cleanAn(dt.an),
      week: (Array.isArray(dt.week) ? dt.week : []).slice(0, 7)
        .filter((w) => w && /^\d{8}$/.test(String(w.k))).map((w) => ({ k: String(w.k), p: Math.round(num(w.p, 0, 999)) })),
    };
  }
  return out;
}
const friendsFrom = (snap) => snap.docs.map((x) => cleanPublic(x.id, x.data())).filter((f) => f.id !== uid);
async function loadFriends() {
  if (!S?.shareProgress) { friends = []; friendsState = "idle"; updateFriends(); return; }
  try {
    const snap = await getDocs(query(collection(db, "public"), where("date", "==", dateKey())));
    friends = friendsFrom(snap);
    friends.unshift({ id: uid, ...myPublic() });
    friendsState = "ok";
  } catch (e) { console.warn("friends", e); friendsState = "error"; }
  updateFriends();
}
function updateFriends() {
  const el = document.getElementById("friends");
  if (el) el.innerHTML = friendStripHTML();
  const box = document.querySelector(".modal");
  if (box && ui.modal?.type === "friends") box.innerHTML = friendsModalHTML();
  if (box && ui.modal?.type === "friend") box.innerHTML = friendHTML();
}

/* ---------- 실시간 반영: 친구 순위 ---------- */
let unsubFriends = null, friendsDay = null;
// 공개를 켠 친구들이 체크할 때마다 바로 순위에 반영
function watchFriends() {
  const day = dateKey();
  if (unsubFriends && friendsDay === day && S?.shareProgress && S.showFriends) return;
  if (unsubFriends) { unsubFriends(); unsubFriends = null; }
  friendsDay = null;
  if (!S?.shareProgress || !S.showFriends || !uid) { friends = []; friendsState = "idle"; updateFriends(); return; }
  friendsDay = day;
  unsubFriends = onSnapshot(query(collection(db, "public"), where("date", "==", day)), (snap) => {
    friends = friendsFrom(snap);
    friends.unshift({ id: uid, ...myPublic() });
    friendsState = "ok";
    updateFriends();
  }, (e) => { console.warn("friends", e); friendsState = "error"; updateFriends(); });
}
function stopWatching() {
  if (unsubFriends) { unsubFriends(); unsubFriends = null; }
  friendsDay = null;
}

/* ---------- 식품 ---------- */
function mealFood(code) {
  const m = todayMeals()[code];
  if (!m || m.protein == null) return null;
  return { id: `meal:${code}`, name: `급식 ${MEAL_NAMES[code]}`, serving: "1끼", protein: m.protein, kind: "meal", mealCode: String(code), source: "meal" };
}
// 그날 급식 정보가 없는 끼니는 집밥으로 (단백질은 직접 조절)
const HOME_G = 20;
function homeFood(code) {
  if (!mealsLoaded || mealFood(code)) return null;   // 급식 단백질 정보가 없으면 집밥으로
  const g = num(S.homeG?.[code] ?? HOME_G, 0, 200);
  return { id: `home:${code}`, name: MEAL_NAMES[code], serving: "1끼", protein: r1(g), kind: "meal", mealCode: String(code), source: "home" };
}
function allFoods() {
  return [
    ...["1", "2", "3"].map((c) => mealFood(c) || homeFood(c)).filter(Boolean),
    ...S.customFoods.map((f) => ({ ...f, source: "custom" })),
  ];
}
function getFood(id) {
  if (id.startsWith("meal:")) return mealFood(id.slice(5));
  if (id.startsWith("home:")) return homeFood(id.slice(5));
  const c = S.customFoods.find((f) => f.id === id);
  return c ? { ...c, source: "custom" } : null;
}
const CF_MIN = 0.8, CF_MAX = 3.5;
const goalInfo = () => (S.goal === "custom"
  ? { label: "직접 정한", factor: S.customFactor || 2 }
  : GOALS[S.goal] || GOALS.bulk);
const target = () => (S.weight ? Math.round(S.weight * goalInfo().factor) : 0);
// 한 개(급식은 한 번)당 단백질. 급식은 먹은 양(0.5–2인분)을 곱함
const itemG = (it, f) => f.protein * (f.kind === "meal" ? (it.portion || 1) : 1);
const slim = (i) => (i.portion && i.portion !== 1 ? { foodId: i.foodId, qty: i.qty, portion: i.portion } : { foodId: i.foodId, qty: i.qty });
function totals() {
  let eaten = 0, planned = 0;
  for (const it of S.today.items) {
    const f = getFood(it.foodId);
    if (!f) continue;
    eaten += itemG(it, f) * it.eaten;
    planned += itemG(it, f) * it.qty;
  }
  return { eaten: r1(eaten), planned: r1(planned) };
}
const keyToUTC = (k) => Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));
const utcToKey = (t) => dateKey(new Date(t));
function dayPct(k) {
  if (k === S.today.date) { const t = target(); return t ? totals().eaten / t : 0; }
  const h = S.history[k];
  return h && h.t ? h.e / h.t : 0;
}
function streakInfo() {
  const today = keyToUTC(S.today.date);
  const doneToday = dayPct(S.today.date) >= 1;
  let now = 0;
  for (let i = doneToday ? 0 : 1; i < 400; i++) {
    if (dayPct(utcToKey(today - i * 864e5)) >= 1) now++; else break;
  }
  let best = 0, run = 0, prev = null;
  for (const k of [...new Set([...Object.keys(S.history), S.today.date])].sort()) {
    if (dayPct(k) >= 1) {
      const t = keyToUTC(k);
      run = prev !== null && t - prev === 864e5 ? run + 1 : 1;
      prev = t; best = Math.max(best, run);
    } else { run = 0; prev = null; }
  }
  return { now, best, doneToday };
}
function addToList(id, n = 1) {
  const f = getFood(id);
  if (!f) return;
  const it = S.today.items.find((i) => i.foodId === id);
  if (it) { if (f.kind === "meal") return; it.qty = Math.min(20, it.qty + n); }
  else S.today.items.push({ foodId: id, qty: f.kind === "meal" ? 1 : n, eaten: 0 });
}
function mergeItems(list) {
  for (const i of list) {
    const f = getFood(i.foodId);
    if (!f) continue;
    const it = S.today.items.find((x) => x.foodId === i.foodId);
    if (it) it.qty = Math.max(it.qty, i.qty);
    else S.today.items.push({ ...slim(i), eaten: 0 });
  }
}

/* ---------- 추천 ---------- */
// 근거: 한 번에 20–40g씩 3–4시간 간격, 운동 직후 섭취, 자기 전 천천히 흡수되는 단백질 (ISSN 2017)
function buildPlan() {
  const now = nowMin();
  let slots = [
    { time: 8 * 60, label: "아침", meal: "1" },
    { time: 12 * 60 + 40, label: "점심", meal: "2" },
    { time: 18 * 60 + 20, label: "저녁", meal: "3" },
    { time: 23 * 60, label: "자기 전", pref: "slow" },
  ];
  for (const w of S.workouts) {
    const end = Math.min(parseTime(w.end), 23 * 60 + 50);
    const near = slots.find((s) => s.time >= end - 10 && s.time - end <= 60);
    if (near) { if (!near.post) near.label = `${near.label} (운동 직후)`; near.post = true; }
    else slots.push({ time: end, label: "운동 직후", post: true });
  }
  slots.sort((a, b) => a.time - b.time);
  const filled = [];
  slots.forEach((s, i) => {
    filled.push(s);
    const nx = slots[i + 1];
    if (nx && nx.time - s.time >= 300) filled.push({ time: Math.round((s.time + nx.time) / 60) * 30, label: "간식" });
  });
  slots = filled;
  slots.forEach((s) => { s.items = []; s.sum = 0; s.past = s.time < now - 45; });
  const put = (s, f) => { s.items.push(f); s.sum += f.protein; };

  const rest = [];
  for (const it of S.today.items) {
    const f = getFood(it.foodId);
    if (!f) continue;
    for (let k = 0; k < it.qty - it.eaten; k++) {
      if (f.kind === "meal") { const s = slots.find((s) => s.meal === f.mealCode); if (s) put(s, { ...f, protein: itemG(it, f) }); }
      else rest.push(f);
    }
  }
  rest.sort((a, b) => b.protein - a.protein);
  const open = slots.filter((s) => !s.past);
  for (const f of rest) {
    if (!open.length) break;
    let s = null;
    if (f.kind === "fast") s = open.find((x) => x.post && x.sum < 40);
    if (!s && f.kind === "slow") s = open.find((x) => x.pref === "slow" && x.sum < 40);
    if (!s) s = open.reduce((a, b) => (b.sum < a.sum ? b : a));
    put(s, f);
  }
  const shown = slots.filter((s) => s.items.length);
  return { shown, next: shown.find((s) => !s.past), leftover: !open.length && rest.length };
}
function suggest(gap) {
  const inList = (id) => S.today.items.some((i) => i.foodId === id);
  const MEAL_T = { 1: 8 * 60, 2: 12 * 60 + 40, 3: 18 * 60 + 20 };
  const passed = (f) => f.kind === "meal" && nowMin() > MEAL_T[f.mealCode] + 45;   // 이미 지난 끼니는 빼기
  const opts = allFoods().filter((f) => f.protein >= 3 && !(f.kind === "meal" && inList(f.id)) && !passed(f)).map((f) => {
    const n = f.kind === "meal" ? 1 : Math.min(10, Math.ceil(gap / f.protein));
    return { f, n, g: f.protein * n, cover: f.protein * n >= gap };
  });
  // 혼자 채울 수 있는 것 먼저(개수 적은 순), 못 채우면 많이 채우는 순
  return opts.sort((a, b) => (b.cover - a.cover) || (a.cover ? a.n - b.n || a.g - b.g : b.g - a.g)).slice(0, 3);
}

/* ---------- 화면 ---------- */
const ICON_MOON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M20.7 14.6A8.5 8.5 0 0 1 9.4 3.3a8.5 8.5 0 1 0 11.3 11.3Z"/></svg>`;
const FLAME = `<svg class="flame" viewBox="0 0 24 28" aria-hidden="true"><path class="fl-out" d="M12.4 1.2c.9 3.8 4.9 6.6 6.3 10.3 1.8 4.6-.4 10.1-4.6 11.9a8.1 8.1 0 0 1-9.8-3.2c-2-3.2-1.6-7.6.9-10.4.5 1.5 1.4 2.7 2.6 3.4-.6-4.6 1.4-9 4.6-12Z"/><path class="fl-in" d="M12.1 13.4c1.5 1.8 3.6 3.2 3.3 6a3.6 3.6 0 0 1-7.1.5c-.3-1.6.3-3.1 1.4-4.1.2.8.6 1.4 1.2 1.8-.1-1.6.3-3 1.2-4.2Z"/></svg>`;
const ICON_SUN = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g></svg>`;

function loadingHTML() {
  return `<main class="loading" aria-busy="true" aria-label="불러오는 중">
    <div class="ld-word">Pro<b>Fill</b></div>
    <div class="ld-stage" aria-hidden="true">${FLAME.replace('class="flame"', 'class="ld-flame"')}<div class="ld-bar"><i></i></div><span class="ld-goal"></span></div>
    <p class="ld-sub">오늘의 단백질을 채우는 중<span>.</span><span>.</span><span>.</span></p>
  </main>`;
}
function render() {
  if (!uid) return renderAuth();
  if (loadError) {
    $app.innerHTML = `<main class="center"><p>기록을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.</p><button class="btn primary" data-act="reload">다시 시도</button></main>`;
    return;
  }
  if (!S) { $app.innerHTML = loadingHTML(); return; }
  const oldModal = document.querySelector(".modal");
  const keepScroll = oldModal && ui.modal ? [ui.modal.type, oldModal.scrollTop] : null;
  $app.innerHTML = `
    ${headerHTML()}
    <main class="wrap">
      <section class="hero" id="hero">${heroHTML()}</section>
      <div class="layout">
        <div class="main-col">
          ${ydayActive() ? `<section class="block yday">${ydayHTML()}</section>` : ""}
          ${reportActive() ? `<section class="block report">${reportHTML(true)}</section>` : ""}
          ${planBlockHTML()}
          <section class="block checklist">${checklistHTML()}</section>
          ${S.showWorkout !== false ? `<section class="block workout">${workoutHTML()}</section>` : ""}
          <section class="block foods">${foodsHTML()}</section>
        </div>
        <aside class="side">
          <section class="panel meal-panel ${ui.panel === "meal" ? "open" : ""}" aria-label="급식">${mealsHTML()}</section>
        </aside>
      </div>
    </main>
    ${ui.panel ? `<div class="side-back" data-act="close-panel"></div>` : ""}
    ${ui.modal ? modalHTML() : ""}`;
  animateFill();
  if (keepScroll && ui.modal?.type === keepScroll[0]) {
    const m = document.querySelector(".modal");
    if (m) m.scrollTop = keepScroll[1];
  }
}

function animateFill() {
  const el = document.querySelector(".fill");
  if (!el) return;
  const to = el.dataset.w;
  el.style.width = `${lastFillPct}%`;
  void el.offsetWidth;
  el.style.width = `${to}%`;
  if (Number(to) >= 100 && lastFillPct < 100 && lastFillPct > 0) el.closest(".bar").classList.add("hit");
  lastFillPct = Number(to);
}

function headerHTML() {
  return `<header class="top"><div class="wrap top-in">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span>ProFill</div>
    <div class="top-name">${esc(S.nickname)}</div>
    <nav class="top-actions">
      <button class="btn ghost panel-toggle" data-act="panel" data-p="meal">급식</button>
      <button class="icon-btn" data-act="theme" aria-label="${S.theme === "dark" ? "라이트 모드로" : "다크 모드로"}" title="${S.theme === "dark" ? "라이트 모드" : "다크 모드"}">${S.theme === "dark" ? ICON_SUN : ICON_MOON}</button>
      <button class="btn ghost" data-act="open-me">내 정보</button>
      <button class="btn ghost" data-act="open-settings">설정</button>
      <button class="btn ghost" data-act="logout">로그아웃</button>
    </nav></div></header>`;
}

function heroHTML() {
  const t = target();
  const { eaten, planned } = totals();
  const max = Math.max(t * 1.12, planned, eaten, 20);
  const pct = (v) => Math.min(100, (v / max) * 100);
  let segs = "", ci = 0;
  for (const it of S.today.items) {
    const f = getFood(it.foodId);
    if (!f || !it.eaten) continue;
    const g = itemG(it, f) * it.eaten;
    segs += `<div class="seg c${ci++ % 5}" style="width:${eaten ? (g / eaten) * 100 : 0}%" title="${esc(f.name)} ${fmtG(g)}g"><span>${esc(f.name)}</span></div>`;
  }
  const left = r1(t - eaten);
  const status = !t ? `<p class="status-empty">몸무게를 입력하면 목표가 나와요</p>`
    : left > 0
      ? `<div class="remain"><span class="rm-label">남은 양</span><span class="rm-num">${fmtG(left)}<small>g</small></span></div>`
      : `<div class="remain done"><span class="rm-label">오늘 목표</span><span class="rm-num">달성<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" /></svg></span></div>`;
  const step = max > 300 ? 100 : 50;
  let labels = "";
  for (let g = step; g < max; g += step) labels += `<span style="left:${pct(g)}%">${g}</span>`;
  return `
    <div class="hero-head">
      <div class="big"><span class="num">${fmtG(eaten)}</span><span class="of">/ ${t || "–"}g</span></div>
      <div class="hero-meta">
        ${status}
      </div>
      <div class="hero-side">${streakHTML()}${weekHTML()}</div>
    </div>
    <div class="bar-wrap">
      <div class="bar" role="progressbar" aria-label="오늘 먹은 단백질" aria-valuemin="0" aria-valuemax="${t}" aria-valuenow="${eaten}">
        <div class="planned" style="width:${pct(planned)}%"></div>
        <div class="fill" data-w="${pct(eaten)}"><div class="segs">${segs}</div></div>
      </div>
      ${t ? `<div class="goal-line" style="left:${pct(t)}%"><span>목표 ${t}g</span></div>` : ""}
      <div class="ruler" style="--tick:${(10 / max) * 100}%">${labels}</div>
    </div>
    ${S.showFriends ? `<div class="friend-strip" id="friends">${friendStripHTML()}</div>` : ""}`;
}

function weekHTML() {
  let out = "";
  for (let i = 6; i >= 0; i--) {
    const d = kst(Date.now() - i * 864e5);
    const k = dateKey(d);
    const h = k === S.today.date ? { e: totals().eaten, t: target() } : S.history[k];
    const p = h && h.t ? Math.min(1, h.e / h.t) : 0;
    out += `<span class="day ${p >= 1 ? "full" : ""} ${i === 0 ? "today" : ""}"><span class="col"><i style="height:${Math.round(p * 100)}%"></i></span><b>${WD[d.getUTCDay()]}</b></span>`;
  }
  return `<button class="week" data-act="open-history" aria-label="최근 7일 목표 달성, 눌러서 기록 달력 보기">${out}</button>`;
}
function streakHTML() {
  const s = streakInfo();
  const state = s.doneToday ? "on" : s.now ? "wait" : "off";
  const label = s.now ? `${s.now}일 연속 달성${s.doneToday ? "" : ", 오늘도 채우면 이어져요"}` : "연속 기록이 없어요. 오늘 목표를 채우면 시작돼요";
  return `<span class="streak ${state}" title="${label}" role="img" aria-label="${label}">${FLAME}<b>${s.now}</b></span>`;
}

/* ---------- 운동 부위와 나의 운동법 ---------- */
const PARTS = ["가슴", "등", "어깨", "하체", "삼두", "이두", "복근", "전완"];
const WEEK = ["월", "화", "수", "목", "금", "토", "일"];
const cleanParts = (a) => (Array.isArray(a) ? PARTS.filter((p) => a.includes(p)) : []);
const todayParts = () => (S.today.parts = cleanParts(S.today.parts));
// 운동법 정리: { name, splits: [{ parts, ex: [{ n 이름, w 무게(kg, null이면 맨몸), r 개수, s 세트 }] }], sched: [월..일 → 분할 번호, -1은 휴식] }
const cleanEx = (e) => {
  if (!e || typeof e !== "object") return null;
  const n = str(e.n, 30).trim();
  if (!n) return null;
  const bw = e.w === null || e.w === "bw";
  return { n, w: bw ? null : r1(num(e.w, 0, 500)), r: Math.round(num(e.r, 0, 999)), s: Math.round(num(e.s, 0, 99)) };
};
function cleanProgram(p) {
  if (!p || typeof p !== "object" || !Array.isArray(p.splits) || !p.splits.length) return null;
  const splits = p.splits.slice(0, 7).map((x) => ({
    parts: cleanParts(x?.parts),
    ex: (Array.isArray(x?.ex) ? x.ex : []).slice(0, 15).map((e) => {
      const c = cleanEx(e);
      if (c && c.w != null && e.lo != null) c.lo = Math.round(num(e.lo, 1, 999));   // 개수부터 늘릴 때 처음 개수
      return c;
    }).filter(Boolean),
  }));
  const sched = Array.from({ length: 7 }, (_, i) => {
    const raw = Number(p.sched?.[i]);
    if (!Number.isFinite(raw)) return -1;
    const v = Math.round(Math.min(6, Math.max(-1, raw)));
    return v < splits.length ? v : -1;
  });
  return { name: str(p.name, 20).trim(), splits, sched };
}
// 분할 이름은 운동 부위로 (부위를 아직 안 골랐으면 순서로)
const splitName = (sp, i) => (sp?.parts?.length ? sp.parts.join("·") : `분할 ${i + 1}`);
const exText = (e) => `${e.w == null ? "맨몸" : `${fmtG(e.w)}kg`} · ${e.r}회 · ${e.s}세트`;
const exListHTML = (ex) => (ex.length ? `<ul class="ex-list">${ex.map((e) => `<li><span>${esc(e.n)}</span><span>${exText(e)}</span></li>`).join("")}</ul>` : "");
// 운동법이 있으면 운동법에 들어 있는 부위만 보여 줌 (오늘 이미 체크한 부위는 함께)
function shownParts(checked = []) {
  const prog = cleanProgram(S.program);
  if (!prog) return PARTS;
  const mine = prog.splits.flatMap((sp) => sp.parts);
  return PARTS.filter((p) => mine.includes(p) || checked.includes(p));
}
// 오늘(월=0) 계획
function todayPlan() {
  const prog = cleanProgram(S.program);
  if (!prog) return null;
  const w = (new Date(keyToUTC(S.today.date)).getUTCDay() + 6) % 7;
  const i = prog.sched[w];
  return { prog, i, split: i >= 0 ? prog.splits[i] : null };
}
// 그 부위를 마지막으로 한 날 (오늘 제외)
function lastDone(part) {
  const keys = Object.keys(S.history).filter((k) => k < S.today.date).sort().reverse();
  for (const k of keys) {
    if ((S.history[k].parts || []).includes(part)) return Math.round((keyToUTC(S.today.date) - keyToUTC(k)) / 864e5);
  }
  return null;
}
const agoLabel = (n) => (n == null ? "기록 없음" : n === 1 ? "어제" : `${n}일 전`);

/* ---------- 오늘 한 운동 (세트 체크) ---------- */
// S.today.ex = [{ id, n 이름, w 무게(null이면 맨몸), r 개수, s 세트, done 한 세트 }], S.today.exFrom = 가져온 분할 번호
const cleanLog = (e) => {
  const c = cleanEx(e);
  if (!c) return null;
  const sets = Math.max(1, Math.min(20, c.s || 1));
  const out = { id: str(e.id, 20) || newId(), ...c, s: sets, done: Math.min(sets, Math.round(num(e.done, 0, 20))) };
  if (e.tw !== undefined) out.tw = e.tw === null ? null : r1(num(e.tw, 0, 500));
  if (e.tr !== undefined) out.tr = Math.round(num(e.tr, 0, 999));
  if (e.ts !== undefined) out.ts = Math.round(num(e.ts, 0, 20));
  return out;
};
function syncTodayEx() {
  const plan = todayPlan();
  const from = plan?.split ? plan.i : -1;
  const list = (Array.isArray(S.today.ex) ? S.today.ex : []).map(cleanLog).filter(Boolean);
  const touched = list.some((e) => e.done);
  const sig = from >= 0 ? plan.split.ex.map((e) => `${e.n}|${e.w}|${e.r}|${e.s}`).join(";") : "";
  // 오늘 처음이거나, 아직 한 세트도 안 했는데 운동법(분할이나 그 내용)이 바뀌었으면 운동법에서 다시 가져옴
  if (!Array.isArray(S.today.ex) || (!touched && (S.today.exFrom !== from || S.today.exSig !== sig))) {
    S.today.ex = from >= 0 ? plan.split.ex.map(({ lo, ...e }) => ({ id: newId(), ...e, s: Math.max(1, e.s || 1), done: 0, tw: e.w, tr: e.r, ts: e.s })) : [];
    S.today.exFrom = from;
    S.today.exSig = sig;
    return S.today.ex;
  }
  S.today.ex = list;
  return list;
}
const logDone = (list) => (list || []).map(cleanLog).filter((e) => e && e.done)
  .map((e) => {
    const tg = e.tr !== undefined ? { w: e.tw ?? null, r: e.tr, s: e.ts } : progEx(e.n);   // 그날의 목표
    return { n: e.n, w: e.w, r: e.r, s: Math.min(e.done, e.s), t: e.s, ...(tg ? { tw: tg.w ?? null, tr: tg.r } : {}), ...(tg?.s ? { ts: tg.s } : {}) };
  });
const wLabel = (w) => (w == null ? "맨몸" : `${fmtG(w)}kg`);

function exLogRowHTML(e, j, yday) {
  const act = yday ? "yset" : "set";
  const dots = Array.from({ length: e.s }, (_, k) =>
    `<button class="dot ${k < e.done ? "on" : ""}" data-act="${act}" data-j="${j}" data-k="${k}" aria-pressed="${k < e.done}" aria-label="${esc(e.n)} ${k + 1}세트"></button>`).join("");
  if (yday) {
    return `<li class="lx ${e.done >= e.s ? "done" : ""}"><div class="lx-top"><span class="lx-n">${esc(e.n)}</span><span class="lx-spec">${wLabel(e.w)} · ${e.r}회</span></div>
      <div class="lx-bot"><div class="dots">${dots}</div></div></li>`;
  }
  return `<li class="lx ${e.done >= e.s ? "done" : ""}">
    <div class="lx-top"><span class="lx-n">${esc(e.n)}</span><button class="x" data-act="lx-del" data-j="${j}" aria-label="${esc(e.n)} 빼기">×</button></div>
    <div class="lx-bot">
      <span class="lx-wf">${e.w == null ? `<span class="lx-bw">맨몸</span>` : `<label class="lx-f"><input class="lx-w" data-j="${j}" type="number" inputmode="decimal" min="0" max="500" step="0.5" value="${e.w ? fmtG(e.w) : ""}" placeholder="무게" aria-label="무게"><span>kg</span></label>`}<button class="bw" data-act="lx-bw" data-j="${j}" aria-label="${e.w == null ? "무게로 바꾸기" : "맨몸으로 바꾸기"}">${e.w == null ? "무게" : "맨몸"}</button></span>
      <label class="lx-f"><input class="lx-r" data-j="${j}" type="number" inputmode="numeric" min="1" max="999" step="1" value="${e.r}" aria-label="개수"><span>회</span></label>
      <div class="dots">${dots}</div>
      <div class="stepper sm"><button data-act="lx-sets" data-j="${j}" data-d="-1" aria-label="세트 줄이기">−</button><span>${e.s}세트</span><button data-act="lx-sets" data-j="${j}" data-d="1" aria-label="세트 늘리기">+</button></div>
    </div></li>`;
}
// 운동 이름별 가장 최근 기록 (무게, 개수, 계획 세트)
function lastOf(n) {
  const keys = Object.keys(S.history).filter((k) => k < S.today.date).sort().reverse();
  for (const k of keys) {
    const raw = (S.history[k].ex || []).find((x) => x.n === n);
    if (raw) { const c = cleanEx(raw); if (c) return { ...c, s: Math.round(num(raw.t, 0, 20)) || c.s || 3 }; }
  }
  return null;
}
// 한 번에 담을 수 있는 묶음: 오늘 운동법, 다른 분할, 오늘 체크한 부위를 최근에 했던 운동
function quickAdds() {
  const have = new Set((S.today.ex || []).map((e) => e.n));
  const prog = cleanProgram(S.program);
  const plan = todayPlan();
  const out = [];
  const push = (key, label, list) => {
    const fresh = list.filter((e) => !have.has(e.n));
    if (fresh.length) out.push({ key, label, list: fresh });
  };
  if (prog) {
    const order = plan?.split ? [plan.i, ...prog.splits.map((_, i) => i).filter((i) => i !== plan.i)] : prog.splits.map((_, i) => i);
    order.forEach((i) => push(`split:${i}`, i === plan?.i ? "운동법대로" : splitName(prog.splits[i], i), prog.splits[i].ex));
  }
  const keys = Object.keys(S.history).filter((k) => k < S.today.date).sort().reverse();
  for (const p of todayParts()) {
    const k = keys.find((x) => (S.history[x].parts || []).includes(p) && (S.history[x].ex || []).length);
    if (!k) continue;
    // 그날 운동 중 이 부위에 해당하는 것 (운동법에 부위가 있으면 그걸로 고름)
    const inPart = (n) => !prog || !prog.splits.some((sp) => sp.ex.some((e) => e.n === n)) || prog.splits.some((sp) => sp.parts.includes(p) && sp.ex.some((e) => e.n === n));
    const list = (S.history[k].ex || []).map((raw) => { const c = cleanEx(raw); return c && { ...c, s: Math.round(num(raw.t, 0, 20)) || c.s || 3 }; }).filter((c) => c && inPart(c.n));
    const d = new Date(keyToUTC(k));
    push(`part:${p}`, `최근 ${p} (${d.getUTCMonth() + 1}/${d.getUTCDate()})`, list);
  }
  // 바로 전 운동한 날 그대로
  const lastK = keys.find((x) => (S.history[x].ex || []).length);
  if (lastK) {
    const d = new Date(keyToUTC(lastK));
    push("last", `지난번 그대로 (${d.getUTCMonth() + 1}/${d.getUTCDate()})`, S.history[lastK].ex.map((raw) => { const c = cleanEx(raw); return c && { ...c, s: Math.round(num(raw.t, 0, 20)) || c.s || 3 }; }).filter(Boolean));
  }
  const seen = new Set();
  return out.filter((o) => { const sig = o.list.map((e) => e.n).sort().join("|"); if (seen.has(sig)) return false; seen.add(sig); return true; }).slice(0, 4);
}
function knownExNames() {
  const names = new Set();
  cleanProgram(S.program)?.splits.forEach((sp) => sp.ex.forEach((e) => names.add(e.n)));
  Object.values(S.history).forEach((h) => (h.ex || []).forEach((e) => e?.n && names.add(String(e.n).slice(0, 30))));
  return [...names].sort();
}
function exLogHTML() {
  const list = syncTodayEx();
  const quick = quickAdds();
  const add = ui.lxAdd
    ? `<div class="lx-add"><input id="lx-name" maxlength="30" list="lx-names" placeholder="운동 이름" aria-label="운동 이름"><datalist id="lx-names">${knownExNames().map((n) => `<option value="${esc(n)}">`).join("")}</datalist><button class="toggle lx-add-bw ${ui.lxBw ? "on" : ""}" data-act="lx-add-bw" aria-pressed="${!!ui.lxBw}">맨몸</button><button class="btn primary small" data-act="lx-add-save">추가</button><button class="btn ghost small" data-act="lx-add-cancel">취소</button></div>`
    : `<div class="lx-quick">${quick.map((q) => `<button class="chip" data-act="lx-quick" data-k="${esc(q.key)}" title="${esc(q.list.map((e) => e.n).join(", "))}">${esc(q.label)} <span>+${q.list.length}</span></button>`).join("")}<button class="chip ghost-chip" data-act="lx-add">직접 추가</button></div>`;
  return `<div class="lx-wrap"><h3>오늘 한 운동</h3>${list.length ? `<ul class="lx-list">${list.map((e, j) => exLogRowHTML(e, j)).join("")}</ul>` : ""}${add}</div>`;
}

function workoutHTML() {
  const prog = cleanProgram(S.program);
  if (!prog) {
    return `<div class="sec-head"><h2>오늘 운동</h2></div>
      <div class="wk-lock"><p>나의 운동법을 먼저 설정해 주세요.</p><button class="btn primary" data-act="open-program">나의 운동법 설정</button></div>`;
  }
  const parts = todayParts();
  const plan = todayPlan();
  const tags = plan?.split ? (plan.split.parts.length ? plan.split.parts : [splitName(plan.split, plan.i)]) : null;
  const badge = `<span class="day-tags">${tags ? tags.map((t) => `<span class="dtag">${esc(t)}</span>`).join("") : `<span class="dtag rest">휴식</span>`}</span>`;
  const planned = plan?.split?.parts || [];
  const chips = shownParts(parts).map((p) => {
    const on = parts.includes(p);
    const ago = on ? null : lastDone(p);
    const stale = ago != null && ago >= 7;   // 7일 넘게 쉰 부위는 주황색으로
    return `<button class="part ${on ? "on" : ""} ${planned.includes(p) && !on ? "plan" : ""}" data-act="part" data-p="${p}" aria-pressed="${on}"${stale ? ` title="${ago}일 동안 안 했어요"` : ""}>
      <span class="pn">${p}</span><span class="pl ${stale ? "stale" : ""}">${on ? "오늘" : agoLabel(ago)}</span></button>`;
  }).join("");
  return `<div class="sec-head"><div class="wk-title"><h2>오늘 운동</h2>${badge}</div>
      <div class="head-actions"><button class="btn ghost" data-act="open-exstats">분석</button><button class="btn ghost" data-act="open-program">나의 운동법</button></div></div>
    <div class="parts">${chips}</div>
    ${exLogHTML()}`;
}

/* ---------- 운동 분석: 성장과 점진적 과부하 ---------- */
const W_STEP = 2.5;                                    // 무게 올릴 때 단위 (kg)
const e1rm = (w, r) => (w > 0 && r > 0 ? w * (1 + Math.min(r, 15) / 30) : 0);   // Epley 추정 1RM
const round25 = (v) => Math.max(0, Math.round(v / W_STEP) * W_STEP);
// 날짜순 운동 기록: { k, n, w, r, s 한 세트, t 계획 세트 }
function sessionsBy() {
  const by = {};
  for (const k of Object.keys(S.history).sort()) {
    for (const raw of S.history[k].ex || []) {
      const c = cleanEx(raw); if (!c || !c.s) continue;
      const x = { k, ...c, t: Math.round(num(raw.t, 0, 20)) || null };
      if (x.w === 0) x.w = null;   // 0kg로 적은 운동은 맨몸으로 봄
      if (raw.tr !== undefined) { x.tr = Math.round(num(raw.tr, 0, 999)); x.tw = raw.tw == null || !num(raw.tw, 0, 500) ? null : r1(num(raw.tw, 0, 500)); }
      if (raw.ts !== undefined) x.ts = Math.round(num(raw.ts, 0, 20)) || undefined;
      (by[c.n] ||= []).push(x);
    }
  }
  return by;
}
const progEx = (n) => cleanProgram(S.program)?.splits.flatMap((sp) => sp.ex).find((x) => x.n === n) || null;
// 오늘 분할에 있는 운동을 먼저 찾음
const progExToday = (n) => todayPlan()?.split?.ex.find((x) => x.n === n) || progEx(n);
const sameT = (a, b) => a.w === b.w && a.r === b.r && a.s === b.s;
// 같은 운동이라도 분할마다 목표가 다르면 따로 봄: [{ w, r, s, lo, label }]
function targetsOf(n) {
  const prog = cleanProgram(S.program); if (!prog) return [];
  const out = [];
  prog.splits.forEach((sp, i) => sp.ex.forEach((e) => {
    if (e.n !== n) return;
    const label = splitName(sp, i);
    const had = out.find((t) => sameT(t, e));
    if (had) { if (!had.labels.includes(label)) had.labels.push(label); return; }
    out.push({ ...e, labels: [label] });
  }));
  return out.map(({ labels, ...t }) => ({ ...t, label: labels.join(", ") }));
}
// 그날의 목표(세트, 개수, 무게)를 다 채웠는지. 목표가 없던 예전 기록은 세트만 봄
function complete(x) {
  const need = x.ts || x.t;   // 운동법의 세트 수 (예전 기록은 그날 세트 수)
  if (!need || x.s < need) return false;
  if (x.tr === undefined) return true;
  return x.r >= x.tr && (x.tw == null || (x.w ?? 0) >= x.tw);
}
// 지금 목표로 한 세션인지 (목표를 바꾼 뒤의 기록만 보고 판단)
function atTarget(x, tg) {
  if (!tg) return true;
  if (x.tr !== undefined) return x.tr === tg.r && (x.tw ?? null) === (tg.w ?? null);
  return tg.w == null ? x.r >= tg.r : (x.w ?? 0) >= tg.w;   // 예전 기록
}
const LIGHT = 20;      // 이 무게보다 가벼우면 개수부터 늘림
const REP_RANGE = 4;   // 처음 개수 + 4회까지
const GAP = 14;        // 이만큼(일) 넘게 쉬면 다시 시작
const dayN = (k) => Math.round(keyToUTC(k) / 864e5);
// 다음 목표: 지금 목표로 두 번 연속 다 채우면 올리고, 세 번 연속 못 채우면 내림
function overload(all, tg) {
  let ss = all;
  const lastAll = ss[ss.length - 1];
  if (lastAll.k === S.today.date && !complete(lastAll)) ss = ss.slice(0, -1);   // 오늘 하는 중인 운동은 빼기
  const base = tg ? { w: tg.w, r: tg.r, s: tg.s, ...(tg.lo != null ? { lo: tg.lo } : {}) } : { w: lastAll.w, r: lastAll.r, s: lastAll.t || lastAll.s };
  const bw = base.w == null;
  const hold = (why) => ({ kind: "hold", ...base, why });
  const prev = ss[ss.length - 1];
  if (prev && dayN(S.today.date) - dayN(prev.k) > GAP) return hold("오랜만이에요. 지금 목표로 다시 시작해요");
  // 지금 목표로 한 기록만, 오래 쉬기 전 기록은 빼고
  const cur = ss.filter((x) => atTarget(x, tg));
  let st = 0;
  for (let i = 1; i < cur.length; i++) if (dayN(cur[i].k) - dayN(cur[i - 1].k) > GAP) st = i;
  const recent = cur.slice(st).slice(-3);
  const ok = recent.map(complete);
  const light = !bw && (base.w || 0) < LIGHT;
  const lo = Math.min(base.lo ?? base.r, base.r), top = lo + REP_RANGE;
  if (ok.length >= 2 && ok[ok.length - 1] && ok[ok.length - 2]) {
    const why = "두 번 연속 목표를 채웠어요";
    if (bw) return { kind: "up", w: null, r: base.r + 1, s: base.s, why };
    if (light && base.r < top) return { kind: "up", w: base.w, r: base.r + 1, s: base.s, lo, why: `개수부터 늘려요 (${top}회까지)` };
    if (light) return { kind: "up", w: round25(base.w + W_STEP), r: lo, s: base.s, lo, why: `${top}회를 채워서 무게를 올려요` };
    return { kind: "up", w: round25(base.w + W_STEP), r: base.r, s: base.s, why };
  }
  if (ok.length === 3 && !ok.some(Boolean)) {
    const why = "세 번 연속 목표에 못 미쳤어요";
    if (bw) return { kind: "down", w: null, r: Math.max(1, base.r - 2), s: base.s, why };
    if (light && base.r > lo) return { kind: "down", w: base.w, r: lo, s: base.s, lo, why };
    let w2 = round25(base.w * 0.9);
    if (w2 >= base.w) w2 = Math.max(0, r1(base.w - W_STEP));
    return { kind: "down", w: w2, r: base.r, s: base.s, ...(light ? { lo } : {}), why };
  }
  if (!recent.length) return hold("새 목표로 시작해요");
  if (ok[ok.length - 1]) return { kind: "near", ...base, why: "한 번 더 채우면 올려요" };
  return hold("이번 목표를 먼저 채워요");
}
// 운동별 다음 목표 (분할마다 목표가 다르면 여러 개)
function nextsOf(n, ss) {
  const tgs = targetsOf(n);
  if (!tgs.length) return [{ tg: null, nx: overload(ss, null), label: "" }];
  return tgs.map((tg) => ({ tg, nx: overload(ss, tg), label: tgs.length > 1 ? tg.label : "" }));
}
function exStats() {
  recordToday();
  const by = sessionsBy();
  const today = keyToUTC(S.today.date);
  return Object.entries(by).map(([n, ss]) => {
    const bw = ss[ss.length - 1].w == null;
    const metric = (x) => (bw ? x.r * x.s : e1rm(x.w, x.r));          // 맨몸은 총 개수, 무게는 추정 1RM
    const last = ss[ss.length - 1];
    // 4주 안의 첫 기록과 비교. 4주 안에 한 번뿐이면 그 직전 기록과 비교
    let bi = ss.findIndex((x) => keyToUTC(x.k) >= today - 28 * 864e5);
    if (bi < 0) bi = 0;
    else if (bi === ss.length - 1 && bi > 0) bi -= 1;
    const base = ss[bi];
    // 최근 값은 마지막 기록 앞 일주일 중 가장 좋은 기록 (무거운 날, 가벼운 날이 섞여도 하락으로 안 보이게)
    const wk = ss.slice(bi + 1).filter((x) => keyToUTC(x.k) >= keyToUTC(last.k) - 6 * 864e5);
    const m0 = metric(base), m1 = wk.length ? Math.max(...wk.map(metric)) : metric(last);
    const change = ss.length > 1 && m0 ? (m1 - m0) / m0 : null;
    let best = 0, prs = 0;
    ss.forEach((x) => { const m = metric(x); if (m > best) { if (best && keyToUTC(x.k) >= today - 30 * 864e5) prs++; best = m; } });
    const status = ss.length < 2 ? "new" : change > 0.02 ? "up" : change < -0.02 ? "down" : "flat";
    return { n, ss, bw, last, best, m1, change, prs, status, nexts: nextsOf(n, ss) };
  }).sort((a, b) => (a.last.k < b.last.k ? 1 : a.last.k > b.last.k ? -1 : a.n.localeCompare(b.n)));
}
// 주별 볼륨 (무게 × 개수 × 세트, 최근 6주)
function weeklyVolume() {
  const out = [];
  for (let w = -5; w <= 0; w++) {
    const days = weekRange(w);
    let v = 0;
    days.forEach((k) => (S.history[k]?.ex || []).forEach((raw) => {
      const c = cleanEx(raw); if (!c) return;
      const w = !c.w ? S.weight || 0 : c.w;   // 맨몸(또는 0kg)은 몸무게로 계산
      v += w * c.r * c.s;
    }));
    out.push({ k: days[0], v });
  }
  return out;
}
function sparkSVG(vals) {
  if (vals.length < 2) return "";
  const W = 120, H = 34, lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const xy = vals.map((v, i) => [(i / (vals.length - 1)) * (W - 6) + 3, H - 4 - ((v - lo) / span) * (H - 8)]);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${xy.map((p) => p.join(",")).join(" ")}"/>${xy.map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i === xy.length - 1 ? 3 : 1.8}"/>`).join("")}</svg>`;
}
function volBarsHTML(wv) {
  const max = Math.max(...wv.map((x) => x.v), 1);
  return `<div class="vol-bars">${wv.map((x, i) => {
    const d = new Date(keyToUTC(x.k));
    return `<span class="vb ${i === wv.length - 1 ? "now" : ""}"><span class="vb-col"><i style="height:${Math.round((x.v / max) * 100)}%"></i></span><b>${i === wv.length - 1 ? "이번 주" : `${d.getUTCMonth() + 1}/${d.getUTCDate()}`}</b></span>`;
  }).join("")}</div>`;
}
const fmtVol = (v) => (v >= 10000 ? `${fmtG(v / 1000)}t` : `${Math.round(v).toLocaleString()}kg`);
const STATUS = { up: ["성장 중", "up"], flat: ["정체", "flat"], down: ["하락", "down"], new: ["새 운동", "new"] };
const NEXT = { up: "증량", down: "감량", near: "유지", hold: "유지" };

// 운동이 들어 있는 분할(부위)로 묶음. 운동법에 없는 운동은 '기타'
function exGroup(n) {
  const prog = cleanProgram(S.program);
  const i = prog ? prog.splits.findIndex((sp) => sp.ex.some((e) => e.n === n)) : -1;
  if (i < 0) return { i: 99, name: "기타" };
  const sp = prog.splits[i];
  return { i, name: sp.parts.length ? sp.parts.join(" · ") : `분할 ${i + 1}` };
}
function groupEx(list) {
  const groups = [];
  for (const x of list) {
    const g = exGroup(x.n);
    let gr = groups.find((y) => y.i === g.i);
    if (!gr) groups.push((gr = { ...g, items: [] }));
    gr.items.push(x);
  }
  return groups.sort((a, b) => a.i - b.i);
}
function exStatsHTML() {
  const list = exStats();
  const close = `<div class="modal-actions"><button class="btn primary" data-act="close-modal">닫기</button></div>`;
  const auto = `<label class="switch-row es-auto"><span><b>운동법 자동으로 올리기</b><small>두 번 연속 목표를 채우면 다음 날 목표를 올려요</small></span>
      <input type="checkbox" role="switch" class="switch" id="s-auto" ${S.autoProgress ? "checked" : ""}></label>`;
  if (!list.length) return `<h2>운동 분석</h2>${auto}<p class="muted">아직 기록한 세트가 없어요.</p>${close}`;
  const wv = weeklyVolume();
  const cur = wv[wv.length - 1].v, prev = wv[wv.length - 2].v;
  const volChg = prev ? Math.round(((cur - prev) / prev) * 100) : null;
  const growing = list.filter((x) => x.status === "up").length;
  const prs = list.reduce((a, x) => a + x.prs, 0);
  const pct = (c) => `${c > 0 ? "▲" : c < 0 ? "▼" : ""}${Math.abs(Math.round(c * 100))}%`;
  const card = (x) => {
    const [label, cls] = STATUS[x.status];
    const d = new Date(keyToUTC(x.last.k));
    const series = x.ss.slice(-10).map((s) => (x.bw ? s.r * s.s : e1rm(s.w, s.r)));
    const nexts = x.nexts.map(({ tg, nx, label }, i) => `
      <div class="es-next ${nx.kind}">
        <div><small>${label ? `${esc(label)} · ` : ""}다음 목표 · ${NEXT[nx.kind]}</small><b>${wLabel(nx.w)} · ${nx.r}회 · ${nx.s}세트</b><span>${nx.why}</span></div>
        ${tg && !sameT(tg, nx) && (nx.kind === "up" || nx.kind === "down") ? `<button class="btn small" data-act="apply-next" data-n="${esc(x.n)}" data-i="${i}">운동법에 반영</button>` : ""}
      </div>`).join("");
    return `<li>
      <div class="es-top"><b>${esc(x.n)}</b><span class="badge-s ${cls}">${label}</span>${x.change != null ? `<span class="es-chg ${x.change > 0 ? "up" : x.change < 0 ? "down" : ""}">${pct(x.change)}</span>` : ""}</div>
      <div class="es-mid">
        <div class="es-big"><small>${x.bw ? "총 개수" : "추정 1RM"}</small><b>${x.bw ? `${Math.round(x.m1)}회` : `${fmtG(r1(x.m1))}kg`}</b></div>
        ${sparkSVG(series)}
      </div>
      <p class="es-last">${d.getUTCMonth() + 1}/${d.getUTCDate()} · ${wLabel(x.last.w)} · ${x.last.r}회 · ${x.last.s}${x.last.t ? `/${x.last.t}` : ""}세트</p>
      ${nexts}</li>`;
  };
  const cards = groupEx(list).map((gr) => `<section class="es-group"><h3 class="es-gh">${esc(gr.name)}</h3><ul class="es-list">${gr.items.map(card).join("")}</ul></section>`).join("");
  return `<h2>운동 분석</h2>
    <div class="cal-stats">
      <div><span>이번 주 볼륨</span><b>${fmtVol(cur)}</b><small>${!prev ? "지난주 기록 없음" : cur ? `지난주보다 ${pct(volChg / 100)}` : `지난주 ${fmtVol(prev)}`}</small></div>
      <div><span>성장 중</span><b>${growing}/${list.length}</b><small>최근 4주 기준</small></div>
      <div><span>최고 기록 경신</span><b>${prs}번</b><small>최근 30일</small></div>
    </div>
    <h3 class="es-h">주별 볼륨</h3>${volBarsHTML(wv)}
    ${auto}
    ${cards}${close}`;
}
// 운동법에 다음 목표 반영: changes = [{ n, from 지금 목표, nx 다음 목표 }]. 한 번에 바꿔서 서로 섞이지 않게 함
function applyNext(changes) {
  const prog = cleanProgram(S.program); if (!prog) return false;
  let hit = false;
  prog.splits.forEach((sp) => sp.ex.forEach((e) => {
    const c = changes.find((c) => c.n === e.n && sameT(e, c.from));
    if (!c) return;
    e.w = c.nx.w; e.r = c.nx.r; e.s = c.nx.s;
    if (c.nx.lo != null) e.lo = c.nx.lo; else delete e.lo;
    hit = true;
  }));
  if (hit) S.program = prog;
  return hit;
}
// 자동으로 올리기: 증량만 자동으로
function autoProgress() {
  if (!S.autoProgress || !cleanProgram(S.program)) return [];
  const by = sessionsBy(), changes = [], done = [];
  for (const [n, ss] of Object.entries(by)) {
    for (const { tg, nx } of nextsOf(n, ss)) {
      if (!tg || nx.kind !== "up" || sameT(tg, nx)) continue;
      changes.push({ n, from: tg, nx });
      const t = `${n} ${wLabel(nx.w)} × ${nx.r}회`;
      if (!done.includes(t)) done.push(t);
    }
  }
  return changes.length && applyNext(changes) ? done : [];
}

/* 나의 운동법 편집 */
const newEx = () => ({ n: "", w: "", r: 10, s: 3 });
function programDraft() {
  const p = cleanProgram(S.program);
  if (p) return JSON.parse(JSON.stringify(p));
  return { name: "", splits: [0, 1, 2].map(() => ({ parts: [], ex: [newEx()] })), sched: [0, 1, 2, -1, 0, 1, 2] };
}
function readProgramForm() {
  const d = ui.modal?.draft;
  if (!d || !document.getElementById("pg-name")) return;
  d.name = val("pg-name");
  document.querySelectorAll(".ex-row").forEach((row) => {
    const e = d.splits[+row.dataset.i]?.ex[+row.dataset.j];
    if (!e) return;
    e.n = row.querySelector(".ex-n").value;
    if (e.w !== null) e.w = row.querySelector(".ex-w")?.value ?? e.w;
    const r = row.querySelector(".ex-r").value;
    if (String(r) !== String(e.r)) delete e.lo;   // 개수를 직접 바꾸면 그 개수부터 다시 셈
    e.r = r;
    e.s = row.querySelector(".ex-s").value;
  });
  d.sched = WEEK.map((_, w) => Number(document.querySelector(`.pg-day[data-w="${w}"]`)?.value ?? d.sched[w]));
}
function exRowHTML(e, i, j) {
  const bw = e.w === null;
  return `<div class="ex-row" data-i="${i}" data-j="${j}">
    <input class="ex-n" maxlength="30" value="${esc(e.n)}" placeholder="운동 이름" aria-label="운동 이름">
    <button class="x ex-del" data-act="pg-ex-del" data-i="${i}" data-j="${j}" aria-label="운동 지우기">×</button>
    <div class="ex-w-box ${bw ? "is-bw" : ""}">
      ${bw ? `<span class="bw-field">맨몸</span>` : `<input class="ex-w" type="number" inputmode="decimal" min="0" max="500" step="0.5" value="${esc(e.w)}" placeholder="무게" aria-label="무게 (kg)"><span class="u">kg</span>`}
      <button class="bw" data-act="pg-ex-bw" data-i="${i}" data-j="${j}">${bw ? "무게" : "맨몸"}</button>
    </div>
    <label class="ex-num"><input class="ex-r" type="number" inputmode="numeric" min="1" max="999" step="1" value="${esc(e.r)}" aria-label="개수"><span class="u">회</span></label>
    <label class="ex-num"><input class="ex-s" type="number" inputmode="numeric" min="1" max="99" step="1" value="${esc(e.s)}" aria-label="세트 수"><span class="u">세트</span></label>
  </div>`;
}
function programHTML() {
  const d = ui.modal.draft;
  const n = d.splits.length;
  const splits = d.splits.map((sp, i) => `
    <div class="pg-split">
      <div class="parts small-parts">${PARTS.map((p) => `<button class="part ${sp.parts.includes(p) ? "on" : ""}" data-act="pg-part" data-i="${i}" data-p="${p}" aria-pressed="${sp.parts.includes(p)}"><span class="pn">${p}</span></button>`).join("")}</div>
      ${sp.ex.map((e, j) => exRowHTML(e, i, j)).join("")}
      <button class="btn ghost small left" data-act="pg-ex-add" data-i="${i}">운동 추가</button>
    </div>`).join("");
  const days = WEEK.map((w, wi) => `
    <label class="pg-dayrow"><span>${w}</span><select class="pg-day" data-w="${wi}">
      <option value="-1" ${d.sched[wi] === -1 ? "selected" : ""}>휴식</option>
      ${d.splits.map((sp, i) => `<option value="${i}" ${d.sched[wi] === i ? "selected" : ""}>${esc(splitName(sp, i))}</option>`).join("")}
    </select></label>`).join("");
  return `<h2>나의 운동법</h2>
    <div class="form">
      <div class="row2">
        <label>운동법 이름<input id="pg-name" maxlength="20" value="${esc(d.name)}" placeholder="예: 3분할"></label>
        <div class="pg-n"><span>분할 수</span><div class="stepper"><button data-act="pg-n" data-d="-1" aria-label="분할 줄이기">−</button><span>${n}분할</span><button data-act="pg-n" data-d="1" aria-label="분할 늘리기">+</button></div></div>
      </div>
      <div class="fs"><h3 class="fs-title">분할별 운동</h3>${splits}</div>
      <div class="fs"><h3 class="fs-title">요일별 계획</h3><div class="pg-days">${days}</div></div>
    </div>
    <p class="form-err" id="pg-err"></p>
    <div class="modal-actions">${S.program ? `<button class="btn ghost left-auto danger-text" data-act="pg-clear">운동법 지우기</button>` : ""}<button class="btn ghost" data-act="close-modal">취소</button><button class="btn primary" data-act="pg-save">저장</button></div>`;
}
const progTitle = (prog) => prog.name || `${prog.splits.length}분할`;
function programViewHTML(prog, withTitle = true) {
  const sched = WEEK.map((w, wi) => {
    const i = prog.sched[wi];
    const sp = prog.splits[i];
    return `<span class="pv-day ${i < 0 ? "rest" : ""}"><b>${w}</b>${i < 0 ? "<span>휴식</span>" : (sp.parts.length ? sp.parts : [`분할 ${i + 1}`]).map((p) => `<span>${p}</span>`).join("")}</span>`;
  }).join("");
  const splits = prog.splits.map((sp, i) => `
    <li><p class="pv-split-t">${esc(sp.parts.length ? sp.parts.join(" · ") : splitName(sp, i))}</p>
      ${exListHTML(sp.ex)}</li>`).join("");
  return `<div class="pv">${withTitle ? `<p class="pv-title">${esc(progTitle(prog))}</p>` : ""}
    <div class="pv-week">${sched}</div><ul class="pv-splits">${splits}</ul></div>`;
}

/* ---------- 저녁 이후 (기기 사용 마감) ---------- */
const cutoffMin = () => (S.cutoff ? parseTime(S.cutoff) : null);
// 마감 이후 시간대에 배치된, 아직 안 먹은 식품
function nightPlan() {
  const c = cutoffMin();
  if (c == null) return null;
  // 마감 이후 시간대 + 저녁 급식은 항상 포함
  const slots = buildPlan().shown.filter((s) => !s.past && (s.time >= c || s.meal === "3"));
  const counts = {};
  slots.forEach((s) => s.items.forEach((f) => { counts[f.id] = (counts[f.id] || 0) + 1; }));
  return { slots, counts, units: Object.values(counts).reduce((a, b) => a + b, 0) };
}
function nightHTML() {
  const c = cutoffMin();
  if (c == null || nowMin() < Math.min(16 * 60, c - 60)) return "";
  const np = nightPlan();
  const pre = S.today.items.some((i) => i.pre);
  if (!np.units) {
    if (!pre) return "";
    return `<div class="night done"><p><b>저녁 이후 계획을 미리 체크했어요.</b></p></div>`;
  }
  const rows = np.slots.map((s) => {
    const g = {};
    s.items.forEach((f) => { (g[f.id] ||= { f, n: 0 }).n++; });
    return `<li><span class="t">${fmtTime(s.time)}</span><span class="nl">${s.label}</span><span class="nf">${Object.values(g).map((x) => `${esc(x.f.name)}${x.n > 1 ? ` ×${x.n}` : ""}`).join(", ")}</span><span class="ng">${fmtG(s.sum)}g</span></li>`;
  }).join("");
  const sum = np.slots.reduce((a, s) => a + s.sum, 0);
  return `<div class="night">
    <div class="night-head"><h3>오늘 밤 먹을 것</h3><span class="muted small">${S.cutoff} 이후</span></div>
    <ul class="night-list">${rows}</ul>
    <div class="night-act"><button class="btn primary" data-act="precheck">모두 먹은 걸로 미리 체크 (+${fmtG(sum)}g)</button></div>
  </div>`;
}

/* ---------- 주간 리포트 ---------- */
function weekRange(offsetWeeks = -1) {
  const t = keyToUTC(S.today.date);
  const wd = new Date(t).getUTCDay();             // 0 일요일
  const monday = t - ((wd + 6) % 7) * 864e5 + offsetWeeks * 7 * 864e5;
  return Array.from({ length: 7 }, (_, i) => utcToKey(monday + i * 864e5));
}
function reportData(days = weekRange(-1)) {
  const rec = days.map((k) => ({ k, h: S.history[k] })).filter((x) => x.h && x.h.t);
  if (!rec.length) return null;
  const avg = rec.reduce((a, x) => a + x.h.e, 0) / rec.length;
  const avgT = rec.reduce((a, x) => a + x.h.t, 0) / rec.length;
  const done = rec.filter((x) => x.h.e >= x.h.t).length;
  const weakest = rec.reduce((a, x) => (x.h.e / x.h.t < a.h.e / a.h.t ? x : a));
  const foods = {};
  rec.forEach((x) => (x.h.f || []).map(foodPair).forEach(([n, g]) => {
    if (n.startsWith("급식")) n = "급식";
    foods[n] = (foods[n] || 0) + g;
  }));
  const top = Object.entries(foods).sort((a, b) => b[1] - a[1]).slice(0, 3);
  // 운동 요약
  const cnt = Object.fromEntries(PARTS.map((p) => [p, 0]));
  let gymDays = 0;
  days.forEach((k) => {
    const ps = cleanParts(S.history[k]?.parts);
    if (ps.length) gymDays++;
    ps.forEach((p) => cnt[p]++);
  });
  const most = Math.max(...Object.values(cnt));
  const mostParts = most ? PARTS.filter((p) => cnt[p] === most) : [];
  // 나의 운동법이 있으면 그 기준으로: 계획한 운동일, 운동법에 있는데 안 한 부위
  const prog = cleanProgram(S.program);
  let plan = null;
  if (prog) {
    const myParts = PARTS.filter((p) => prog.splits.some((sp) => sp.parts.includes(p)));
    plan = {
      days: prog.sched.filter((v) => v >= 0).length,
      skipped: myParts.filter((p) => !cnt[p]),
    };
  }
  return { days, rec, avg, avgT, done, weakest, top, gym: { days: gymDays, most, mostParts, plan } };
}
function gymSummary(g) {
  const head = `<b>운동</b>`;
  if (g.plan) {
    const days = g.plan.days
      ? `계획한 ${g.plan.days}일 중 ${Math.min(g.days, g.plan.days)}일${g.days > g.plan.days ? ` (계획보다 ${g.days - g.plan.days}일 더)` : ""} 했어요.`
      : `${g.days}일 했어요.`;
    if (!g.days) return `${head} ${g.plan.days ? `계획한 ${g.plan.days}일 중 운동한 날이 없어요.` : "지난주에는 운동 기록이 없어요."}`;
    const most = `가장 많이 한 부위는 ${g.mostParts.join(", ")}(${g.most}번)`;
    const skip = g.plan.skipped.length
      ? `이고, 운동법에 있는 ${eun(g.plan.skipped.join(", "))} 한 번도 안 했어요.`
      : "이에요. 운동법에 있는 부위를 모두 했어요.";
    return `${head} ${days} ${most}${skip}`;
  }
  if (!g.days) return `${head} 지난주에는 운동 기록이 없어요.`;
  return `${head} ${g.days}일 했어요. 가장 많이 한 부위는 ${g.mostParts.join(", ")}(${g.most}번)이에요.`;
}
function reportActive() {
  if (new Date(keyToUTC(S.today.date)).getUTCDay() !== 1) return false;   // 월요일에만
  const wk = weekRange(-1)[0];
  return S.reportSeen !== wk && !!reportData();
}
function reportHTML(inline) {
  const r = reportData();
  const d0 = new Date(keyToUTC(r.days[0])), d6 = new Date(keyToUTC(r.days[6]));
  const range = `${d0.getUTCMonth() + 1}월 ${d0.getUTCDate()}일–${d6.getUTCMonth() + 1}월 ${d6.getUTCDate()}일`;
  const wk = new Date(keyToUTC(r.weakest.k));
  const bars = r.days.map((k) => {
    const h = S.history[k];
    const p = h && h.t ? Math.round((h.e / h.t) * 100) : 0;
    return `<span class="day ${p >= 100 ? "full" : ""}"><span class="col"><i style="height:${Math.min(100, p)}%"></i></span><b>${WD[new Date(keyToUTC(k)).getUTCDay()]}</b></span>`;
  }).join("");
  const body = `
    <div class="cal-stats">
      <div><span>하루 평균</span><b>${fmtG(r.avg)}g</b><small>목표 ${Math.round(r.avgT)}g</small></div>
      <div><span>목표 달성</span><b>${r.done}일</b><small>기록한 ${r.rec.length}일 중</small></div>
      <div><span>가장 부족한 날</span><b>${WD[wk.getUTCDay()]}요일</b><small>${Math.round((r.weakest.h.e / r.weakest.h.t) * 100)}%</small></div>
    </div>
    <div class="week fd-week rp-week">${bars}</div>
    <div class="rp-gym"><p>${gymSummary(r.gym)}</p></div>
    ${r.top.length ? `<h3>가장 많이 먹은 것</h3><ul class="cal-foods">${r.top.map(([n, g]) => `<li><span>${esc(n)}</span><span>${fmtG(g)}g</span></li>`).join("")}</ul>` : ""}`;
  if (inline) {
    return `<div class="sec-head"><div><h2>지난주 리포트</h2><p class="sec-sub">${range}</p></div></div>${body}
      <div class="yd-actions"><button class="btn primary" data-act="report-seen">확인했어요</button></div>`;
  }
  return `<h2>지난주 리포트</h2><p class="muted">${range}</p>${body}
    <div class="modal-actions"><button class="btn ghost" data-act="back-modal">기록으로</button><button class="btn primary" data-act="close-modal">닫기</button></div>`;
}

/* ---------- 다음 날 아침, 어제 마무리 ---------- */
function ydayActive() {
  const y = S.yesterday;
  if (!y || y.done) return false;
  if (y.date !== utcToKey(keyToUTC(S.today.date) - 864e5) || nowMin() >= 12 * 60) return false;
  if (y.items?.length || cleanParts(y.parts).length || y.ex?.length) return true;
  // 어제 아무것도 기록하지 않았는데 운동법상 운동하는 날이었다면 보여 줌
  const prog = cleanProgram(S.program);
  return !!prog && prog.sched[(new Date(keyToUTC(y.date)).getUTCDay() + 6) % 7] >= 0;
}
function ydayRecalc() {
  const y = S.yesterday;
  let e = 0; const f = [];
  for (const it of y.items) {
    if (!it.eaten) continue;
    e += it.g * it.eaten;
    f.push({ n: it.name, g: r1(it.g * it.eaten) });
  }
  S.history[y.date] = { e: r1(e), t: y.t, f, parts: cleanParts(y.parts), ex: logDone(y.ex) };
}
function ydayHTML() {
  const y = S.yesterday;
  const d = new Date(keyToUTC(y.date));
  const e = S.history[y.date]?.e ?? 0;
  const pct = y.t ? Math.round((e / y.t) * 100) : 0;
  const rows = y.items.map((it, i) => {
    const dots = Array.from({ length: it.qty }, (_, k) =>
      `<button class="dot ${k < it.eaten ? "on" : ""}" data-act="ydot" data-i="${i}" data-k="${k}" aria-pressed="${k < it.eaten}" aria-label="${esc(it.name)} ${k + 1}번째 먹음"></button>`).join("");
    return `<li class="ck ${it.eaten >= it.qty ? "done" : ""}">
      <div class="ck-main"><span class="ck-name">${esc(it.name)}</span><span class="ck-meta">${it.pre ? `<span class="tag soft">미리 체크함</span> ` : ""}${fmtG(it.g)}g씩</span></div>
      <div class="dots">${dots}</div>
      <span class="ck-g">${fmtG(it.g * it.eaten)}<small>/${fmtG(it.g * it.qty)}g</small></span>
    </li>`;
  }).join("");
  return `<div class="sec-head"><div><h2>어제 기록 마무리하기</h2><p class="sec-sub">${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${WD[d.getUTCDay()]}요일</p></div>
      <p class="yd-sum"><b>${fmtG(e)}</b>/${y.t}g <span class="${pct >= 100 ? "ok" : ""}">${pct}%</span></p></div>
    ${rows ? `<ul class="ck-list">${rows}</ul>` : ""}
    ${cleanProgram(S.program) ? `<h3 class="yd-parts-h">어제 운동한 부위</h3>
    <div class="parts small-parts">${shownParts(cleanParts(y.parts)).map((p) => { const on = (y.parts || []).includes(p); return `<button class="part ${on ? "on" : ""}" data-act="ypart" data-p="${p}" aria-pressed="${on}"><span class="pn">${p}</span></button>`; }).join("")}</div>` : ""}
    ${(y.ex || []).length ? `<h3 class="yd-parts-h">어제 한 운동</h3><ul class="lx-list">${y.ex.map((e, j) => exLogRowHTML(cleanLog(e) || e, j, true)).join("")}</ul>` : ""}
    <div class="yd-actions"><button class="btn primary" data-act="yday-done">다 맞아요</button></div>`;
}

// 오늘 밤 먹을 것은 추천을 꺼도 보여 줌. 추천은 담은 식품이 있을 때만
function planBlockHTML() {
  const night = nightHTML();
  const showPlan = S.showPlan !== false;
  if (!night && !showPlan) return `<div id="plan" hidden></div>`;
  return `<section class="block plan ${showPlan ? "" : "night-only"}" id="plan">${night}${showPlan ? planHTML() : ""}</section>`;
}
function planHTML() {
  const t = target();
  const { planned } = totals();
  const p = buildPlan();
  let body;
  if (!S.today.items.length) body = "";
  else if (!p.shown.length) body = `<p class="empty">${p.leftover ? "오늘 남은 시간이 없어요." : "다 먹었어요."}</p>`;
  else body = `<ol class="timeline">${p.shown.map((s) => slotHTML(s, s === p.next)).join("")}</ol>`;

  let summary = "";
  if (t) {
    const gap = r1(t - planned);
    if (gap > 0) {
      const sug = suggest(gap);
      if (!sug.length) { summary = `<div class="plan-sum warn"><p><strong>${fmtG(gap)}g</strong> 부족해요</p><button class="chip" data-act="go-add">식품 추가하기</button></div>`; }
      else
      summary = `<div class="plan-sum warn"><p><strong>${fmtG(gap)}g</strong> 부족해요. 이만큼 더 담아 보세요</p>
        ${sug.length ? `<div class="chips">${sug.map((s) => `<button class="chip" data-act="add-food" data-id="${esc(s.f.id)}" data-n="${s.n}">${esc(s.f.name)}${s.n > 1 ? ` ×${s.n}` : ""} 담기 <span>+${fmtG(s.g)}g</span></button>`).join("")}</div>` : ""}</div>`;
    } else summary = `<div class="plan-sum ok"><p>다 먹으면 목표 달성</p></div>`;
  }
  return `<div class="sec-head"><h2>오늘의 추천</h2><button class="link" data-act="open-info">추천 기준</button></div>
    ${summary}${body}`;
}

function slotHTML(s, isNext) {
  const groups = {};
  s.items.forEach((f) => { (groups[f.id] ||= { f, n: 0 }).n++; });
  return `<li class="slot ${isNext ? "next" : ""} ${s.past ? "past" : ""}">
    <span class="t">${fmtTime(s.time)}</span>
    <div class="slot-body">
      <div class="slot-top"><span class="slot-name">${s.label}</span>${isNext ? `<span class="badge">다음</span>` : ""}${s.past ? `<span class="badge muted">시간 지남</span>` : ""}<span class="slot-g">${fmtG(s.sum)}g</span></div>
      <p class="slot-foods">${Object.values(groups).map((g) => `${esc(g.f.name)}${g.n > 1 ? ` ×${g.n}` : ""}`).join(", ")}</p>
      ${s.sum > 55 ? `<p class="slot-note">한 번에 꽤 많아요. 일부를 다른 시간에 나눠 먹어도 좋아요.</p>` : ""}
    </div></li>`;
}

function checklistHTML() {
  const items = S.today.items;
  const rows = items.map((it, i) => {
    const f = getFood(it.foodId);
    if (!f) {
      const nm = it.foodId.startsWith("meal:") ? `급식 ${MEAL_NAMES[it.foodId.slice(5)] || ""}` : "식품";
      return `<li class="ck missing"><div class="ck-main"><span class="ck-name">${esc(nm)}</span><span class="ck-meta">${!mealsLoaded ? "불러오는 중" : "정보를 찾을 수 없어요"}</span></div>
        <span></span><span></span><span></span><button class="x" data-act="remove" data-i="${i}" aria-label="빼기">×</button></li>`;
    }
    const dots = Array.from({ length: it.qty }, (_, k) =>
      `<button class="dot ${k < it.eaten ? "on" : ""}" data-act="dot" data-i="${i}" data-k="${k}" aria-pressed="${k < it.eaten}" aria-label="${esc(f.name)} ${k + 1}번째 먹음"></button>`).join("");
    return `<li class="ck ${it.eaten >= it.qty ? "done" : ""}">
      <div class="ck-main"><span class="ck-name">${esc(f.name)}</span><span class="ck-meta">${f.kind === "meal" ? `1인분 ${fmtG(f.protein)}g` : `${esc(f.serving)}당 ${fmtG(f.protein)}g`}</span></div>
      <div class="dots">${dots}</div>
      ${f.kind === "meal" ? `<div class="stepper portion"><button data-act="portion" data-i="${i}" data-d="-0.5" aria-label="먹은 양 줄이기">−</button><span>${it.portion || 1}인분</span><button data-act="portion" data-i="${i}" data-d="0.5" aria-label="먹은 양 늘리기">+</button></div>` : `<div class="stepper"><button data-act="qty" data-i="${i}" data-d="-1" aria-label="개수 줄이기">−</button><span>${it.qty}</span><button data-act="qty" data-i="${i}" data-d="1" aria-label="개수 늘리기">+</button></div>`}
      <span class="ck-g">${fmtG(itemG(it, f) * it.eaten)}<small>/${fmtG(itemG(it, f) * it.qty)}g</small></span>
      <button class="x" data-act="remove" data-i="${i}" aria-label="${esc(f.name)} 빼기">×</button>
    </li>`;
  }).join("");

  let empty = "";
  if (!items.length) {
    const r = S.routines;
    empty = `<div class="empty"><p>아직 담은 식품이 없어요.</p>
      ${S.lastItems.length || r.length ? `<div class="chips">${S.lastItems.length ? `<button class="chip" data-act="load-last">지난번 목록 불러오기</button>` : ""}${r.map((x) => `<button class="chip" data-act="load-routine" data-id="${esc(x.id)}">${esc(x.name)}</button>`).join("")}</div>` : ""}</div>`;
  }
  return `<div class="sec-head"><h2>오늘 먹을 것</h2>
      <div class="head-actions"><button class="btn ghost" data-act="open-routines">루틴</button>${items.length ? `<button class="btn ghost" data-act="clear">비우기</button>` : ""}</div></div>
    ${items.length ? `<ul class="ck-list">${rows}</ul>` : empty}`;
}

function foodsHTML() {
  const tabs = [["all", "전체"], ["meal", "급식"], ["custom", "내 식품"]];
  return `<div class="sec-head"><h2>식품 목록</h2><button class="btn ${ui.addOpen ? "ghost" : "primary"}" data-act="toggle-add">${ui.addOpen ? "닫기" : "직접 추가"}</button></div>
    ${ui.addOpen ? addFormHTML() : ""}
    <div class="filters">
      <input type="search" id="foodSearch" placeholder="식품 이름으로 찾기" value="${esc(ui.query)}" aria-label="식품 검색">
      <div class="seg-ctl" role="group" aria-label="목록 거르기">${tabs.map(([k, l]) => `<button aria-pressed="${ui.filter === k}" data-act="filter" data-f="${k}">${l}</button>`).join("")}</div>
    </div>
    <ul class="food-rows" id="foodRows">${foodRowsHTML()}</ul>`;
}

function foodRowsHTML() {
  const q = ui.query.trim().toLowerCase().replace(/\s+/g, "");
  const list = allFoods().filter((f) => ui.filter === "all" || f.source === ui.filter || (ui.filter === "meal" && f.source === "home"))
    .filter((f) => !q || f.name.toLowerCase().replace(/\s+/g, "").includes(q))
    .map((f, i) => ({ f, i, sc: f.kind === "meal" ? 99 : recentScore(f.id) }))
    .sort((a, b) => b.sc - a.sc || a.i - b.i)
    .map((x) => x.f);
  if (!list.length) {
    const msg = q ? "찾는 식품이 없어요."
      : ui.filter === "meal" ? "오늘 급식 정보가 없어요."
      : "아직 식품이 없어요.";
    return `<li class="empty">${msg}</li>`;
  }
  return list.map((f) => {
    const inList = S.today.items.find((i) => i.foodId === f.id);
    const often = f.kind !== "meal" && recentScore(f.id) >= 2 ? `<span class="tag often">자주 먹음</span>` : "";
    const tag = often;
    const kind = f.kind === "fast" ? `<span class="tag soft">빠른 흡수</span>` : f.kind === "slow" ? `<span class="tag soft">천천히 흡수</span>` : "";
    const btn = f.kind === "meal" && inList
      ? `<button class="btn add in" disabled>담김</button>`
      : `<button class="btn add ${inList ? "in" : ""}" data-act="add-food" data-id="${esc(f.id)}" data-n="1" aria-label="${esc(f.name)} 담기">${inList ? `담김 ${inList.qty}` : "담기"}</button>`;
    return `<li class="food">
      <div class="food-main"><span class="food-name">${esc(f.name)}</span>${f.source === "home" ? `<span class="tag soft">집밥</span>` : ""}${tag}${kind}<span class="food-meta">${esc(f.serving)}</span></div>
      ${f.source === "custom" ? `<span class="food-edit"><button class="link" data-act="edit-food" data-id="${esc(f.id)}">수정</button><button class="link danger" data-act="del-food" data-id="${esc(f.id)}">삭제</button></span>`
        : `<span class="food-edit"></span>`}
      ${f.source === "home" ? `<label class="home-g"><input class="hg" data-c="${f.mealCode}" type="number" inputmode="decimal" min="0" max="200" step="1" value="${fmtG(f.protein)}" aria-label="${f.name} 단백질"><span>g</span></label>` : `<span class="food-g">${fmtG(f.protein)}g</span>`}
      ${btn}
    </li>`;
  }).join("");
}

function addFormHTML() {
  const e = ui.editingFood ? S.customFoods.find((f) => f.id === ui.editingFood) : null;
  return `<div class="add-form">
    <label class="f-name">이름<input id="af-name" maxlength="30" value="${e ? esc(e.name) : ""}" placeholder="예: 초코맛 프로틴"></label>
    <label class="f-g">단백질 (g)<input id="af-protein" type="number" inputmode="decimal" min="0" max="200" step="0.1" value="${e ? e.protein : ""}" placeholder="예: 25"></label>
    <label class="f-s">1회 양<input id="af-serving" maxlength="20" value="${e ? esc(e.serving) : ""}" placeholder="예: 1스쿱"></label>
    <label class="f-k">흡수 속도<select id="af-kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${e && e.kind === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    <p class="form-err" id="af-err"></p>
    <div class="form-actions">${e ? `<button class="btn ghost" data-act="cancel-edit">취소</button>` : ""}<button class="btn primary" data-act="save-food">${e ? "수정한 내용 저장" : "목록에 추가"}</button></div>
  </div>`;
}

function mealsHTML() {
  const day = ui.mealDay;
  const d = kst(Date.now() + day * 864e5);
  const dm = mealsOn(dateKey(d));
  const codes = ["1", "2", "3"];
  let inner;
  if (!mealsLoaded) inner = `<p class="empty">불러오는 중</p>`;
  else inner = codes.map((c) => {
    const m = dm[c];
    if (!m) return `<div class="meal none"><div class="meal-head"><h3>${MEAL_NAMES[c]}</h3><span class="meal-g">정보 없음</span></div></div>`;
    const inList = day === 0 && S.today.items.find((i) => i.foodId === `meal:${c}`);
    return `<div class="meal">
      <div class="meal-head"><h3>${MEAL_NAMES[c]}</h3><span class="meal-g">${m.protein != null ? `단백질 ${fmtG(m.protein)}g` : "단백질 정보 없음"}</span></div>
      <ul class="dishes">${(m.dishes || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      ${day === 0 && m.protein != null ? `<button class="btn small ${inList ? "in" : ""}" data-act="add-food" data-id="meal:${c}" data-n="1" ${inList ? "disabled" : ""}>${inList ? "체크리스트에 있어요" : "체크리스트에 담기"}</button>` : ""}
    </div>`;
  }).join("");
  const sum = codes.reduce((a, c) => a + (dm[c]?.protein || 0), 0);
  const any = day === 0 && codes.some((c) => mealFood(c));
  const t = target();
  return `<div class="sec-head"><h2>급식</h2><button class="icon-btn side-close" data-act="close-panel" aria-label="닫기">×</button></div>
      <div class="seg-ctl wide meal-tabs" role="group" aria-label="날짜 고르기"><button aria-pressed="${day === 0}" data-act="meal-day" data-d="0">오늘</button><button aria-pressed="${day === 1}" data-act="meal-day" data-d="1">내일</button></div>
      <p class="meal-date">${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${WD[d.getUTCDay()]}요일${sum ? `, 세 끼 합계 <b>${fmtG(sum)}g</b>` : ""}</p>
      ${inner}
      ${any ? `<button class="btn ghost wide" data-act="meal-all">세 끼 모두 담기</button>` : ""}
      ${day === 1 && sum && t ? `<p class="tomorrow-note">${sum >= t ? "급식만으로 목표 달성" : `급식만으로는 <b>${fmtG(t - sum)}g</b> 부족`}</p>` : ""}
`;
}

const rankedFriends = () => friends.filter((f) => f.date === dateKey())
  .sort((a, b) => b.pct - a.pct || (b.streak || 0) - (a.streak || 0));

// bar 아래 가로 한 줄
function friendStripHTML() {
  if (!S.shareProgress) {
    return `<h2 class="fs-label">오늘 친구들</h2>
      <button class="btn small" data-act="share-on">공개하고 같이 보기</button>`;
  }
  if (friendsState === "error") {
    return `<h2 class="fs-label">오늘 친구들</h2><span class="fs-text">친구 목록을 불러오지 못했어요.</span>
      <button class="link" data-act="refresh-friends">다시 시도</button>`;
  }
  const list = rankedFriends();
  const myIdx = list.findIndex((f) => f.id === uid);
  const show = list.slice(0, 3).map((f, i) => [f, i]);
  if (myIdx >= 3) show.push([list[myIdx], myIdx]);
  const chips = show.map(([f, i]) => `
    <button class="fs-chip ${f.id === uid ? "me" : ""}" data-act="friend-detail" data-id="${esc(f.id)}" aria-label="${esc(f.nickname)} ${f.pct}% 자세히 보기">
      <span class="fs-rank">${i + 1}</span><span class="fs-name">${f.id === uid ? "나" : esc(f.nickname)}</span>
      <span class="fs-mini"><i style="width:${Math.min(100, f.pct)}%"></i></span><span class="fs-pct">${f.pct}%</span>
    </button>`).join("");
  const others = list.length - (myIdx >= 0 ? 1 : 0);
  return `<h2 class="fs-label">오늘 친구들</h2>
    <div class="fs-chips">${chips}${others ? "" : `<span class="fs-text">아직 공개한 친구가 없어요.</span>`}</div>
    <button class="link fs-all" data-act="open-friends">전체 보기${list.length > 1 ? ` (${list.length}명)` : ""}</button>`;
}

// 전체 순위 창
function friendsModalHTML() {
  const head = `<div class="fd-head"><h2>오늘 친구들</h2><button class="link" data-act="refresh-friends">새로고침</button></div>`;
  const close = `<div class="modal-actions"><button class="btn primary" data-act="close-modal">닫기</button></div>`;
  if (friendsState === "error") return `${head}<p class="muted">친구 목록을 불러오지 못했어요.</p>${close}`;
  const list = rankedFriends();
  const rows = list.map((f, i) => `
    <li class="${f.id === uid ? "me" : ""}">
      <span class="rank">${i + 1}</span>
      <span class="fname">${esc(f.nickname)}${f.id === uid ? " (나)" : ""}</span>
      <span class="fpct">${f.pct}%</span>
      <span class="fbar"><i style="width:${Math.min(100, f.pct)}%"></i></span>
      <span class="fstreak">${f.streak ? `${FLAME}${f.streak}일 연속` : ""}</span>
      <button class="link fmore" data-act="friend-detail" data-id="${esc(f.id)}">자세히 보기</button>
    </li>`).join("");
  return `${head}${list.length ? `<ol class="friend-list">${rows}</ol>` : `<p class="muted">아직 오늘 기록을 올린 친구가 없어요.</p>`}${close}`;
}

function friendHTML() {
  const me = ui.modal.id === uid;
  // 나는 공개 설정과 상관없이 내 기기의 최신 정보로 보여 줌
  const f = me && S ? { id: uid, ...myPublic(), detail: myDetail() } : friends.find((x) => x.id === ui.modal.id);
  const close = `<div class="modal-actions">${ui.modal.back ? `<button class="btn ghost" data-act="back-modal">목록으로</button>` : ""}<button class="btn primary" data-act="close-modal">닫기</button></div>`;
  if (!f) return `<h2>친구</h2><p class="muted">정보를 찾을 수 없어요.</p>${close}`;
  const top = `<div class="fd-head"><h2>${esc(f.nickname)}${me ? " (나)" : ""}</h2><span class="fd-streak ${f.streak ? "on" : "off"}">${FLAME}<b>${f.streak || 0}</b>일 연속</span></div>`;
  if (!f.detail) {
    return `${top}
      <p class="fd-pct">오늘 <b>${f.pct}%</b> 달성</p>
      <p class="note">자세한 정보를 공개하지 않았어요.</p>${close}`;
  }
  const dt = f.detail;
  const sec = (title, body, cls = "") => `<section class="fd-sec ${cls}"><h3 class="fd-sec-t">${title}</h3>${body}</section>`;
  const week = (dt.week || []).map((w) => {
    const d = new Date(keyToUTC(w.k));
    return `<span class="day ${w.p >= 100 ? "full" : ""}"><span class="col"><i style="height:${Math.min(100, w.p)}%"></i></span><b>${WD[d.getUTCDay()]}</b></span>`;
  }).join("");
  const foods = (dt.foods || []).length
    ? `<ul class="cal-foods">${dt.foods.map(foodPair).map(([n, g]) => `<li><span>${esc(n)}</span><span>${fmtG(g)}g</span></li>`).join("")}</ul>`
    : `<p class="muted small">아직 오늘 먹은 식품이 없어요.</p>`;
  const profile = `<div class="fd-profile">
      <div><span>몸무게</span><b>${dt.weight ? `${dt.weight}kg` : "-"}</b></div>
      <div><span>목표</span><b>${esc(dt.goal || "-")}</b>${dt.factor ? `<small>1kg당 ${dt.factor}g</small>` : ""}</div>
      <div><span>최고 연속</span><b>${dt.best || 0}일</b></div>
    </div>`;
  const today = sec("오늘 먹은 식품", `<div class="fd-today">
      <p class="cal-sum"><b>${fmtG(dt.e)}g</b> / ${dt.t}g <span class="${f.pct >= 100 ? "ok" : ""}">${f.pct}%</span></p>
      <div class="fd-bar"><i style="width:${Math.min(100, f.pct)}%"></i></div>
    </div>${foods}`);
  const gym = dt.parts?.length || dt.ex?.length
    ? sec("오늘 운동", `${dt.parts?.length ? `<p class="cal-parts">${dt.parts.map((x) => `<span class="pchip">${x}</span>`).join("")}</p>` : ""}${dt.ex?.length ? exListHTML(dt.ex) : ""}`)
    : "";
  return `${top}
    ${profile}
    ${sec("최근 7일", `<div class="week fd-week">${week}</div>`)}
    ${today}
    ${gym}
    ${dt.program ? sec(esc(progTitle(dt.program)), programViewHTML(dt.program, false)) : ""}
    ${dt.an ? sec("운동 분석", anSummaryHTML(dt.an)) : ""}
    ${close}`;
}
function anSummaryHTML(a) {
  const chg = a.pv ? Math.round(((a.v - a.pv) / a.pv) * 100) : null;
  const pct = (c) => `${c > 0 ? "▲" : c < 0 ? "▼" : ""}${Math.abs(c)}%`;
  const groups = [];
  a.x.forEach((x) => { let g = groups.find((y) => y.p === x.p); if (!g) groups.push((g = { p: x.p, items: [] })); g.items.push(x); });
  const rows = groups.map((g) => `<p class="pv-split-t">${esc(g.p || "기타")}</p><ul class="an-list">${g.items.map((x) => {
    const [label, cls] = STATUS[x.s];
    return `<li><span class="an-n"><b>${esc(x.n)}</b><small>${x.bw ? `총 ${Math.round(x.m)}회` : `추정 1RM ${fmtG(x.m)}kg`}</small></span>
      <span class="an-r"><span class="badge-s ${cls}">${label}</span>${x.c != null && x.s !== "new" ? `<span class="es-chg ${x.c > 0 ? "up" : x.c < 0 ? "down" : ""}">${pct(x.c)}</span>` : ""}</span></li>`;
  }).join("")}</ul>`).join("");
  return `<div class="cal-stats">
      <div><span>이번 주 볼륨</span><b>${fmtVol(a.v)}</b><small>${chg == null ? "지난주 기록 없음" : a.v ? `지난주보다 ${pct(chg)}` : `지난주 ${fmtVol(a.pv)}`}</small></div>
      <div><span>성장 중</span><b>${a.g}/${a.n}</b><small>최근 4주</small></div>
      <div><span>기록 경신</span><b>${a.pr}번</b><small>최근 30일</small></div>
    </div>
    <div class="an-groups">${rows}</div>`;
}

function historyHTML() {
  const m = ui.modal;
  const todayK = S.today.date;
  recordToday();
  const y = +m.ym.slice(0, 4), mo = +m.ym.slice(4, 6);
  const startWd = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  let cells = WD.split("").map((w) => `<span class="cal-w">${w}</span>`).join("");
  cells += `<span></span>`.repeat(startWd);
  let done = 0;
  for (let dd = 1; dd <= days; dd++) {
    const k = `${y}${pad(mo)}${pad(dd)}`;
    const future = k > todayK;
    const p = future ? 0 : dayPct(k);
    if (p >= 1) done++;
    const lvl = p >= 1 ? "l4" : p >= 0.7 ? "l3" : p >= 0.4 ? "l2" : p > 0 ? "l1" : "";
    cells += `<button class="cal-d ${lvl} ${k === m.sel ? "sel" : ""} ${k === todayK ? "today" : ""}" data-act="cal-sel" data-k="${k}" ${future ? "disabled" : ""} aria-label="${mo}월 ${dd}일${p ? ` ${Math.round(p * 100)}%` : ""}${(S.history[k]?.parts || []).length ? ", 운동함" : ""}">${dd}${(S.history[k]?.parts || []).length ? `<i class="cal-gym"></i>` : ""}</button>`;
  }
  const h = S.history[m.sel];
  const sd = new Date(keyToUTC(m.sel));
  let detail;
  const hp = cleanParts(h?.parts);
  const hex = (h?.ex || []).map(cleanEx).filter((x) => x && x.s);
  const partsLine = (hp.length ? `<p class="cal-parts"><b>운동</b>${hp.map((x) => `<span class="pchip">${x}</span>`).join("")}</p>` : "") + exListHTML(hex);
  if (!h || (!h.e && !(h.f || []).length)) detail = hp.length || hex.length ? partsLine : `<p class="muted">이 날은 기록이 없어요.</p>`;
  else {
    const pct = h.t ? Math.round((h.e / h.t) * 100) : 0;
    detail = `<p class="cal-sum"><b>${fmtG(h.e)}g</b> / ${h.t}g <span class="${pct >= 100 ? "ok" : ""}">${pct}%</span></p>
      ${partsLine}
      ${h.f && h.f.length ? `<ul class="cal-foods">${h.f.map(foodPair).map(([n, g]) => `<li><span>${esc(n)}</span><span>${fmtG(g)}g</span></li>`).join("")}</ul>` : ""}`;
  }
  const s = streakInfo();
  const curYm = todayK.slice(0, 6);
  return `<h2>기록</h2>
    <div class="cal-stats">
      <div><span>지금 연속</span><b>${s.now}일</b></div>
      <div><span>최고 연속</span><b>${s.best}일</b></div>
      <div><span>이번 달 달성</span><b>${done}일</b></div>
    </div>
    <div class="cal-nav">
      <button class="icon-btn" data-act="cal-move" data-d="-1" aria-label="이전 달">‹</button>
      <strong>${y}년 ${mo}월</strong>
      <button class="icon-btn" data-act="cal-move" data-d="1" aria-label="다음 달" ${m.ym >= curYm ? "disabled" : ""}>›</button>
    </div>
    <div class="cal">${cells}</div>
    <div class="cal-legend"><span><i class="l1"></i>조금</span><span><i class="l3"></i>70% 이상</span><span><i class="l4"></i>달성</span><span><i class="gym"></i>운동한 날</span></div>
    ${reportData() ? `<button class="btn ghost wide" data-act="open-report">지난주 리포트 보기</button>` : ""}
    <div class="cal-detail"><h3>${sd.getUTCMonth() + 1}월 ${sd.getUTCDate()}일 ${WD[sd.getUTCDay()]}요일</h3>${detail}</div>
    <div class="modal-actions"><button class="btn primary" data-act="close-modal">닫기</button></div>`;
}

function modalHTML() {
  const m = ui.modal;
  const inner = m.type === "settings" ? settingsHTML(m.first) : m.type === "routines" ? routinesHTML() : m.type === "history" ? historyHTML() : m.type === "friend" ? friendHTML() : m.type === "friends" ? friendsModalHTML() : m.type === "report" ? reportHTML(false) : m.type === "guide" ? guideHTML() : m.type === "program" ? programHTML() : m.type === "exstats" ? exStatsHTML() : infoHTML();
  return `<div class="modal-back" data-act="${m.first ? "" : "backdrop"}"><div class="modal modal-${m.type}" role="dialog" aria-modal="true">${inner}</div></div>`;
}

function settingsDraft() {
  return {
    nick: S.nickname, weight: S.weight ?? "", goal: S.goal, customFactor: S.customFactor ?? 2, rollover: S.rollover,
    workouts: S.workouts.map((w) => ({ ...w })), share: !!S.shareProgress, detail: !!S.shareDetail, cutoff: S.cutoff || "",
    showFriends: S.showFriends !== false, showPlan: S.showPlan !== false, showWorkout: S.showWorkout !== false,
  };
}
function readSettingsForm() {
  const d = ui.modal?.draft;
  if (!d || !document.getElementById("s-weight")) return;
  d.nick = val("s-nick");
  d.weight = val("s-weight");
  d.goal = document.querySelector('input[name="s-goal"]:checked')?.value || d.goal;
  d.customFactor = val("s-cf");
  d.share = !!document.getElementById("s-share")?.checked;
  d.detail = !!document.getElementById("s-detail")?.checked;
  d.cutoff = val("s-cutoff");
  d.showFriends = !!document.getElementById("s-friends")?.checked;
  d.showPlan = !!document.getElementById("s-plan")?.checked;
  d.showWorkout = !!document.getElementById("s-workout")?.checked;
  d.rollover = val("s-roll") || d.rollover;
  d.workouts = [...document.querySelectorAll(".wo-row")].map((r) => ({
    id: r.dataset.id, start: r.querySelector(".wo-start").value, end: r.querySelector(".wo-end").value,
  }));
}

function cfPreview(w, f) {
  w = parseFloat(w); f = parseFloat(f);
  if (!(f >= CF_MIN && f <= CF_MAX)) return `${CF_MIN}–${CF_MAX} 사이로 적어요`;
  return w >= 25 ? `하루 ${Math.round(w * f)}g` : "원하는 숫자를 적어요";
}
function settingsHTML(first) {
  const d = ui.modal.draft;
  const goals = Object.entries(GOALS).map(([k, g]) => `
    <label class="goal"><input type="radio" name="s-goal" value="${k}" ${d.goal === k ? "checked" : ""}>
      <span class="goal-name">${g.label}</span><span class="goal-f">1kg당 ${g.factor}g</span></label>`).join("") + `
    <label class="goal custom"><input type="radio" name="s-goal" value="custom" ${d.goal === "custom" ? "checked" : ""}>
      <span class="goal-name">직접 입력</span>
      <span class="cf-row">1kg당 <input id="s-cf" type="number" inputmode="decimal" min="${CF_MIN}" max="${CF_MAX}" step="0.1" value="${esc(d.customFactor)}" aria-label="체중 1kg당 단백질 g">g</span>
      <span class="goal-d" id="s-cf-out">${cfPreview(d.weight, d.customFactor)}</span></label>`;
  const wo = d.workouts.map((w, n) => `
    <div class="wo-row" data-id="${esc(w.id)}">
      <span class="wo-n">${n + 1}</span>
      <input type="time" class="wo-start" step="300" value="${esc(w.start)}" aria-label="${n + 1}번째 운동 시작">
      <span class="wo-sep">~</span>
      <input type="time" class="wo-end" step="300" value="${esc(w.end)}" aria-label="${n + 1}번째 운동 끝">
      <button class="x" data-act="wo-del" data-id="${esc(w.id)}" aria-label="${n + 1}번째 운동 시간 지우기">×</button>
    </div>`).join("");
  const roll = [["empty", "비워요"], ["yesterday", "전날 목록 그대로 (체크만 해제)"], ["routine", "‘매일 자동’ 루틴으로 채워요"]];
  return `<h2>${first ? "시작하기 전에" : "설정"}</h2>
    <div class="form">
      <div class="row2">
        <label>닉네임<input id="s-nick" maxlength="12" value="${esc(d.nick)}"></label>
        <label>몸무게 (kg)<input id="s-weight" type="number" inputmode="decimal" min="25" max="200" step="0.1" value="${esc(d.weight)}" placeholder="예: 65"></label>
      </div>
      <div class="fs"><h3 class="fs-title">목표</h3><div class="goals">${goals}</div>
        <button class="link left" data-act="open-info">이 숫자의 근거 보기</button></div>
      <div class="fs"><h3 class="fs-title">운동 시간</h3>
        ${wo}
        <button class="btn ghost small left" data-act="wo-add">운동 시간 추가</button></div>
      <div class="fs"><h3 class="fs-title">기기 사용 마감 시간</h3>
        <div class="row-cut"><input type="time" id="s-cutoff" step="300" value="${esc(d.cutoff)}" aria-label="기기 사용 마감 시간"><button class="link" data-act="cutoff-clear">사용 안 함</button></div></div>
      <div class="fs"><h3 class="fs-title">자정이 지나면 체크리스트를</h3>
        <select id="s-roll">${roll.map(([k, l]) => `<option value="${k}" ${d.rollover === k ? "selected" : ""} ${k === "routine" && !S.routines.length ? "disabled" : ""}>${l}</option>`).join("")}</select></div>
      <div class="fs"><h3 class="fs-title">화면</h3>
        <label class="switch-row"><span><b>오늘의 추천</b></span>
          <input type="checkbox" role="switch" class="switch" id="s-plan" ${d.showPlan ? "checked" : ""}></label>
        <label class="switch-row"><span><b>오늘 운동</b></span>
          <input type="checkbox" role="switch" class="switch" id="s-workout" ${d.showWorkout ? "checked" : ""}></label>
        <label class="switch-row"><span><b>오늘 친구들</b></span>
          <input type="checkbox" role="switch" class="switch" id="s-friends" ${d.showFriends ? "checked" : ""}></label>
      </div>
      <div class="fs"><h3 class="fs-title">친구</h3>
        <label class="switch-row"><span><b>달성률 공개</b></span>
          <input type="checkbox" role="switch" class="switch" id="s-share" ${d.share ? "checked" : ""}></label>
        <label class="switch-row ${d.share ? "" : "off"}" id="s-detail-row"><span><b>자세한 정보 공개</b></span>
          <input type="checkbox" role="switch" class="switch" id="s-detail" ${d.share && d.detail ? "checked" : ""} ${d.share ? "" : "disabled"}></label>
      </div>
      ${first ? "" : `<div class="fs danger-zone"><h3 class="fs-title">계정</h3>
        ${d.delStep ? `<p class="small">모든 기록이 지워지고 되돌릴 수 없어요.</p>
          <div class="row-inline"><input type="password" id="del-pw" autocomplete="current-password" placeholder="비밀번호" aria-label="비밀번호">
            <button class="btn danger" data-act="delete-account">영구 삭제</button><button class="btn ghost" data-act="delete-cancel">그만두기</button></div>
          <p class="form-err" id="del-err"></p>`
        : `<div class="acct-links"><button class="link left" data-act="open-guide">사용법 다시 보기</button><button class="link left" data-act="logout">로그아웃</button>${d.pwStep ? "" : `<button class="link left" data-act="pw-start">비밀번호 바꾸기</button>`}<button class="link danger left" data-act="delete-start">계정 삭제</button></div>`}
        ${d.pwStep && !d.delStep ? `<div class="pw-box">
          <input type="password" id="pw-cur" autocomplete="current-password" placeholder="지금 비밀번호" aria-label="지금 비밀번호">
          <input type="password" id="pw-new" autocomplete="new-password" placeholder="새 비밀번호 (6자 이상)" aria-label="새 비밀번호">
          <input type="password" id="pw-new2" autocomplete="new-password" placeholder="새 비밀번호 한 번 더" aria-label="새 비밀번호 확인">
          <div class="row-inline"><button class="btn primary" data-act="pw-change">비밀번호 바꾸기</button><button class="btn ghost" data-act="pw-cancel">그만두기</button></div>
          <p class="form-err" id="pw-err"></p></div>` : ""}
      </div>`}
    </div>
    <p class="form-err" id="s-err"></p>
    <div class="modal-actions"><span class="app-ver">ProFill v${APP_VERSION}</span>${first ? "" : `<button class="btn ghost" data-act="close-modal">취소</button>`}<button class="btn primary" data-act="save-settings">저장</button></div>`;
}

function guideHTML() {
  return `<h2>ProFill 사용법</h2>
    <ol class="guide">
      <li><span class="g-n">1</span><div><b>담기</b><p>급식이나 직접 추가한 식품을 <span class="g-btn">담기</span></p></div></li>
      <li><span class="g-n">2</span><div><b>체크</b><p>먹을 때마다 <span class="g-dot"></span> 누르기</p></div></li>
      <li><span class="g-n">3</span><div><b>채우기</b><p>목표를 채운 날이 이어지면 ${FLAME} 숫자가 올라가요</p></div></li>
      <li><span class="g-n">4</span><div><b>운동</b><p>운동한 부위 누르기</p></div></li>
    </ol>
    <div class="modal-actions"><button class="btn primary" data-act="guide-done">시작하기</button></div>`;
}

function routinesHTML() {
  const g = (r) => r.items.reduce((a, i) => a + (getFood(i.foodId)?.protein || 0) * i.qty, 0);
  const list = S.routines.map((r) => {
    const auto = S.rollover === "routine" && S.autoRoutineId === r.id;
    return `<li><div class="r-main"><strong>${esc(r.name)}</strong><span class="muted">식품 ${r.items.length}개, ${fmtG(g(r))}g</span></div>
      <button class="btn small" data-act="load-routine" data-id="${esc(r.id)}">담기</button>
      <button class="toggle ${auto ? "on" : ""}" data-act="auto-routine" data-id="${esc(r.id)}" aria-pressed="${auto}">매일 자동</button>
      <button class="link danger" data-act="del-routine" data-id="${esc(r.id)}">삭제</button></li>`;
  }).join("");
  return `<h2>루틴</h2>
    <div class="row-inline"><input id="r-name" maxlength="20" placeholder="예: 운동하는 날" aria-label="루틴 이름"><button class="btn primary" data-act="save-routine" ${S.today.items.length ? "" : "disabled"}>지금 체크리스트 저장</button></div>
    <ul class="routines">${list || `<li class="empty">저장한 루틴이 없어요.</li>`}</ul>
    <div class="modal-actions"><button class="btn primary" data-act="close-modal">닫기</button></div>`;
}

function infoHTML() {
  const w = parseFloat(ui.modal?.back?.draft?.weight) || S.weight;
  const goals = Object.values(GOALS).map((g) => `
    <li>
      <div class="gb-head"><strong>${g.label}</strong><span class="gb-f">${g.factor}g/kg</span>${w ? `<span class="gb-total">하루 ${Math.round(w * g.factor)}g</span>` : ""}</div>
      <p>${g.basis}</p><p class="gb-src">${g.source}</p>
    </li>`).join("");
  return `<h2>목표와 추천의 근거</h2>
    <div class="info">
      <div class="formula"><span>하루 목표</span><strong>몸무게(kg) × 목표 숫자</strong></div>
      ${w ? `<p class="muted center-t">몸무게 ${w}kg 기준으로 계산했어요</p>` : ""}
      <ul class="goal-basis">${goals}</ul>
      <h3>언제 먹으면 좋을까</h3>
      <ul class="tips">
        <li><strong>한 번에 20–40g</strong><span>한 끼에 몰아 먹기보다 나눠 먹어요.</span></li>
        <li><strong>3–4시간 간격</strong><span>하루 동안 고르게 나눠요. 간격이 5시간 넘게 벌어지면 간식을 추천해요.</span></li>
        <li><strong>운동 직후</strong><span>쉐이크처럼 빨리 흡수되는 단백질을 먼저 배치해요.</span></li>
        <li><strong>자기 전</strong><span>우유, 카제인처럼 천천히 흡수되는 단백질을 먼저 배치해요.</span></li>
      </ul>
      <p class="gb-src">시간 나누기 기준: ISSN, 2017</p>
      <p class="note">연구는 대부분 성인을 대상으로 했어요. 건강 문제가 있다면 먼저 전문가와 상의해 주세요.</p>
      <details class="refs"><summary>논문 원문 보기</summary>
        <ul>
          <li><a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC5477153/" target="_blank" rel="noopener">ISSN Position Stand: protein and exercise (2017)</a></li>
          <li><a href="https://pubmed.ncbi.nlm.nih.gov/28698222/" target="_blank" rel="noopener">Morton 외, British Journal of Sports Medicine (2018)</a></li>
          <li><a href="https://pubmed.ncbi.nlm.nih.gov/24092765/" target="_blank" rel="noopener">Helms 외, IJSNEM (2014)</a></li>
        </ul>
      </details>
    </div>
    <div class="modal-actions"><button class="btn primary" data-act="${ui.modal?.back ? "back-settings" : "close-modal"}">${ui.modal?.back ? "설정으로 돌아가기" : "닫기"}</button></div>`;
}

function renderAuth() {
  const signup = ui.authMode === "signup";
  $app.innerHTML = `<main class="auth"><div class="auth-card">
    <div class="auth-bar" aria-hidden="true"><i></i></div>
    <h1>ProFill</h1>
    <p class="muted">하루 단백질 목표를 정하고, 먹을 때마다 체크해서 채워요.</p>
    <div class="seg-ctl wide" role="group"><button aria-pressed="${!signup}" data-act="auth-mode" data-m="login">로그인</button><button aria-pressed="${signup}" data-act="auth-mode" data-m="signup">회원가입</button></div>
    <form id="authForm" class="form" novalidate>
      <label>아이디<input id="a-id" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(ui.lastId)}" placeholder="영어 소문자, 숫자, _ (3–20자)"></label>
      <label>비밀번호<input id="a-pw" type="password" autocomplete="${signup ? "new-password" : "current-password"}" placeholder="6자 이상"></label>
      ${signup ? `<label>닉네임<input id="a-nick" maxlength="12" placeholder="화면에 보일 이름"></label>` : ""}
      <p class="form-err">${esc(ui.authError)}</p>
      <button class="btn primary wide" type="submit">${signup ? "가입하고 시작하기" : "로그인"}</button>
    </form>
    ${signup ? `<p class="hint">비밀번호는 찾을 수 없으니 꼭 기억해 주세요.</p>` : ""}
  </div></main>`;
  document.getElementById("authForm").addEventListener("submit", onAuthSubmit);
}

function authMsg(code) {
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-login-credentials", "auth/invalid-email"].includes(code)) return "아이디 또는 비밀번호가 맞지 않아요.";
  if (code === "auth/email-already-in-use") return "이미 있는 아이디예요. 다른 아이디를 써 주세요.";
  if (code === "auth/weak-password") return "비밀번호는 6자 이상이어야 해요.";
  if (code === "auth/too-many-requests") return "시도가 너무 많았어요. 잠시 뒤 다시 해 주세요.";
  if (code === "auth/network-request-failed") return "인터넷 연결을 확인해 주세요.";
  if (["auth/operation-not-allowed", "auth/configuration-not-found", "auth/api-key-not-valid.-please-pass-a-valid-api-key.", "auth/unauthorized-domain"].includes(code)) return `Firebase 설정이 아직 끝나지 않았어요 (${code}). 안내서 2단계를 확인해 주세요.`;
  return `처리하지 못했어요 (${code}).`;
}

async function onAuthSubmit(e) {
  e.preventDefault();
  const id = val("a-id").trim().toLowerCase();
  const pw = val("a-pw");
  ui.lastId = id;
  if (!/^[a-z0-9_]{3,20}$/.test(id)) { ui.authError = "아이디는 영어 소문자, 숫자, _ 로 3–20자예요."; return renderAuth(); }
  if (pw.length < 6) { ui.authError = "비밀번호는 6자 이상이어야 해요."; return renderAuth(); }
  const btn = e.submitter || document.querySelector("#authForm button[type=submit]");
  btn.disabled = true; btn.textContent = "잠시만요";
  try {
    const email = `${id}@${EMAIL_DOMAIN}`;
    if (ui.authMode === "signup") {
      pendingNick = val("a-nick").trim() || id;
      await createUserWithEmailAndPassword(auth, email, pw);
    } else {
      await signInWithEmailAndPassword(auth, email, pw);
    }
    ui.authError = "";
  } catch (err) {
    ui.authError = authMsg(err.code);
    renderAuth();
  }
}

/* ---------- 알림 ---------- */
let toastTimer = null;
let undoFn = null;
function toast(msg, undo = false) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast"; el.className = "toast";
    el.setAttribute("role", "status"); el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
    el.addEventListener("click", (e) => {
      if (!e.target.closest("[data-undo]") || !undoFn) return;
      const f = undoFn; undoFn = null; f();
    });
  }
  if (!undo) undoFn = null;
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button class="toast-undo" data-undo>되돌리기</button>` : ""}`;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove("show"); undoFn = null; }, undo ? 5000 : 2200);
}
const snapshot = () => {
  const snap = JSON.parse(JSON.stringify(S));
  undoFn = () => { S = snap; save(); render(); toast("되돌렸어요"); };
};

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch (e) { /* 무시 */ }
}

/* ---------- 이벤트 ---------- */
// 바깥을 누르거나 Esc: 처음 설정 창(과 거기서 연 창)은 닫지 않음
function dismissModal() {
  if (!ui.modal || ui.modal.first) return;
  ui.modal = ui.modal.back?.first ? ui.modal.back : null;
  render();
  if (!ui.modal && remotePending) applyRemote(remotePending);
}
function commit(msg, undo = false) { save(); render(); if (msg) toast(msg, undo); }

$app.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !b.dataset.act) return;
  if (S && !writing && !saveTimer) {
    // 자정이 지났으면 먼저 새 하루로 (어제 기록에 잘못 들어가지 않게)
    if (S.today.date !== dateKey()) { tick(); return; }
    // 다른 기기에서 바뀐 내용이 기다리고 있으면 먼저 반영해서 덮어쓰지 않게 함
    const next = remotePending && migrate(JSON.parse(JSON.stringify(remotePending)));
    remotePending = null;
    if (next && stable(next) !== stable(S)) {
      S = next;
      applyTheme(S.theme);
      if (ensureToday()) save();
      if (!ui.modal?.draft) {   // 화면이 바뀌었을 수 있으니 이번 누름은 쉬고 다시 그림
        render();
        toast("다른 기기에서 바뀐 내용을 불러왔어요");
        return;
      }
    }
  }
  const act = b.dataset.act;
  const i = Number(b.dataset.i);
  const items = S?.today.items;

  switch (act) {
    case "auth-mode": ui.authMode = b.dataset.m; ui.authError = ""; return renderAuth();
    case "reload": location.reload(); return;
    case "logout": {
      if (navigator.onLine === false && (saveTimer || writing)) { toast("저장하지 않은 기록이 있어요. 인터넷에 연결된 뒤 로그아웃해 주세요."); return; }
      await Promise.race([flushSave(), new Promise((r) => setTimeout(r, 4000))]);
      await signOut(auth); return;
    }
    case "theme": S.theme = S.theme === "dark" ? "light" : "dark"; applyTheme(S.theme); return commit();
    case "panel": ui.panel = ui.panel === b.dataset.p ? null : b.dataset.p; return render();
    case "close-panel": ui.panel = null; return render();

    case "add-food": {
      const f = getFood(b.dataset.id);
      addToList(b.dataset.id, Number(b.dataset.n || 1));
      return commit(f ? `${f.name} 담았어요` : "");
    }
    case "meal-all": ["1", "2", "3"].forEach((c) => mealFood(c) && addToList(`meal:${c}`)); return commit("급식을 담았어요");
    case "dot": {
      const it = items?.[i]; const k = Number(b.dataset.k);
      if (!it) return;
      const was = totals().eaten;
      it.eaten = k < it.eaten ? k : k + 1;
      if (it.pre) { it.pre = Math.min(it.pre, it.eaten); if (!it.pre) delete it.pre; }
      const now = totals().eaten, t = target();
      return commit(t && was < t && now >= t ? "오늘 목표를 채웠어요" : "");
    }
    case "precheck": {
      const np = nightPlan();
      if (!np || !np.units) return;
      snapshot();
      let n = 0;
      for (const it of items) {
        const c = np.counts[it.foodId];
        if (!c) continue;
        const add = Math.min(c, it.qty - it.eaten);
        if (add <= 0) continue;
        it.eaten += add; it.pre = (it.pre || 0) + add; n += add;
      }
      return commit(`저녁 이후 ${n}개를 먹은 걸로 체크했어요`, true);
    }
    case "ydot": {
      const it = S.yesterday?.items?.[i]; const k = Number(b.dataset.k);
      if (!it) return;
      it.eaten = k < it.eaten ? k : k + 1;
      if (it.pre) { it.pre = Math.min(it.pre, it.eaten); if (!it.pre) delete it.pre; }
      ydayRecalc();
      return commit();
    }
    case "yday-done": if (!S.yesterday) return; S.yesterday.done = true; return commit("어제 기록을 마무리했어요");
    case "portion": {
      const it = items?.[i];
      if (!it) return;
      const p = Math.max(0.5, Math.min(2, (it.portion || 1) + Number(b.dataset.d)));
      if (p === 1) delete it.portion; else it.portion = p;
      return commit();
    }
    case "meal-day": ui.mealDay = Number(b.dataset.d); return render();
    case "share-on": S.shareProgress = true; commit("이제 친구들과 달성률을 같이 봐요"); watchFriends(); return;
    case "open-me": ui.modal = { type: "friend", id: uid }; return render();
    case "friend-detail": ui.modal = { type: "friend", id: b.dataset.id, back: ui.modal?.type === "friends" ? ui.modal : null }; return render();
    case "open-friends": ui.modal = { type: "friends" }; if (!unsubFriends) loadFriends(); return render();
    case "back-modal": ui.modal = ui.modal.back; return render();
    case "refresh-friends": friendsState = "idle"; return loadFriends();
    case "open-history": ui.modal = { type: "history", ym: S.today.date.slice(0, 6), sel: S.today.date }; return render();
    case "cal-sel": ui.modal.sel = b.dataset.k; return render();
    case "cal-move": {
      let y = +ui.modal.ym.slice(0, 4), m = +ui.modal.ym.slice(4, 6) + Number(b.dataset.d);
      if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
      const ym = `${y}${pad(m)}`;
      if (ym > S.today.date.slice(0, 6)) return;
      ui.modal.ym = ym;
      return render();
    }
    case "qty": {
      const it = items?.[i];
      if (!it) return;
      it.qty = Math.max(1, Math.min(20, it.qty + Number(b.dataset.d)));
      it.eaten = Math.min(it.eaten, it.qty);
      if (it.pre) { it.pre = Math.min(it.pre, it.eaten); if (!it.pre) delete it.pre; }
      return commit();
    }
    case "remove": { if (!items?.[i]) return; snapshot(); const f = getFood(items[i].foodId); items.splice(i, 1); return commit(`${eul(f ? f.name : "식품")} 뺐어요`, true); }
    case "clear": snapshot(); S.today.items = []; return commit("체크리스트를 비웠어요", true);
    case "load-last": mergeItems(S.lastItems); return commit("지난번 목록을 담았어요");
    case "load-routine": { const r = S.routines.find((x) => x.id === b.dataset.id); if (r) { mergeItems(r.items); ui.modal = null; commit(`‘${r.name}’ 루틴을 담았어요`); } return; }

    case "filter": ui.filter = b.dataset.f; return render();
    case "toggle-add": ui.addOpen = !ui.addOpen; ui.editingFood = null; return render();
    case "edit-food": ui.addOpen = true; ui.editingFood = b.dataset.id; render(); document.getElementById("af-name")?.focus(); return;
    case "cancel-edit": ui.editingFood = null; ui.addOpen = false; return render();
    case "save-food": {
      const name = val("af-name").trim();
      const protein = parseFloat(val("af-protein"));
      const serving = val("af-serving").trim() || "1개";
      const kind = val("af-kind") || "normal";
      const err = document.getElementById("af-err");
      if (!name) { err.textContent = "이름을 적어 주세요."; return; }
      if (!(protein > 0 && protein <= 200)) { err.textContent = "단백질은 0보다 크고 200g 이하로 적어 주세요."; return; }
      if (ui.editingFood) {
        Object.assign(S.customFoods.find((f) => f.id === ui.editingFood), { name, protein: r1(protein), serving, kind });
        ui.editingFood = null; ui.addOpen = false;
        return commit("수정한 내용을 저장했어요");
      }
      S.customFoods.unshift({ id: `c-${newId()}`, name, protein: r1(protein), serving, kind });
      ui.addOpen = false; ui.filter = "all"; ui.query = "";
      return commit(`${eul(name)} 목록에 추가했어요`);
    }
    case "del-food": {
      const f = S.customFoods.find((x) => x.id === b.dataset.id);
      if (!f) return;
      snapshot();
      S.customFoods = S.customFoods.filter((x) => x.id !== f.id);
      S.today.items = S.today.items.filter((x) => x.foodId !== f.id);
      S.lastItems = S.lastItems.filter((x) => x.foodId !== f.id);
      S.routines.forEach((r) => { r.items = r.items.filter((x) => x.foodId !== f.id); });
      return commit(`${eul(f.name)} 지웠어요`, true);
    }

    case "open-settings": ui.modal = { type: "settings", draft: settingsDraft() }; return render();
    case "open-routines": ui.modal = { type: "routines" }; return render();
    case "open-info": readSettingsForm(); ui.modal = { type: "info", back: ui.modal?.type === "settings" ? ui.modal : null }; return render();
    case "wo-add": {
      readSettingsForm();
      const list = ui.modal.draft.workouts;
      const last = list[list.length - 1];
      let start = "17:00";
      if (last && last.end) { const m = Math.min(parseTime(last.end) + 120, 22 * 60); start = fmtTime(m - (m % 5)); }
      const e = Math.min(parseTime(start) + 60, 23 * 60 + 55);
      list.push({ id: newId(), start, end: fmtTime(e) });
      render();
      [...document.querySelectorAll(".wo-start")].pop()?.focus();
      return;
    }
    case "pw-start": readSettingsForm(); ui.modal.draft.pwStep = true; render(); document.getElementById("pw-cur")?.focus(); return;
    case "pw-cancel": readSettingsForm(); ui.modal.draft.pwStep = false; return render();
    case "pw-change": {
      const cur = val("pw-cur"), nw = val("pw-new"), nw2 = val("pw-new2");
      const err = document.getElementById("pw-err");
      if (!cur) { err.textContent = "지금 비밀번호를 입력해 주세요."; return; }
      if (nw.length < 6) { err.textContent = "새 비밀번호는 6자 이상이어야 해요."; return; }
      if (nw !== nw2) { err.textContent = "새 비밀번호 두 개가 서로 달라요."; return; }
      if (nw === cur) { err.textContent = "지금 비밀번호와 다른 비밀번호를 정해 주세요."; return; }
      if (b.disabled) return;
      b.disabled = true; b.textContent = "바꾸는 중";
      const user = auth.currentUser;
      try {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, cur));
        await updatePassword(user, nw);
        readSettingsForm(); ui.modal.draft.pwStep = false; render();
        toast("비밀번호를 바꿨어요");
      } catch (e2) {
        b.disabled = false; b.textContent = "비밀번호 바꾸기";
        err.textContent = ["auth/wrong-password", "auth/invalid-credential", "auth/invalid-login-credentials"].includes(e2.code) ? "지금 비밀번호가 맞지 않아요."
          : e2.code === "auth/weak-password" ? "새 비밀번호가 너무 쉬워요. 6자 이상으로 정해 주세요."
          : e2.code === "auth/too-many-requests" ? "시도가 너무 많았어요. 잠시 뒤 다시 해 주세요."
          : `바꾸지 못했어요 (${e2.code || e2.message})`;
      }
      return;
    }
    case "delete-start": readSettingsForm(); ui.modal.draft.pwStep = false; ui.modal.draft.delStep = true; render(); document.getElementById("del-pw")?.focus(); return;
    case "delete-cancel": readSettingsForm(); ui.modal.draft.delStep = false; return render();
    case "delete-account": {
      const pw = val("del-pw");
      const err = document.getElementById("del-err");
      if (!pw) { err.textContent = "비밀번호를 입력해 주세요."; return; }
      if (b.disabled) return;
      b.disabled = true; b.textContent = "지우는 중";
      const user = auth.currentUser;
      try {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, pw));
      } catch (e2) {
        b.disabled = false; b.textContent = "영구 삭제";
        err.textContent = ["auth/wrong-password", "auth/invalid-credential", "auth/invalid-login-credentials"].includes(e2.code) ? "비밀번호가 맞지 않아요." : `확인하지 못했어요 (${e2.code})`;
        return;
      }
      const who = user.uid;
      deleting = true;
      clearTimeout(saveTimer); saveTimer = null;
      if (unsubUser) { unsubUser(); unsubUser = null; }
      stopWatching();
      try {
        await deleteDoc(doc(db, "public", who));
        await deleteDoc(doc(db, "users", who));
        await deleteUser(user);
        ui.modal = null;
        setTimeout(() => toast("계정을 삭제했어요"), 300);
      } catch (e2) {
        console.error(e2);
        deleting = false;
        err.textContent = `삭제하다 멈췄어요 (${e2.code || e2.message}). 인터넷 연결을 확인하고 다시 시도해 주세요.`;
        b.disabled = false; b.textContent = "영구 삭제";
      }
      return;
    }
    case "set": case "yset": {
      const list = act === "set" ? S.today.ex : S.yesterday?.ex;
      const e = list?.[Number(b.dataset.j)]; const k = Number(b.dataset.k);
      if (!e) return;
      e.done = k < e.done ? k : k + 1;
      if (act === "set") {
        // 세트를 하면 오늘 분할 부위도 같이 체크
        const plan = todayPlan();
        if (e.done && plan?.split) S.today.parts = cleanParts([...todayParts(), ...plan.split.parts]);
      } else {
        const plan = cleanProgram(S.program);
        const sp = plan?.splits[plan.sched[(new Date(keyToUTC(S.yesterday.date)).getUTCDay() + 6) % 7]];
        if (e.done && sp) S.yesterday.parts = cleanParts([...cleanParts(S.yesterday.parts), ...sp.parts]);
        ydayRecalc();
      }
      return commit();
    }
    case "lx-sets": {
      const e = S.today.ex?.[Number(b.dataset.j)]; if (!e) return;
      e.s = Math.max(1, Math.min(20, e.s + Number(b.dataset.d)));
      e.done = Math.min(e.done, e.s);
      return commit();
    }
    case "lx-del": {
      const j = Number(b.dataset.j); if (!S.today.ex?.[j]) return;
      snapshot(); const n = S.today.ex[j].n; S.today.ex.splice(j, 1);
      return commit(`${eul(n)} 뺐어요`, true);
    }
    case "lx-quick": {
      const q = quickAdds().find((x) => x.key === b.dataset.k); if (!q) return;
      syncTodayEx();
      q.list.forEach((e) => { const tg = progExToday(e.n); S.today.ex.push({ id: newId(), n: e.n, w: e.w, r: e.r || 10, s: Math.max(1, e.s || 3), done: 0, ...(tg ? { tw: tg.w, tr: tg.r, ts: tg.s } : {}) }); });
      return commit(`${q.list.length}개 운동을 추가했어요`);
    }
    case "lx-add": ui.lxAdd = true; ui.lxBw = false; render(); document.getElementById("lx-name")?.focus(); return;
    case "lx-add-cancel": ui.lxAdd = false; return render();
    case "lx-add-bw": {   // 다시 그리지 않고 버튼만 바꿔서 적던 이름을 지키기
      ui.lxBw = !ui.lxBw;
      b.classList.toggle("on", ui.lxBw); b.setAttribute("aria-pressed", String(ui.lxBw));
      document.getElementById("lx-name")?.focus();
      return;
    }
    case "lx-bw": {
      const e = S.today.ex?.[Number(b.dataset.j)]; if (!e) return;
      e.w = e.w == null ? (e.tw || lastOf(e.n)?.w || 0) : null;
      return commit();
    }
    case "lx-add-save": {
      const n = val("lx-name").trim(); if (!n) return;
      syncTodayEx();
      // 운동법에 같은 이름이 있으면 그 무게와 개수를 가져옴
      const ptg = progExToday(n);
      const tpl = ptg || lastOf(n);
      S.today.ex.push({ id: newId(), n: n.slice(0, 30), w: ui.lxBw ? null : tpl ? tpl.w : 0, r: tpl?.r || 10, s: tpl?.s || 3, done: 0, ...(ptg ? { tw: ptg.w, tr: ptg.r, ts: ptg.s } : {}) });
      ui.lxAdd = false;
      return commit();
    }
    case "go-add": ui.addOpen = true; ui.editingFood = null; render(); document.getElementById("af-name")?.scrollIntoView({ block: "center" }); document.getElementById("af-name")?.focus(); return;
    case "apply-next": {
      const n = b.dataset.n;
      const x = exStats().find((y) => y.n === n);
      const it = x?.nexts[Number(b.dataset.i) || 0]; if (!it?.tg) return;
      snapshot();
      if (applyNext([{ n, from: it.tg, nx: it.nx }])) return commit(`${n}: ${wLabel(it.nx.w)} × ${it.nx.r}회 × ${it.nx.s}세트로 바꿨어요`, true);
      return;
    }
    case "open-exstats": ui.modal = { type: "exstats" }; return render();
    case "part": {
      const p = b.dataset.p; if (!PARTS.includes(p)) return;
      const parts = todayParts();
      S.today.parts = parts.includes(p) ? parts.filter((x) => x !== p) : cleanParts([...parts, p]);
      return commit();
    }
    case "ypart": {
      const y = S.yesterday; const p = b.dataset.p;
      if (!y || !PARTS.includes(p)) return;
      const parts = cleanParts(y.parts);
      y.parts = parts.includes(p) ? parts.filter((x) => x !== p) : cleanParts([...parts, p]);
      const h = S.history[y.date] || (S.history[y.date] = { e: 0, t: y.t, f: [] });
      h.parts = y.parts;
      return commit();
    }
    case "open-program": ui.modal = { type: "program", draft: programDraft() }; return render();
    case "pg-n": {
      readProgramForm();
      const d = ui.modal.draft;
      const n = Math.max(1, Math.min(7, d.splits.length + Number(b.dataset.d)));
      while (d.splits.length < n) d.splits.push({ parts: [], ex: [newEx()] });
      d.splits.length = n;
      d.sched = d.sched.map((v) => (v < n ? v : -1));
      return render();
    }
    case "pg-part": {
      readProgramForm();
      const sp = ui.modal.draft.splits[i]; const p = b.dataset.p;
      if (!sp || !PARTS.includes(p)) return;
      sp.parts = sp.parts.includes(p) ? sp.parts.filter((x) => x !== p) : cleanParts([...sp.parts, p]);
      return render();
    }
    case "pg-ex-add": {
      readProgramForm();
      const sp = ui.modal.draft.splits[i]; if (!sp || sp.ex.length >= 15) return;
      sp.ex.push(newEx()); render();
      document.querySelector(`.ex-row[data-i="${i}"][data-j="${sp.ex.length - 1}"] .ex-n`)?.focus();
      return;
    }
    case "pg-ex-del": {
      readProgramForm();
      const sp = ui.modal.draft.splits[i]; if (!sp) return;
      sp.ex.splice(Number(b.dataset.j), 1); return render();
    }
    case "pg-ex-bw": {
      readProgramForm();
      const e = ui.modal.draft.splits[i]?.ex[Number(b.dataset.j)]; if (!e) return;
      e.w = e.w === null ? "" : null; return render();
    }
    case "pg-save": {
      readProgramForm();
      const d = ui.modal.draft;
      const err = document.getElementById("pg-err");
      // 빈 운동 줄은 버리고, 이름을 쓴 줄은 숫자를 확인
      for (const [i2, sp] of d.splits.entries()) {
        sp.ex = sp.ex.filter((e) => String(e.n).trim() || (e.w !== null && String(e.w) !== ""));
        for (const e of sp.ex) {
          const where = `${splitName(sp, i2)} ${String(e.n).trim() || "운동"}`;
          if (!String(e.n).trim()) { err.textContent = `${splitName(sp, i2)}에 이름이 없는 운동이 있어요.`; return; }
          if (e.w !== null && !(Number(e.w) > 0)) { err.textContent = `${where}: 무게를 적거나 맨몸을 골라 주세요.`; return; }
          if (!(Number(e.r) >= 1)) { err.textContent = `${where}: 개수를 적어 주세요.`; return; }
          if (!(Number(e.s) >= 1)) { err.textContent = `${where}: 세트 수를 적어 주세요.`; return; }
        }
      }
      const prog = cleanProgram(d);
      if (!prog) { err.textContent = "분할을 하나 이상 만들어 주세요."; return; }
      const empty = prog.splits.findIndex((x) => !x.parts.length);
      if (empty >= 0) { err.textContent = `${empty + 1}번째 분할에 운동할 부위를 골라 주세요.`; return; }
      S.program = prog;
      ui.modal = null;
      return commit("운동법을 저장했어요");
    }
    case "pg-clear": snapshot(); S.program = null; ui.modal = null; return commit("운동법을 지웠어요", true);
    case "guide-done": S.guideSeen = true; ui.modal = null; return commit();
    case "open-guide": ui.modal = { type: "guide" }; return render();
    case "report-seen": S.reportSeen = weekRange(-1)[0]; return commit();
    case "open-report": ui.modal = { type: "report", back: ui.modal }; return render();
    case "cutoff-clear": { const el = document.getElementById("s-cutoff"); if (el) el.value = ""; return; }
    case "wo-del": readSettingsForm(); ui.modal.draft.workouts = ui.modal.draft.workouts.filter((w) => w.id !== b.dataset.id); return render();
    case "back-settings": ui.modal = ui.modal.back; return render();
    case "backdrop": if (e.target === b) dismissModal(); return;
    case "close-modal": ui.modal = null; renderPending = false; render(); if (remotePending) applyRemote(remotePending); return;

    case "save-settings": {
      readSettingsForm();
      const d = ui.modal.draft;
      const err = document.getElementById("s-err");
      const weight = parseFloat(d.weight);
      if (!(weight >= 25 && weight <= 200)) { err.textContent = "몸무게를 25–200kg 사이로 적어 주세요."; return; }
      const workouts = [];
      for (const [n, w] of d.workouts.entries()) {
        if (!w.start || !w.end) { err.textContent = `${n + 1}번째 운동의 시작과 끝 시간을 골라 주세요.`; return; }
        if (parseTime(w.end) <= parseTime(w.start)) { err.textContent = `${n + 1}번째 운동의 끝 시간이 시작보다 늦어야 해요.`; return; }
        workouts.push({ id: w.id, start: w.start, end: w.end });
      }
      workouts.sort((a, b) => parseTime(a.start) - parseTime(b.start));
      const cf = parseFloat(d.customFactor);
      if (d.goal === "custom" && !(cf >= CF_MIN && cf <= CF_MAX)) { err.textContent = `직접 입력 숫자는 ${CF_MIN}–${CF_MAX} 사이로 적어 주세요.`; return; }
      if (d.goal === "custom") S.customFactor = r1(cf);
      S.nickname = d.nick.trim() || S.nickname;
      const shareChanged = S.shareProgress !== d.share || S.shareDetail !== (d.share && d.detail);
      S.shareProgress = d.share;
      if (S.showFriends !== d.showFriends) setTimeout(watchFriends, 0);
      S.showFriends = d.showFriends;
      S.showPlan = d.showPlan;
      S.showWorkout = d.showWorkout;
      S.cutoff = d.cutoff || null;
      S.shareDetail = d.share && d.detail;
      if (shareChanged) setTimeout(watchFriends, 0);
      S.weight = r1(weight); S.goal = d.goal; S.workouts = workouts;
      S.rollover = d.rollover;
      if (S.rollover === "routine" && !S.routines.some((r) => r.id === S.autoRoutineId)) S.autoRoutineId = S.routines[0]?.id ?? null;
      ui.modal = S.guideSeen ? null : { type: "guide", first: true };
      return commit("설정을 저장했어요");
    }
    case "save-routine": {
      const name = val("r-name").trim() || `루틴 ${S.routines.length + 1}`;
      S.routines.push({ id: `r-${newId()}`, name, items: S.today.items.map(slim) });
      return commit(`‘${name}’ 루틴을 저장했어요`);
    }
    case "auto-routine": {
      const on = S.rollover === "routine" && S.autoRoutineId === b.dataset.id;
      if (on) { S.rollover = "empty"; S.autoRoutineId = null; }
      else { S.rollover = "routine"; S.autoRoutineId = b.dataset.id; }
      return commit(on ? "매일 자동을 껐어요" : "자정이 지나면 이 루틴이 자동으로 들어가요");
    }
    case "del-routine": {
      const r = S.routines.find((x) => x.id === b.dataset.id);
      if (!r) return;
      snapshot();
      S.routines = S.routines.filter((x) => x.id !== r.id);
      if (S.autoRoutineId === r.id) { S.autoRoutineId = null; if (S.rollover === "routine") S.rollover = "empty"; }
      return commit(`‘${r.name}’ 루틴을 지웠어요`, true);
    }
  }
});

$app.addEventListener("change", (e) => {
  if (e.target.id === "s-share") {
    const det = document.getElementById("s-detail");
    det.disabled = !e.target.checked;
    if (!e.target.checked) det.checked = false;
    document.getElementById("s-detail-row").classList.toggle("off", !e.target.checked);
  }
});
$app.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "s-auto") {
    S.autoProgress = t.checked;
    const up = autoProgress();
    return commit(up.length ? `운동법을 올렸어요: ${up.join(", ")}` : t.checked ? "자동으로 올리기를 켰어요" : "자동으로 올리기를 껐어요");
  }
  if (t.classList.contains("hg")) {
    S.homeG = { ...(S.homeG || {}), [t.dataset.c]: r1(num(t.value, 0, 200)) };
    return commit();
  }
  if (!t.classList.contains("lx-w") && !t.classList.contains("lx-r")) return;
  const ex = S?.today.ex?.[Number(t.dataset.j)]; if (!ex) return;
  if (t.classList.contains("lx-w")) ex.w = r1(num(t.value, 0, 500));
  else ex.r = Math.max(1, Math.round(num(t.value, 1, 999)));
  save();
});
$app.addEventListener("focusin", (e) => {
  if (e.target.id === "s-cf") document.querySelector('input[name="s-goal"][value="custom"]').checked = true;
});
$app.addEventListener("input", (e) => {
  if (e.target.id === "s-cf" || e.target.id === "s-weight") {
    const out = document.getElementById("s-cf-out");
    if (out) out.textContent = cfPreview(val("s-weight"), val("s-cf"));
  }
  if (e.target.id === "foodSearch") {
    ui.query = e.target.value;
    document.getElementById("foodRows").innerHTML = foodRowsHTML();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.modal) dismissModal();
  if (e.key === "Enter" && e.target.id === "lx-name") { e.preventDefault(); document.querySelector('[data-act="lx-add-save"]')?.click(); return; }
  if (e.key === "Enter" && e.target.closest(".add-form") && e.target.tagName === "INPUT") {
    e.preventDefault(); document.querySelector('[data-act="save-food"]')?.click();
  }
});

/* ---------- 시간 흐름 ---------- */
function tick() {
  if (!S) return;
  if (remotePending) applyRemote(remotePending);
  if (renderPending) softRender();
  if (ensureToday()) {
    save(); loadMeals(); render(); watchFriends();
    toast(autoMsg || "새로운 하루예요. 체크리스트를 새로 시작했어요."); autoMsg = "";
    return;
  }
  const plan = document.getElementById("plan");
  if (plan && !ui.modal) plan.outerHTML = planBlockHTML();
}
setInterval(tick, 30000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { flushSave(); return; }
  tick();
  if (S) watchFriends();
});
window.addEventListener("pagehide", () => { flushSave(); });

/* ---------- 로그인 상태 ---------- */
// 키 순서와 상관없이 같은 내용인지 비교
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`
  : JSON.stringify(v ?? null));
let unsubUser = null;
let remotePending = null;
// 다른 기기(예: 학교 컴퓨터)에서 바꾼 내용을 실시간으로 받아옴
function applyRemote(data) {
  if (!S || writing || saveTimer) { remotePending = data; return; }
  if (stable(data) === stable(S)) { remotePending = null; return; }
  if (isTyping() || ui.modal?.draft) { remotePending = data; return; }
  remotePending = null;
  S = migrate(data);
  applyTheme(S.theme);
  if (ensureToday()) save();
  render();
  watchFriends();
}
onAuthStateChanged(auth, async (user) => {
  loadError = false;
  if (unsubUser) { unsubUser(); unsubUser = null; }
  stopWatching();
  if (!user) {
    deleting = false;
    uid = null; S = null; ui.modal = null; ui.panel = null; lastFillPct = 0;
    friends = []; publicOn = null; remotePending = null;
    render(); return;
  }
  uid = user.uid; S = null; render();
  try {
    const ref = doc(db, "users", uid);
    const userDoc = navigator.onLine === false ? getDocFromCache(ref).catch(() => getDoc(ref)) : getDoc(ref);
    const [snap] = await Promise.all([userDoc, mealsReady || loadMeals()]);
    if (uid !== user.uid) return;
    const isNew = !snap.exists();
    S = isNew ? freshData(pendingNick || user.email.split("@")[0]) : migrate(snap.data());
    applyTheme(S.theme);
    if (ensureToday() || isNew) save();
    if (!S.weight) ui.modal = { type: "settings", first: true, draft: settingsDraft() };
    render();
    if (autoMsg) { setTimeout(() => toast(autoMsg), 400); setTimeout(() => { autoMsg = ""; }, 500); }
    watchFriends();
    unsubUser = onSnapshot(doc(db, "users", uid), (sn) => {
      if (!sn.exists() || sn.metadata.hasPendingWrites || sn.metadata.fromCache) return;
      applyRemote(sn.data());
    }, (e) => console.warn("sync", e));
  } catch (e) {
    console.error(e);
    loadError = true; render();
  }
});

loadMeals();
