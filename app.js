import { firebaseConfig } from './firebase-config.js';

/* ============================================================
   Cash Flow My Family: pencatat pengeluaran bulanan
   - Data tersimpan di Firebase (Firestore), login email/password
   - Tambahkan ?demo=1 di alamat untuk mencoba tanpa Firebase
   ============================================================ */

const DEMO = new URLSearchParams(location.search).has('demo');
const $ = (sel) => document.querySelector(sel);

/* ---------- Util tanggal & uang ---------- */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (y, m0) => `${y}-${pad(m0 + 1)}`;
const shiftMonth = (key, delta) => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d.getFullYear(), d.getMonth());
};
const daysIn = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};
const parseYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const rupiah = (n) => 'Rp ' + Math.round(n).toLocaleString('id-ID');
const compact = (n) => {
  if (n === 0) return '0';
  if (n >= 1e6) return (n / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' jt';
  if (n >= 1e3) return Math.round(n / 1e3).toLocaleString('id-ID') + ' rb';
  return String(n);
};
const dayLabel = (s) =>
  parseYmd(s).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short' });
const sum = (arr) => arr.reduce((a, i) => a + i.amount, 0);

const now = new Date();
const CURRENT_MONTH = monthKey(now.getFullYear(), now.getMonth());

const state = {
  month: CURRENT_MONTH,
  items: [],      // catatan bulan ini + bulan sebelumnya
  cur: [],        // catatan bulan yang sedang dilihat
  editing: null,
  unsub: null,
};
let store = null;

/* ============================================================
   Penyimpanan data
   ============================================================ */

// ---- Mode demo: data di localStorage ----
function makeDemoStore() {
  const KEY = 'cashflow-demo-v1';
  const listeners = new Set();
  let data = null;
  try { data = JSON.parse(localStorage.getItem(KEY)); } catch { /* abaikan */ }
  if (!Array.isArray(data)) data = seedDemo();
  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* abaikan */ }
    listeners.forEach((f) => f());
  };
  persist();

  function seedDemo() {
    const names = [
      ['Makan siang', 28000], ['Bensin', 50000], ['Belanja pasar', 135000], ['Pulsa', 25000],
      ['Air galon', 22000], ['Jajan anak', 15000], ['Parkir', 5000], ['Kopi', 24000],
      ['Listrik', 350000], ['Internet', 320000],
    ];
    const out = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const prev = shiftMonth(CURRENT_MONTH, -1);
    const make = (key, lastDay) => {
      for (let d = 1; d <= lastDay; d++) {
        const n = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) {
          const [name, price] = names[Math.floor(rnd() * names.length)];
          const amount = Math.round((price * (0.8 + rnd() * 0.5)) / 500) * 500;
          out.push({ id: `${key}-${d}-${k}`, name, amount, date: `${key}-${pad(d)}`, ts: d * 10 + k });
        }
      }
    };
    make(prev, daysIn(prev));
    make(CURRENT_MONTH, now.getDate());
    return out;
  }

  return {
    onAuth: (cb) => cb({ email: 'demo' }),
    signIn: async () => {},
    signOut: async () => {},
    subscribe(start, end, cb) {
      const push = () => cb(data.filter((i) => i.date >= start && i.date < end));
      listeners.add(push);
      push();
      return () => listeners.delete(push);
    },
    async add(item) { data.push({ ...item, id: 'd' + Date.now() + Math.random().toString(36).slice(2, 6), ts: Date.now() }); persist(); },
    async update(id, item) { data = data.map((i) => (i.id === id ? { ...i, ...item } : i)); persist(); },
    async remove(id) { data = data.filter((i) => i.id !== id); persist(); },
  };
}

// ---- Firebase (Firestore + Authentication) ----
async function makeFirebaseStore() {
  const base = 'https://www.gstatic.com/firebasejs/10.14.1/';
  const [appMod, authMod, fs] = await Promise.all([
    import(base + 'firebase-app.js'),
    import(base + 'firebase-auth.js'),
    import(base + 'firebase-firestore.js'),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  let db;
  try {
    // cache offline: catatan tetap bisa dibuka dan ditulis saat sinyal jelek
    db = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    db = fs.getFirestore(app);
  }
  const col = () => fs.collection(db, 'users', auth.currentUser.uid, 'expenses');

  return {
    onAuth: (cb) => authMod.onAuthStateChanged(auth, cb),
    signIn: (email, pw) => authMod.signInWithEmailAndPassword(auth, email, pw),
    signOut: () => authMod.signOut(auth),
    subscribe(start, end, cb) {
      const q = fs.query(col(), fs.where('date', '>=', start), fs.where('date', '<', end), fs.orderBy('date', 'desc'));
      return fs.onSnapshot(
        q,
        (snap) => cb(snap.docs.map((d) => {
          const v = d.data();
          const ts = v.createdAt && v.createdAt.toMillis ? v.createdAt.toMillis() : Date.now();
          return { id: d.id, name: v.name, amount: Number(v.amount) || 0, date: v.date, ts };
        })),
        (err) => toast(errorText(err))
      );
    },
    // Tidak di-await oleh UI: saat offline, janji baru selesai ketika sinyal kembali.
    add: (item) => fs.addDoc(col(), { ...item, createdAt: fs.serverTimestamp() }),
    update: (id, item) => fs.updateDoc(fs.doc(db, 'users', auth.currentUser.uid, 'expenses', id), item),
    remove: (id) => fs.deleteDoc(fs.doc(db, 'users', auth.currentUser.uid, 'expenses', id)),
  };
}

function errorText(err) {
  const code = (err && err.code) || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found') || code.includes('invalid-email'))
    return 'Email atau password salah.';
  if (code.includes('too-many-requests')) return 'Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.';
  if (code.includes('network')) return 'Tidak ada koneksi internet.';
  if (code.includes('permission-denied')) return 'Akses ditolak oleh aturan database. Cek Firestore Rules.';
  return 'Terjadi kesalahan. Coba lagi.';
}

/* ============================================================
   Tampilan
   ============================================================ */

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function subscribeMonth() {
  if (state.unsub) state.unsub();
  const start = shiftMonth(state.month, -1) + '-01';
  const end = shiftMonth(state.month, 1) + '-01';
  state.unsub = store.subscribe(start, end, (items) => {
    state.items = items;
    render();
  });
}

function render() {
  const key = state.month;
  const prevKey = shiftMonth(key, -1);
  const cur = state.items
    .filter((i) => i.date.startsWith(key))
    .sort((a, b) => (a.date === b.date ? b.ts - a.ts : a.date < b.date ? 1 : -1));
  state.cur = cur;

  const [y, m] = key.split('-').map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
  $('#monthLabel').textContent = label;
  $('#nextMonth').disabled = key === CURRENT_MONTH;

  // ringkasan
  const total = sum(cur);
  $('#heroTotal').textContent = rupiah(total);
  $('#statCount').textContent = String(cur.length);
  const isCurrent = key === CURRENT_MONTH;
  const daysElapsed = isCurrent ? now.getDate() : daysIn(key);
  $('#statAvg').textContent = rupiah(total / daysElapsed);
  const biggest = cur.reduce((b, i) => (!b || i.amount > b.amount ? i : b), null);
  $('#statMax').textContent = biggest ? rupiah(biggest.amount) : '-';
  $('#statMax').title = biggest ? biggest.name : '';

  // perbandingan dengan bulan lalu (periode yang sama)
  const prevAll = state.items.filter((i) => i.date.startsWith(prevKey));
  const prevCmp = isCurrent ? prevAll.filter((i) => +i.date.slice(8, 10) <= now.getDate()) : prevAll;
  const prevTotal = sum(prevCmp);
  const cmp = $('#heroCompare');
  if (prevTotal > 0) {
    const pct = Math.round(((total - prevTotal) / prevTotal) * 100);
    const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '●';
    const span = isCurrent ? `tanggal 1–${now.getDate()} bulan lalu` : 'bulan sebelumnya';
    cmp.textContent = `${arrow} ${Math.abs(pct)}% ${pct >= 0 ? 'lebih tinggi' : 'lebih rendah'} dari ${span} (${rupiah(prevTotal)})`;
  } else {
    cmp.textContent = 'Belum ada data bulan sebelumnya untuk dibandingkan.';
  }

  $('#chart').setAttribute('aria-label', `Grafik batang pengeluaran per hari, ${label}. Total ${rupiah(total)}.`);
  renderChart();
  renderList(cur);
}

function renderList(cur) {
  const list = $('#list');
  list.replaceChildren();
  $('#empty').hidden = cur.length > 0;
  let lastDate = '';
  const byDate = new Map();
  cur.forEach((i) => { byDate.set(i.date, (byDate.get(i.date) || 0) + i.amount); });
  for (const item of cur) {
    if (item.date !== lastDate) {
      lastDate = item.date;
      const head = document.createElement('div');
      head.className = 'day-head';
      const l = document.createElement('span');
      l.textContent = dayLabel(item.date);
      const t = document.createElement('span');
      t.className = 'num';
      t.textContent = rupiah(byDate.get(item.date));
      head.append(l, t);
      list.append(head);
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row';
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = item.name;
    const a = document.createElement('span');
    a.className = 'amt';
    a.textContent = rupiah(item.amount);
    row.append(n, a);
    row.addEventListener('click', () => openSheet(item));
    list.append(row);
  }
}

/* ---------- Grafik batang per hari (SVG buatan sendiri) ---------- */
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(name, attrs = {}, text) {
  const el = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}
function niceScale(max) {
  if (max <= 0) return { top: 100000, step: 25000 };
  const raw = max / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * pow).find((s) => s >= raw);
  return { top: Math.ceil(max / step) * step, step };
}

let chartGeom = null;
function renderChart() {
  const box = $('#chart');
  const dim = daysIn(state.month);
  const sums = Array(dim).fill(0);
  const counts = Array(dim).fill(0);
  state.cur.forEach((i) => {
    const d = +i.date.slice(8, 10) - 1;
    if (d >= 0 && d < dim) { sums[d] += i.amount; counts[d]++; }
  });
  const W = Math.max(box.clientWidth, 240);
  const H = 190;
  const m = { t: 20, r: 6, b: 24, l: 40 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const max = Math.max(...sums);
  const { top, step } = niceScale(max);
  const y = (v) => m.t + ih - (v / top) * ih;
  const slot = iw / dim;
  const bw = Math.max(3, Math.min(18, slot * 0.62));

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' });
  for (let v = 0; v <= top + 1e-6; v += step) {
    svg.append(svgEl('line', { class: 'chart-grid', x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    svg.append(svgEl('text', { class: 'chart-axis', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, compact(v)));
  }
  const ticks = new Set([1, 5, 10, 15, 20, 25, dim]);
  if (dim - 25 < 3) ticks.delete(25);
  ticks.forEach((d) => {
    svg.append(svgEl('text', { class: 'chart-axis', x: m.l + slot * (d - 0.5), y: H - 6, 'text-anchor': 'middle' }, String(d)));
  });

  let maxIdx = -1;
  sums.forEach((v, i) => { if (v > 0 && (maxIdx < 0 || v > sums[maxIdx])) maxIdx = i; });
  sums.forEach((v, i) => {
    const cx = m.l + slot * (i + 0.5);
    if (v > 0) {
      const h = Math.max(2, (v / top) * ih);
      const x = cx - bw / 2;
      const yy = m.t + ih - h;
      const r = Math.min(4, bw / 2, h);
      svg.append(svgEl('path', {
        class: 'chart-bar', 'data-i': i,
        d: `M${x},${yy + h} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${yy + h} Z`,
      }));
    }
    svg.append(svgEl('rect', { class: 'chart-hit', 'data-i': i, x: m.l + slot * i, y: m.t, width: slot, height: ih }));
  });
  if (maxIdx >= 0) {
    const cx = m.l + slot * (maxIdx + 0.5);
    const anchor = cx > W - 34 ? 'end' : cx < m.l + 24 ? 'start' : 'middle';
    const ax = anchor === 'end' ? cx + bw / 2 : anchor === 'start' ? cx - bw / 2 : cx;
    svg.append(svgEl('text', { class: 'chart-label', x: ax, y: y(sums[maxIdx]) - 5, 'text-anchor': anchor }, compact(sums[maxIdx])));
  }
  box.replaceChildren(svg);
  box.classList.remove('has-active');
  $('#tip').hidden = true;
  chartGeom = { m, slot, W, y, sums, counts, bw };
}

function showTip(i) {
  if (!chartGeom) return;
  const { m, slot, W, y, sums, counts } = chartGeom;
  const tip = $('#tip');
  const date = `${state.month}-${pad(i + 1)}`;
  tip.replaceChildren();
  const b = document.createElement('b');
  b.textContent = sums[i] > 0 ? rupiah(sums[i]) : 'Tidak ada pengeluaran';
  const s = document.createElement('span');
  s.textContent = sums[i] > 0 ? `${dayLabel(date)} · ${counts[i]} catatan` : dayLabel(date);
  tip.append(b, s);
  const cx = m.l + slot * (i + 0.5);
  tip.style.left = Math.min(Math.max(cx, 70), W - 70) + 'px';
  tip.style.top = Math.max(y(sums[i]) - 6, 64) + 'px';
  tip.hidden = false;
  const box = $('#chart');
  box.classList.add('has-active');
  box.querySelectorAll('.chart-bar').forEach((p) => p.classList.toggle('active', +p.dataset.i === i));
}
function hideTip() {
  $('#tip').hidden = true;
  const box = $('#chart');
  box.classList.remove('has-active');
  box.querySelectorAll('.chart-bar.active').forEach((p) => p.classList.remove('active'));
}
$('#chart').addEventListener('pointerover', (e) => { const t = e.target.closest('.chart-hit'); if (t) showTip(+t.dataset.i); });
$('#chart').addEventListener('pointerdown', (e) => { const t = e.target.closest('.chart-hit'); if (t) showTip(+t.dataset.i); });
$('#chart').addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hideTip(); });
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#chartWrap')) hideTip(); });
let resizeRaf = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => { if (!$('#app').hidden) renderChart(); });
}).observe($('#chartWrap'));

/* ---------- Form catat / ubah ---------- */
const sheet = $('#sheet');
const fName = $('#fName');
const fAmount = $('#fAmount');
const fDate = $('#fDate');
let deleteArmed = 0;

function openSheet(item) {
  state.editing = item || null;
  $('#sheetTitle').textContent = item ? 'Ubah pengeluaran' : 'Catat pengeluaran';
  fName.value = item ? item.name : '';
  fAmount.value = item ? item.amount.toLocaleString('id-ID') : '';
  const defaultDate = state.month === CURRENT_MONTH ? ymd(now) : `${state.month}-01`;
  fDate.value = item ? item.date : defaultDate;
  fDate.max = ymd(new Date(now.getFullYear() + 1, 11, 31));
  $('#formError').hidden = true;
  $('#deleteBtn').hidden = !item;
  resetDelete();
  $('#saveBtn').disabled = false;
  sheet.showModal();
  if (!item) fName.focus();
}
function resetDelete() {
  clearTimeout(deleteArmed);
  $('#deleteBtn').textContent = 'Hapus';
}
fAmount.addEventListener('input', () => {
  const digits = fAmount.value.replace(/\D/g, '').slice(0, 12);
  fAmount.value = digits ? Number(digits).toLocaleString('id-ID') : '';
});
$('#sheetClose').addEventListener('click', () => sheet.close());
sheet.addEventListener('click', (e) => {
  const r = sheet.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) sheet.close();
});
$('#fab').addEventListener('click', () => openSheet());

$('#expenseForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = fName.value.trim();
  const amount = Number(fAmount.value.replace(/\D/g, ''));
  const date = fDate.value;
  const err = $('#formError');
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };
  if (!name) return fail('Nama pengeluaran belum diisi.');
  if (!amount || amount <= 0) return fail('Harga belum diisi.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('Tanggal belum dipilih.');

  const data = { name, amount, date };
  const p = state.editing ? store.update(state.editing.id, data) : store.add(data);
  Promise.resolve(p).catch((e2) => toast(errorText(e2)));
  sheet.close();
  const newMonth = date.slice(0, 7);
  if (newMonth !== state.month && newMonth <= CURRENT_MONTH) {
    state.month = newMonth;
    subscribeMonth();
  }
  toast(state.editing ? 'Perubahan disimpan.' : 'Pengeluaran dicatat.');
});

$('#deleteBtn').addEventListener('click', () => {
  const btn = $('#deleteBtn');
  if (btn.textContent === 'Hapus') {
    btn.textContent = 'Yakin hapus?';
    deleteArmed = setTimeout(resetDelete, 3000);
    return;
  }
  resetDelete();
  const id = state.editing && state.editing.id;
  if (!id) return;
  Promise.resolve(store.remove(id)).catch((e) => toast(errorText(e)));
  sheet.close();
  toast('Catatan dihapus.');
});

/* ---------- Navigasi bulan ---------- */
$('#prevMonth').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); subscribeMonth(); render(); });
$('#nextMonth').addEventListener('click', () => {
  if (state.month >= CURRENT_MONTH) return;
  state.month = shiftMonth(state.month, 1);
  subscribeMonth();
  render();
});

/* ---------- Login / keluar ---------- */
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  const err = $('#loginError');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Masuk…';
  try {
    await store.signIn($('#email').value.trim(), $('#password').value);
  } catch (ex) {
    err.textContent = errorText(ex);
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Masuk';
  }
});
$('#logoutBtn').addEventListener('click', () => { if (!DEMO) store.signOut(); });

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#demoBanner').hidden = !DEMO;
  $('#logoutBtn').hidden = DEMO;
  subscribeMonth();
  render();
}
function showLogin() {
  if (state.unsub) { state.unsub(); state.unsub = null; }
  state.items = [];
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#password').value = '';
}

/* ---------- Mulai ---------- */
(async function main() {
  try {
    store = DEMO ? makeDemoStore() : await makeFirebaseStore();
  } catch (e) {
    console.error(e);
    $('#boot').textContent = 'Tidak bisa memuat. Periksa koneksi internet lalu muat ulang halaman.';
    return;
  }
  store.onAuth((user) => {
    $('#boot').hidden = true;
    if (user) showApp(); else showLogin();
  });
})();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
