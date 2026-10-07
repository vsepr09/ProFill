import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, doc, getDoc, setDoc, deleteDoc,
  collection, getDocs, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { GOALS, KINDS, DEFAULT_FOODS } from "./data.js";

/* ---------- Firebase ---------- */
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, { localCache: persistentLocalCache(), ignoreUndefinedProperties: true });
const EMAIL_DOMAIN = "iasa-protein.app"; // 아이디를 이메일 형식으로 바꿀 때만 쓰임 (메일은 보내지 않음)

/* ---------- 상태 ---------- */
const $app = document.getElementById("app");
let uid = null;
let S = null;            // 사용자 데이터 (Firestore users/{uid})
let loadError = false;
let pendingNick = "";
let meals = { days: {} };
let mealsLoaded = false;
let lastFillPct = 0;
let sharedFoods = [];      // 친구들과 공유한 식품 (sharedFoods 컬렉션)
let sharedState = "idle";  // idle | ok | error
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
const val = (id) => document.getElementById(id)?.value ?? "";

/* ---------- 데이터 ---------- */
function freshData(nickname) {
  return {
    nickname, weight: null, goal: "bulk", customFactor: 2, workouts: [], hiddenDefaults: [],
    theme: document.documentElement.dataset.theme || "light",
    rollover: "empty", customFoods: [], routines: [], autoRoutineId: null,
    today: { date: dateKey(), items: [] }, lastItems: [], history: {},
    shareProgress: false, shareDetail: false,
  };
}
function migrate(d) {
  const base = freshData(d.nickname || "나");
  const out = { ...base, ...d };
  if (!out.today || !Array.isArray(out.today.items)) out.today = base.today;
  if (!Array.isArray(d.workouts)) out.workouts = d.workout ? [{ id: newId(), ...d.workout }] : [];
  delete out.workout;
  if (!Array.isArray(out.hiddenDefaults)) out.hiddenDefaults = [];
  return out;
}

let saveTimer = null;
function recordToday() {
  const f = [];
  for (const it of S.today.items) {
    const food = getFood(it.foodId);
    if (food && it.eaten) f.push([food.name, r1(itemG(it, food) * it.eaten)]);
  }
  S.history[S.today.date] = { e: totals().eaten, t: target(), f };
  const keys = Object.keys(S.history).sort();
  while (keys.length > 370) delete S.history[keys.shift()];
}
function save() {
  if (!S || !uid) return;
  recordToday();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await setDoc(doc(db, "users", uid), S); }
    catch (e) { console.error(e); toast("저장하지 못했어요. 인터넷 연결을 확인해 주세요."); }
    syncPublic();
  }, 500);
}
// 친구 보기: 공개를 켠 사람만 닉네임, 오늘 달성률, 연속 기록을 올림
function myPublic() {
  const t = target();
  const st = streakInfo();
  const out = { nickname: S.nickname, date: S.today.date, pct: t ? Math.round((totals().eaten / t) * 100) : 0, streak: st.now, updatedAt: Date.now(), detail: null };
  if (S.shareDetail) {
    recordToday();
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const k = dateKey(kst(Date.now() - i * 864e5));
      week.push({ k, p: Math.round(dayPct(k) * 100) });
    }
    out.detail = {
      e: totals().eaten, t, foods: S.history[S.today.date]?.f || [], week, best: st.best,
      weight: S.weight, goal: S.goal === "custom" ? "직접 입력" : (GOALS[S.goal] || GOALS.bulk).label, factor: goalInfo().factor,
    };
  }
  return out;
}
async function syncPublic() {
  try {
    if (S.shareProgress) {
      const mine = myPublic();
      await setDoc(doc(db, "public", uid), mine);
      friends = [{ id: uid, ...mine }, ...friends.filter((x) => x.id !== uid)];
      updateFriends();
    } else {
      await deleteDoc(doc(db, "public", uid));
    }
  } catch (e) { console.warn("public", e); }
}

// 자정이 지났으면 새 하루로 바꿈
function ensureToday() {
  const k = dateKey();
  if (S.today.date === k) return false;
  if (S.today.items.length) S.lastItems = S.today.items.map(slim);
  let items = [];
  if (S.rollover === "routine") {
    const r = S.routines.find((r) => r.id === S.autoRoutineId);
    if (r) items = r.items.map((i) => ({ ...slim(i), eaten: 0 }));
  } else if (S.rollover === "yesterday") {
    items = S.lastItems.map((i) => ({ ...slim(i), eaten: 0 }));
  }
  S.today = { date: k, items };
  return true;
}

async function loadMeals() {
  try {
    const r = await fetch(`data/meals.json?t=${Date.now()}`, { cache: "no-store" });
    if (r.ok) meals = await r.json();
  } catch (e) { /* 급식 파일이 없어도 나머지는 동작 */ }
  mealsLoaded = true;
  if (S) render();
}
const todayMeals = () => (meals.days || {})[dateKey()] || {};
const mealsOn = (k) => (meals.days || {})[k] || {};

async function loadShared() {
  try {
    const snap = await getDocs(collection(db, "sharedFoods"));
    sharedFoods = snap.docs.map((d) => ({ ...d.data(), docId: d.id, id: `s:${d.id}` }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    sharedState = "ok";
  } catch (e) { console.warn("shared", e); sharedState = "error"; }
  const rows = document.getElementById("foodRows");
  if (rows) rows.innerHTML = foodRowsHTML();
  const cl = document.querySelector(".checklist");
  if (cl && S.today.items.some((i) => i.foodId.startsWith("s:"))) render();
}
async function loadFriends() {
  if (!S?.shareProgress) { friends = []; friendsState = "idle"; updateFriends(); return; }
  try {
    const snap = await getDocs(query(collection(db, "public"), where("date", "==", dateKey())));
    friends = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((f) => f.id !== uid);
    friends.unshift({ id: uid, ...myPublic() });
    friendsState = "ok";
  } catch (e) { console.warn("friends", e); friendsState = "error"; }
  updateFriends();
}
function updateFriends() {
  const el = document.getElementById("friends");
  if (el) el.innerHTML = friendsHTML();
}

/* ---------- 식품 ---------- */
function mealFood(code) {
  const m = todayMeals()[code];
  if (!m || m.protein == null) return null;
  return { id: `meal:${code}`, name: `급식 ${MEAL_NAMES[code]}`, serving: "1끼", protein: m.protein, kind: "meal", mealCode: String(code), source: "meal" };
}
function allFoods() {
  return [
    ...["1", "2", "3"].map(mealFood).filter(Boolean),
    ...S.customFoods.map((f) => ({ ...f, source: "custom" })),
    ...sharedFoods.map((f) => ({ ...f, source: "shared" })),
    ...DEFAULT_FOODS.filter((f) => !S.hiddenDefaults.includes(f.id)).map((f) => ({ ...f, source: "default" })),
  ];
}
function getFood(id) {
  if (id.startsWith("meal:")) return mealFood(id.slice(5));
  const c = S.customFoods.find((f) => f.id === id);
  if (c) return { ...c, source: "custom" };
  if (id.startsWith("s:")) { const sh = sharedFoods.find((f) => f.id === id); return sh ? { ...sh, source: "shared" } : null; }
  const d = DEFAULT_FOODS.find((f) => f.id === id);
  return d ? { ...d, source: "default" } : null;
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
    const end = Math.min(parseTime(w.start) + w.duration, 23 * 60 + 50);
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
  return allFoods()
    .filter((f) => f.kind !== "meal" && f.protein >= 5)
    .map((f) => { const n = Math.ceil(gap / f.protein); return { f, n, over: f.protein * n - gap }; })
    .filter((o) => o.n <= 3)
    .sort((a, b) => a.n - b.n || a.over - b.over)
    .slice(0, 3);
}

/* ---------- 화면 ---------- */
const ICON_MOON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M20.7 14.6A8.5 8.5 0 0 1 9.4 3.3a8.5 8.5 0 1 0 11.3 11.3Z"/></svg>`;
const FLAME = `<svg class="flame" viewBox="0 0 24 28" aria-hidden="true"><path class="fl-out" d="M12.4 1.2c.9 3.8 4.9 6.6 6.3 10.3 1.8 4.6-.4 10.1-4.6 11.9a8.1 8.1 0 0 1-9.8-3.2c-2-3.2-1.6-7.6.9-10.4.5 1.5 1.4 2.7 2.6 3.4-.6-4.6 1.4-9 4.6-12Z"/><path class="fl-in" d="M12.1 13.4c1.5 1.8 3.6 3.2 3.3 6a3.6 3.6 0 0 1-7.1.5c-.3-1.6.3-3.1 1.4-4.1.2.8.6 1.4 1.2 1.8-.1-1.6.3-3 1.2-4.2Z"/></svg>`;
const ICON_SUN = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g></svg>`;

function render() {
  if (!uid) return renderAuth();
  if (loadError) {
    $app.innerHTML = `<main class="center"><p>기록을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.</p><button class="btn primary" data-act="reload">다시 시도</button></main>`;
    return;
  }
  if (!S) { $app.innerHTML = `<main class="center"><p class="muted">불러오는 중</p></main>`; return; }
  $app.innerHTML = `
    ${headerHTML()}
    <main class="wrap">
      <section class="hero" id="hero">${heroHTML()}</section>
      <div class="layout">
        <div class="main-col">
          <section class="block plan" id="plan">${planHTML()}</section>
          <section class="block checklist">${checklistHTML()}</section>
          <section class="block foods">${foodsHTML()}</section>
        </div>
        <aside class="side">
          <section class="panel meal-panel ${ui.panel === "meal" ? "open" : ""}" aria-label="급식">${mealsHTML()}</section>
          <section class="panel friends-panel ${ui.panel === "friends" ? "open" : ""}" aria-label="친구" id="friends">${friendsHTML()}</section>
        </aside>
      </div>
    </main>
    ${ui.panel ? `<div class="side-back" data-act="close-panel"></div>` : ""}
    ${ui.modal ? modalHTML() : ""}`;
  animateFill();
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
  const d = kst();
  return `<header class="top"><div class="wrap top-in">
    <div class="brand"><span class="brand-mark" aria-hidden="true"></span>ProFill</div>
    <div class="top-date">${esc(S.nickname)}님, ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${WD[d.getUTCDay()]}요일</div>
    <nav class="top-actions">
      <button class="btn ghost panel-toggle" data-act="panel" data-p="meal">급식</button>
      <button class="btn ghost panel-toggle" data-act="panel" data-p="friends">친구</button>
      <button class="btn ghost" data-act="open-history">기록</button>
      <button class="icon-btn" data-act="theme" aria-label="${S.theme === "dark" ? "라이트 모드로" : "다크 모드로"}" title="${S.theme === "dark" ? "라이트 모드" : "다크 모드"}">${S.theme === "dark" ? ICON_SUN : ICON_MOON}</button>
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
    segs += `<div class="seg c${ci++ % 5}" style="width:${(g / eaten) * 100}%" title="${esc(f.name)} ${fmtG(g)}g"><span>${esc(f.name)}</span></div>`;
  }
  const left = r1(t - eaten);
  const status = !t ? "몸무게를 입력하면 목표가 나와요" : left > 0 ? `${fmtG(left)}g 남았어요` : "오늘 목표를 채웠어요";
  const step = max > 300 ? 100 : 50;
  let labels = "";
  for (let g = step; g < max; g += step) labels += `<span style="left:${pct(g)}%">${g}</span>`;
  const goal = goalInfo();
  return `
    <div class="hero-head">
      <div class="big"><span class="num">${fmtG(eaten)}</span><span class="of">/ ${t || "–"}g</span></div>
      <div class="hero-meta">
        <p class="status ${t && left <= 0 ? "done" : ""}">${status}</p>
        <p class="muted">${t ? `${goal.label} 목표, ${S.weight}kg × ${goal.factor}g` : ""}${planned > eaten ? `<br>체크리스트를 다 먹으면 ${fmtG(planned)}g` : ""}</p>
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
    </div>`;
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
  return `<button class="streak ${state}" data-act="open-history" title="${label}" aria-label="${label}">${FLAME}<b>${s.now}</b></button>`;
}

function planHTML() {
  const t = target();
  const { planned } = totals();
  const p = buildPlan();
  let body;
  if (!S.today.items.length) body = `<p class="empty">아래 목록에서 오늘 먹을 식품을 담으면, 언제 무엇을 먹으면 좋을지 시간대별로 나눠 드려요.</p>`;
  else if (!p.shown.length) body = `<p class="empty">${p.leftover ? "오늘 남은 시간이 거의 없어요. 남은 식품은 내일 루틴에 넣어 보세요." : "체크리스트를 모두 먹었어요."}</p>`;
  else body = `<ol class="timeline">${p.shown.map((s) => slotHTML(s, s === p.next)).join("")}</ol>`;

  let summary = "";
  if (t && S.today.items.length) {
    const gap = r1(t - planned);
    if (gap > 0) {
      const sug = suggest(gap);
      summary = `<div class="plan-sum warn"><p>체크리스트를 다 먹어도 목표보다 <strong>${fmtG(gap)}g</strong> 부족해요.${sug.length ? " 이렇게 채울 수 있어요." : ""}</p>
        ${sug.length ? `<div class="chips">${sug.map((s) => `<button class="chip" data-act="add-food" data-id="${s.f.id}" data-n="${s.n}">${esc(s.f.name)}${s.n > 1 ? ` ×${s.n}` : ""} 담기 <span>+${fmtG(s.f.protein * s.n)}g</span></button>`).join("")}</div>` : ""}</div>`;
    } else summary = `<div class="plan-sum ok"><p>체크리스트를 다 먹으면 목표를 채워요.</p></div>`;
  }
  return `<div class="sec-head"><h2>오늘의 추천</h2><button class="link" data-act="open-info">추천 기준</button></div>
    ${summary}${body}
    ${S.workouts.length ? "" : `<p class="hint">설정에서 운동 시간을 넣으면 운동 직후에 먹을 것도 챙겨 드려요.</p>`}`;
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
    if (!f) return "";
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
    empty = `<div class="empty"><p>아직 담은 식품이 없어요.${S.lastItems.length || r.length ? " 한 번에 불러올 수도 있어요." : ""}</p>
      ${S.lastItems.length || r.length ? `<div class="chips">${S.lastItems.length ? `<button class="chip" data-act="load-last">지난번 목록 불러오기</button>` : ""}${r.map((x) => `<button class="chip" data-act="load-routine" data-id="${x.id}">${esc(x.name)}</button>`).join("")}</div>` : ""}</div>`;
  }
  const { planned } = totals();
  return `<div class="sec-head"><div><h2>오늘 먹을 것</h2><p class="sec-sub">${items.length ? `식품 ${items.length}가지, 다 먹으면 ${fmtG(planned)}g` : "아래 목록에서 골라 담아요"}</p></div>
      <div class="head-actions"><button class="btn ghost" data-act="open-routines">루틴</button>${items.length ? `<button class="btn ghost" data-act="clear">비우기</button>` : ""}</div></div>
    ${items.length ? `<p class="hint hint-top">먹을 때마다 동그라미를 눌러 체크해요.</p><ul class="ck-list">${rows}</ul>` : empty}`;
}

function foodsHTML() {
  const tabs = [["all", "전체"], ["meal", "급식"], ["custom", "내가 추가"], ["shared", "공유"], ["default", "기본"]];
  const hidden = S.hiddenDefaults.length;
  return `<div class="sec-head"><div><h2>단백질 식품 목록</h2><p class="sec-sub">여기서 골라 ‘오늘 먹을 것’에 담아요</p></div><button class="btn ${ui.addOpen ? "ghost" : "primary"}" data-act="toggle-add">${ui.addOpen ? "닫기" : "직접 추가"}</button></div>
    ${ui.addOpen ? addFormHTML() : ""}
    <div class="filters">
      <input type="search" id="foodSearch" placeholder="식품 이름으로 찾기" value="${esc(ui.query)}" aria-label="식품 검색">
      <div class="seg-ctl" role="group" aria-label="목록 거르기">${tabs.map(([k, l]) => `<button aria-pressed="${ui.filter === k}" data-act="filter" data-f="${k}">${l}</button>`).join("")}</div>
    </div>
    <ul class="food-rows" id="foodRows">${foodRowsHTML()}</ul>
    <p class="hint">기본 식품의 단백질 양은 대략적인 값이에요. 먹는 제품의 포장지 값과 다르면 직접 추가해 주세요.</p>
    <div class="foods-foot">
      ${hidden < DEFAULT_FOODS.length ? `<button class="link danger" data-act="hide-all-defaults">기본 식품 모두 지우기</button>` : ""}
      ${hidden ? `<button class="link" data-act="restore-defaults">지운 기본 식품 되살리기 (${hidden}개)</button>` : ""}
    </div>`;
}

function foodRowsHTML() {
  const q = ui.query.trim();
  const list = allFoods().filter((f) => ui.filter === "all" || f.source === ui.filter).filter((f) => !q || f.name.includes(q));
  if (!list.length) {
    const msg = q ? "찾는 식품이 없어요. ‘직접 추가’로 등록해 보세요."
      : ui.filter === "custom" ? "직접 추가한 식품이 없어요. 자주 먹는 보충제나 간식을 ‘직접 추가’로 등록해 보세요."
      : ui.filter === "meal" ? "오늘 급식 정보가 없어요."
      : ui.filter === "shared" ? (sharedState === "error" ? "공유 목록을 불러오지 못했어요. Firestore 규칙을 새로 게시했는지 확인해 주세요." : "아직 공유된 식품이 없어요. ‘직접 추가’에서 ‘친구들과 공유하기’를 체크해 보세요.")
      : "목록이 비어 있어요.";
    return `<li class="empty">${msg}</li>`;
  }
  return list.map((f) => {
    const inList = S.today.items.find((i) => i.foodId === f.id);
    const tag = f.source === "custom" ? `<span class="tag">내 식품</span>` : f.source === "shared" ? `<span class="tag shared">공유</span>` : "";
    const kind = f.kind === "fast" ? `<span class="tag soft">빠른 흡수</span>` : f.kind === "slow" ? `<span class="tag soft">천천히 흡수</span>` : "";
    const btn = f.kind === "meal" && inList
      ? `<button class="btn add in" disabled>담김</button>`
      : `<button class="btn add ${inList ? "in" : ""}" data-act="add-food" data-id="${f.id}" data-n="1" aria-label="${esc(f.name)} 담기">${inList ? `담김 ${inList.qty}` : "담기"}</button>`;
    return `<li class="food">
      <div class="food-main"><span class="food-name">${esc(f.name)}</span>${tag}${kind}<span class="food-meta">${esc(f.serving)}${f.source === "shared" ? `, ${esc(f.byName || "친구")}${f.by === uid ? " (나)" : ""}` : ""}</span></div>
      ${f.source === "custom" ? `<span class="food-edit"><button class="link" data-act="edit-food" data-id="${f.id}">수정</button><button class="link danger" data-act="del-food" data-id="${f.id}">삭제</button></span>`
        : f.source === "shared" && f.by === uid ? `<span class="food-edit"><button class="link danger" data-act="del-shared" data-id="${f.id}">삭제</button></span>`
        : f.source === "default" ? `<span class="food-edit"><button class="link danger" data-act="hide-default" data-id="${f.id}">삭제</button></span>` : `<span class="food-edit"></span>`}
      <span class="food-g">${fmtG(f.protein)}g</span>
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
    ${e ? "" : `<label class="check f-share"><input type="checkbox" id="af-share"> 친구들과 공유하기 (모두의 ‘공유’ 목록에 보여요)</label>`}
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
      <ul>${(m.dishes || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
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
      ${day === 1 && sum && t ? `<p class="tomorrow-note">${sum >= t ? "내일은 급식만 다 먹어도 목표를 채울 수 있어요." : `내일은 급식을 다 먹어도 <b>${fmtG(t - sum)}g</b>이 모자라요. 보충제를 미리 챙겨 두세요.`}</p>` : ""}
`;
}

function friendsHTML() {
  const head = `<div class="sec-head"><h2>오늘 친구들</h2><div class="head-actions">${S.shareProgress ? `<button class="link" data-act="refresh-friends">새로고침</button>` : ""}<button class="icon-btn side-close" data-act="close-panel" aria-label="닫기">×</button></div></div>`;
  if (!S.shareProgress) {
    return `${head}<p class="small muted">내 달성률을 공개하면, 공개한 친구들의 오늘 달성률과 연속 기록을 같이 볼 수 있어요.</p>
      <button class="btn primary small" data-act="share-on">공개하고 같이 보기</button>`;
  }
  if (friendsState === "error") return `${head}<p class="small muted">친구 목록을 불러오지 못했어요. Firestore 규칙을 새로 게시했는지 확인해 주세요.</p>`;
  const list = friends.filter((f) => f.date === dateKey()).sort((a, b) => b.pct - a.pct || (b.streak || 0) - (a.streak || 0));
  const rows = list.map((f, i) => `
    <li class="${f.id === uid ? "me" : ""}">
      <span class="rank">${i + 1}</span>
      <span class="fname">${esc(f.nickname)}${f.id === uid ? " (나)" : ""}</span>
      <span class="fpct">${f.pct}%</span>
      <span class="fbar"><i style="width:${Math.min(100, f.pct)}%"></i></span>
      <span class="fstreak">${f.streak ? `${FLAME}${f.streak}일 연속` : ""}</span>
      <button class="link fmore" data-act="friend-detail" data-id="${esc(f.id)}">자세히 보기</button>
    </li>`).join("");
  return `${head}${list.length ? `<ol class="friend-list">${rows}</ol>` : `<p class="small muted">아직 오늘 기록을 올린 친구가 없어요.</p>`}
    <p class="hint">공개 범위는 설정에서 바꿀 수 있어요.</p>`;
}

function friendHTML() {
  const f = friends.find((x) => x.id === ui.modal.id);
  const close = `<div class="modal-actions"><button class="btn primary" data-act="close-modal">닫기</button></div>`;
  if (!f) return `<h2>친구</h2><p class="muted">정보를 찾을 수 없어요.</p>${close}`;
  const me = f.id === uid;
  const top = `<div class="fd-head"><h2>${esc(f.nickname)}${me ? " (나)" : ""}</h2><span class="fd-streak ${f.streak ? "on" : "off"}">${FLAME}<b>${f.streak || 0}</b>일 연속</span></div>`;
  if (!f.detail) {
    return `${top}
      <p class="fd-pct">오늘 <b>${f.pct}%</b> 달성</p>
      <p class="note">${me ? "자세한 정보를 공개하지 않고 있어요. 설정의 ‘자세한 정보 공개’를 켜면 친구들이 볼 수 있어요." : `${esc(f.nickname)}님은 자세한 정보를 공개하지 않았어요.`}</p>${close}`;
  }
  const dt = f.detail;
  const week = (dt.week || []).map((w) => {
    const d = new Date(keyToUTC(w.k));
    return `<span class="day ${w.p >= 100 ? "full" : ""}"><span class="col"><i style="height:${Math.min(100, w.p)}%"></i></span><b>${WD[d.getUTCDay()]}</b></span>`;
  }).join("");
  const foods = (dt.foods || []).length
    ? `<ul class="cal-foods">${dt.foods.map(([n, g]) => `<li><span>${esc(n)}</span><span>${fmtG(g)}g</span></li>`).join("")}</ul>`
    : `<p class="muted small">아직 오늘 먹은 식품이 없어요.</p>`;
  return `${top}
    ${dt.weight ? `<div class="fd-profile">
      <div><span>몸무게</span><b>${dt.weight}kg</b></div>
      <div><span>목표</span><b>${esc(dt.goal || "")}</b><small>1kg당 ${dt.factor}g</small></div>
    </div>` : ""}
    <div class="fd-today">
      <p class="cal-sum"><b>${fmtG(dt.e)}g</b> / ${dt.t}g <span class="${f.pct >= 100 ? "ok" : ""}">${f.pct}%</span></p>
      <div class="fd-bar"><i style="width:${Math.min(100, f.pct)}%"></i></div>
    </div>
    <div class="cal-stats two">
      <div><span>지금 연속</span><b>${f.streak || 0}일</b></div>
      <div><span>최고 연속</span><b>${dt.best || 0}일</b></div>
    </div>
    <h3>최근 7일</h3>
    <div class="week fd-week">${week}</div>
    <h3>오늘 먹은 식품</h3>
    ${foods}
    ${close}`;
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
    cells += `<button class="cal-d ${lvl} ${k === m.sel ? "sel" : ""} ${k === todayK ? "today" : ""}" data-act="cal-sel" data-k="${k}" ${future ? "disabled" : ""} aria-label="${mo}월 ${dd}일${p ? ` ${Math.round(p * 100)}%` : ""}">${dd}</button>`;
  }
  const h = S.history[m.sel];
  const sd = new Date(keyToUTC(m.sel));
  let detail;
  if (!h || (!h.e && !(h.f || []).length)) detail = `<p class="muted">이 날은 기록이 없어요.</p>`;
  else {
    const pct = h.t ? Math.round((h.e / h.t) * 100) : 0;
    detail = `<p class="cal-sum"><b>${fmtG(h.e)}g</b> / ${h.t}g <span class="${pct >= 100 ? "ok" : ""}">${pct}%</span></p>
      ${h.f && h.f.length ? `<ul class="cal-foods">${h.f.map(([n, g]) => `<li><span>${esc(n)}</span><span>${fmtG(g)}g</span></li>`).join("")}</ul>` : `<p class="muted small">이 날은 먹은 식품 목록이 남아 있지 않아요.</p>`}`;
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
    <div class="cal-legend"><span><i class="l1"></i>조금</span><span><i class="l3"></i>70% 이상</span><span><i class="l4"></i>달성</span></div>
    <div class="cal-detail"><h3>${sd.getUTCMonth() + 1}월 ${sd.getUTCDate()}일 ${WD[sd.getUTCDay()]}요일</h3>${detail}</div>
    <div class="modal-actions"><button class="btn primary" data-act="close-modal">닫기</button></div>`;
}

function modalHTML() {
  const m = ui.modal;
  const inner = m.type === "settings" ? settingsHTML(m.first) : m.type === "routines" ? routinesHTML() : m.type === "history" ? historyHTML() : m.type === "friend" ? friendHTML() : infoHTML();
  return `<div class="modal-back" data-act="${m.first ? "" : "backdrop"}"><div class="modal" role="dialog" aria-modal="true">${inner}</div></div>`;
}

function settingsDraft() {
  return {
    nick: S.nickname, weight: S.weight ?? "", goal: S.goal, customFactor: S.customFactor ?? 2, rollover: S.rollover,
    workouts: S.workouts.map((w) => ({ ...w })), share: !!S.shareProgress, detail: !!S.shareDetail,
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
  d.rollover = val("s-roll") || d.rollover;
  d.workouts = [...document.querySelectorAll(".wo-row")].map((r) => ({
    id: r.dataset.id, start: r.querySelector(".wo-start").value, duration: r.querySelector(".wo-dur").value,
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
      <span class="goal-name">${g.label}</span><span class="goal-f">1kg당 ${g.factor}g</span><span class="goal-d">${g.desc}</span></label>`).join("") + `
    <label class="goal custom"><input type="radio" name="s-goal" value="custom" ${d.goal === "custom" ? "checked" : ""}>
      <span class="goal-name">직접 입력</span>
      <span class="cf-row">1kg당 <input id="s-cf" type="number" inputmode="decimal" min="${CF_MIN}" max="${CF_MAX}" step="0.1" value="${esc(d.customFactor)}" aria-label="체중 1kg당 단백질 g">g</span>
      <span class="goal-d" id="s-cf-out">${cfPreview(d.weight, d.customFactor)}</span></label>`;
  const wo = d.workouts.map((w, n) => `
    <div class="wo-row" data-id="${esc(w.id)}">
      <span class="wo-n">${n + 1}</span>
      <label>시작<input type="time" class="wo-start" min="08:00" max="23:55" step="300" value="${esc(w.start)}"></label>
      <label>길이 (분)<input type="number" class="wo-dur" inputmode="numeric" min="5" max="480" step="5" value="${esc(w.duration)}"></label>
      <button class="x" data-act="wo-del" data-id="${esc(w.id)}" aria-label="${n + 1}번째 운동 시간 지우기">×</button>
    </div>`).join("");
  const roll = [["empty", "비워요"], ["yesterday", "전날 목록 그대로 (체크만 해제)"], ["routine", "‘매일 자동’ 루틴으로 채워요"]];
  return `<h2>${first ? "시작하기 전에" : "설정"}</h2>
    ${first ? `<p class="muted">몸무게와 목표를 고르면 하루 단백질 목표가 정해져요.</p>` : ""}
    <div class="form">
      <div class="row2">
        <label>닉네임<input id="s-nick" maxlength="12" value="${esc(d.nick)}"></label>
        <label>몸무게 (kg)<input id="s-weight" type="number" inputmode="decimal" min="25" max="200" step="0.1" value="${esc(d.weight)}" placeholder="예: 65"></label>
      </div>
      <fieldset><legend>목표</legend><div class="goals">${goals}</div>
        <button class="link left" data-act="open-info">이 숫자의 근거 보기</button></fieldset>
      <fieldset><legend>운동 시간</legend>
        ${wo || `<p class="hint flat">운동 시간을 넣으면 운동 직후에 먹을 것도 추천해 드려요. 하루에 여러 번 넣을 수 있어요.</p>`}
        <button class="btn ghost small left" data-act="wo-add">운동 시간 추가</button></fieldset>
      <fieldset><legend>자정이 지나면 체크리스트를</legend>
        <select id="s-roll">${roll.map(([k, l]) => `<option value="${k}" ${d.rollover === k ? "selected" : ""} ${k === "routine" && !S.routines.length ? "disabled" : ""}>${l}</option>`).join("")}</select>
        ${S.routines.length ? "" : `<p class="hint flat">루틴을 저장하면 ‘매일 자동’을 고를 수 있어요.</p>`}</fieldset>
      <fieldset><legend>친구</legend>
        <label class="switch-row"><span><b>달성률 공개</b><small>닉네임, 오늘 달성률, 연속 기록을 친구들에게 보여줘요. 켜야 친구들 기록도 볼 수 있어요.</small></span>
          <input type="checkbox" role="switch" class="switch" id="s-share" ${d.share ? "checked" : ""}></label>
        <label class="switch-row ${d.share ? "" : "off"}" id="s-detail-row"><span><b>자세한 정보 공개</b><small>친구가 ‘자세히 보기’를 누르면 오늘 먹은 양과 식품, 최근 7일 기록, 몸무게와 목표를 볼 수 있어요.</small></span>
          <input type="checkbox" role="switch" class="switch" id="s-detail" ${d.share && d.detail ? "checked" : ""} ${d.share ? "" : "disabled"}></label>
      </fieldset>
    </div>
    <p class="form-err" id="s-err"></p>
    <div class="modal-actions">${first ? "" : `<button class="btn ghost" data-act="close-modal">취소</button>`}<button class="btn primary" data-act="save-settings">저장</button></div>`;
}

function routinesHTML() {
  const g = (r) => r.items.reduce((a, i) => a + (getFood(i.foodId)?.protein || 0) * i.qty, 0);
  const list = S.routines.map((r) => {
    const auto = S.rollover === "routine" && S.autoRoutineId === r.id;
    return `<li><div class="r-main"><strong>${esc(r.name)}</strong><span class="muted">식품 ${r.items.length}개, ${fmtG(g(r))}g</span></div>
      <button class="btn small" data-act="load-routine" data-id="${r.id}">담기</button>
      <button class="toggle ${auto ? "on" : ""}" data-act="auto-routine" data-id="${r.id}" aria-pressed="${auto}">매일 자동</button>
      <button class="link danger" data-act="del-routine" data-id="${r.id}">삭제</button></li>`;
  }).join("");
  return `<h2>루틴</h2>
    <p class="muted">자주 먹는 체크리스트를 저장해 두고 한 번에 담아요.</p>
    <div class="row-inline"><input id="r-name" maxlength="20" placeholder="예: 운동하는 날" aria-label="루틴 이름"><button class="btn primary" data-act="save-routine" ${S.today.items.length ? "" : "disabled"}>지금 체크리스트 저장</button></div>
    ${S.today.items.length ? "" : `<p class="hint">체크리스트에 식품을 담으면 루틴으로 저장할 수 있어요.</p>`}
    <ul class="routines">${list || `<li class="empty">저장한 루틴이 없어요.</li>`}</ul>
    <p class="hint">‘매일 자동’을 켜 두면 자정이 지난 뒤 그 루틴이 체크리스트에 저절로 들어가요. 급식은 그날 메뉴의 단백질로 바뀌어요.</p>
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
      <p class="muted">‘직접 입력’을 고르면 위 근거를 참고해 1kg당 ${CF_MIN}–${CF_MAX}g 사이에서 원하는 숫자를 정할 수 있어요.</p>
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
    ${signup ? `<p class="hint">비밀번호를 잊으면 되찾을 수 없어요. 잊지 않을 비밀번호로 정해 주세요.</p>` : ""}
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
function commit(msg, undo = false) { save(); render(); if (msg) toast(msg, undo); }

$app.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !b.dataset.act) return;
  const act = b.dataset.act;
  const i = Number(b.dataset.i);
  const items = S?.today.items;

  switch (act) {
    case "auth-mode": ui.authMode = b.dataset.m; ui.authError = ""; return renderAuth();
    case "reload": location.reload(); return;
    case "logout": await signOut(auth); return;
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
      const it = items[i]; const k = Number(b.dataset.k);
      const was = totals().eaten;
      it.eaten = k < it.eaten ? k : k + 1;
      const now = totals().eaten, t = target();
      return commit(t && was < t && now >= t ? "오늘 목표를 채웠어요" : "");
    }
    case "portion": {
      const it = items[i];
      const p = Math.max(0.5, Math.min(2, (it.portion || 1) + Number(b.dataset.d)));
      if (p === 1) delete it.portion; else it.portion = p;
      return commit();
    }
    case "meal-day": ui.mealDay = Number(b.dataset.d); return render();
    case "share-on": S.shareProgress = true; commit("이제 친구들과 달성률을 같이 봐요"); setTimeout(loadFriends, 800); return;
    case "friend-detail": ui.panel = null; ui.modal = { type: "friend", id: b.dataset.id }; return render();
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
    case "qty": { const it = items[i]; it.qty = Math.max(1, Math.min(20, it.qty + Number(b.dataset.d))); it.eaten = Math.min(it.eaten, it.qty); return commit(); }
    case "remove": { snapshot(); const f = getFood(items[i].foodId); items.splice(i, 1); return commit(`${eul(f ? f.name : "식품")} 뺐어요`, true); }
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
      if (document.getElementById("af-share")?.checked) {
        const ref = doc(collection(db, "sharedFoods"));
        const data = { name, protein: r1(protein), serving, kind, by: uid, byName: S.nickname, createdAt: Date.now() };
        try { await setDoc(ref, data); }
        catch (e2) { console.warn(e2); err.textContent = "공유하지 못했어요. Firestore 규칙을 새로 게시했는지 확인해 주세요."; return; }
        sharedFoods.unshift({ ...data, docId: ref.id, id: `s:${ref.id}` });
        ui.addOpen = false; ui.filter = "shared"; ui.query = "";
        return commit(`${eul(name)} 친구들과 공유했어요`);
      }
      S.customFoods.unshift({ id: `c-${newId()}`, name, protein: r1(protein), serving, kind });
      ui.addOpen = false; ui.filter = "all"; ui.query = "";
      return commit(`${eul(name)} 목록에 추가했어요`);
    }
    case "del-shared": {
      const f = sharedFoods.find((x) => x.id === b.dataset.id);
      if (!f || f.by !== uid) return;
      snapshot();
      const restoreS = undoFn;
      const { id: _id, docId, ...data } = f;
      sharedFoods = sharedFoods.filter((x) => x.id !== f.id);
      const keep = (x) => x.foodId !== f.id;
      S.today.items = S.today.items.filter(keep);
      S.lastItems = S.lastItems.filter(keep);
      S.routines.forEach((r) => { r.items = r.items.filter(keep); });
      try { await deleteDoc(doc(db, "sharedFoods", docId)); }
      catch (e2) { console.warn(e2); toast("지우지 못했어요. 인터넷 연결을 확인해 주세요."); sharedFoods.unshift(f); return render(); }
      commit(`공유한 ${eul(f.name)} 지웠어요`, true);
      undoFn = async () => {
        try { await setDoc(doc(db, "sharedFoods", docId), data); sharedFoods.unshift(f); } catch (e3) { console.warn(e3); }
        restoreS();
      };
      return;
    }
    case "hide-default": {
      const f = DEFAULT_FOODS.find((x) => x.id === b.dataset.id);
      if (!f) return;
      snapshot();
      S.hiddenDefaults.push(f.id);
      S.today.items = S.today.items.filter((x) => x.foodId !== f.id);
      S.lastItems = S.lastItems.filter((x) => x.foodId !== f.id);
      S.routines.forEach((r) => { r.items = r.items.filter((x) => x.foodId !== f.id); });
      return commit(`${eul(f.name)} 지웠어요`, true);
    }
    case "hide-all-defaults": {
      snapshot();
      const ids = DEFAULT_FOODS.map((f) => f.id);
      S.hiddenDefaults = ids;
      const keep = (x) => !ids.includes(x.foodId);
      S.today.items = S.today.items.filter(keep);
      S.lastItems = S.lastItems.filter(keep);
      S.routines.forEach((r) => { r.items = r.items.filter(keep); });
      if (ui.filter === "default") ui.filter = "all";
      return commit("기본 식품을 모두 지웠어요", true);
    }
    case "restore-defaults": S.hiddenDefaults = []; return commit("기본 식품을 되살렸어요");
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
      if (last && last.start) { const m = Math.min(parseTime(last.start) + (Number(last.duration) || 60) + 120, 23 * 60); start = fmtTime(m - (m % 5)); }
      list.push({ id: newId(), start, duration: 60 });
      render();
      [...document.querySelectorAll(".wo-start")].pop()?.focus();
      return;
    }
    case "wo-del": readSettingsForm(); ui.modal.draft.workouts = ui.modal.draft.workouts.filter((w) => w.id !== b.dataset.id); return render();
    case "back-settings": ui.modal = ui.modal.back; return render();
    case "backdrop": if (e.target === b) { ui.modal = null; render(); } return;
    case "close-modal": ui.modal = null; return render();

    case "save-settings": {
      readSettingsForm();
      const d = ui.modal.draft;
      const err = document.getElementById("s-err");
      const weight = parseFloat(d.weight);
      if (!(weight >= 25 && weight <= 200)) { err.textContent = "몸무게를 25–200kg 사이로 적어 주세요."; return; }
      const workouts = [];
      for (const [n, w] of d.workouts.entries()) {
        const dur = Number(w.duration);
        if (!w.start || parseTime(w.start) < 8 * 60) { err.textContent = `${n + 1}번째 운동의 시작 시간을 08:00 이후로 골라 주세요.`; return; }
        if (!(dur >= 5 && dur <= 480)) { err.textContent = `${n + 1}번째 운동의 길이를 5–480분 사이로 적어 주세요.`; return; }
        workouts.push({ id: w.id, start: w.start, duration: Math.round(dur) });
      }
      workouts.sort((a, b) => parseTime(a.start) - parseTime(b.start));
      S.nickname = d.nick.trim() || S.nickname;
      if (d.goal === "custom") {
        const cf = parseFloat(d.customFactor);
        if (!(cf >= CF_MIN && cf <= CF_MAX)) { err.textContent = `직접 입력 숫자는 ${CF_MIN}–${CF_MAX} 사이로 적어 주세요.`; return; }
        S.customFactor = r1(cf);
      }
      const shareChanged = S.shareProgress !== d.share || S.shareDetail !== (d.share && d.detail);
      S.shareProgress = d.share;
      S.shareDetail = d.share && d.detail;
      if (shareChanged) setTimeout(loadFriends, 800);
      S.weight = r1(weight); S.goal = d.goal; S.workouts = workouts;
      S.rollover = d.rollover;
      if (S.rollover === "routine" && !S.routines.some((r) => r.id === S.autoRoutineId)) S.autoRoutineId = S.routines[0]?.id ?? null;
      ui.modal = null;
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
$app.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && ui.modal && !ui.modal.first) { ui.modal = null; render(); }
  if (e.key === "Enter" && e.target.closest(".add-form") && e.target.tagName === "INPUT") {
    e.preventDefault(); document.querySelector('[data-act="save-food"]')?.click();
  }
});

/* ---------- 시간 흐름 ---------- */
function tick() {
  if (!S) return;
  if (ensureToday()) {
    save(); loadMeals(); render(); loadFriends();
    toast("새로운 하루예요. 체크리스트를 새로 시작했어요.");
    return;
  }
  const plan = document.getElementById("plan");
  if (plan && !ui.modal) plan.innerHTML = planHTML();
}
setInterval(tick, 30000);
setInterval(() => { if (S && document.visibilityState === "visible") loadFriends(); }, 120000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { tick(); if (S) loadFriends(); } });

/* ---------- 로그인 상태 ---------- */
onAuthStateChanged(auth, async (user) => {
  loadError = false;
  if (!user) { uid = null; S = null; ui.modal = null; lastFillPct = 0; sharedFoods = []; friends = []; render(); return; }
  uid = user.uid; S = null; render();
  try {
    const snap = await getDoc(doc(db, "users", uid));
    const isNew = !snap.exists();
    S = isNew ? freshData(pendingNick || user.email.split("@")[0]) : migrate(snap.data());
    applyTheme(S.theme);
    if (ensureToday() || isNew) save();
    if (!S.weight) ui.modal = { type: "settings", first: true, draft: settingsDraft() };
    render();
    loadShared();
    loadFriends();
  } catch (e) {
    console.error(e);
    loadError = true; render();
  }
});

loadMeals();
