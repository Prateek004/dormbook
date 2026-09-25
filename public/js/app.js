'use strict';
/* ============================================================
   DormBook v3 — Frontend SPA  (SaaS edition)
   API base: /api/v1
   All monetary display: paise ÷ 100 = rupees
   ============================================================ */

// ── Service Worker registration ──────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        console.log('[SW] Registered:', reg.scope);
        navigator.serviceWorker.addEventListener('message', e => {
          if (e.data?.type === 'SYNC_COMPLETE') {
            toast(`Synced ${e.data.replayed} offline action(s)`, 'success');
            refreshCurrentPage();
          }
        });
      })
      .catch(err => console.warn('[SW] Registration failed:', err.message));
  });
}

// ── Offline indicator ────────────────────────────────────────
window.addEventListener('online',  () => document.getElementById('offline-indicator')?.classList.add('hidden'));
window.addEventListener('offline', () => document.getElementById('offline-indicator')?.classList.remove('hidden'));

// ── State ────────────────────────────────────────────────────
const STATE = { token: null, user: null, currentPage: null };

// ── API helper ───────────────────────────────────────────────
function newIdemKey() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(STATE.token ? { Authorization: `Bearer ${STATE.token}` } : {}),
      // one key per click: a retried request can never record the same payment twice
      ...(method !== 'GET' ? { 'Idempotency-Key': newIdemKey() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(`/api/v1${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && STATE.token && !path.startsWith('/auth/login')) {
    // Session no longer valid (expired, server secret changed, or database reset).
    sessionStorage.clear();
    STATE.token = null; STATE.user = null;
    showScreen('login-screen');
    toast('Your session has ended — please sign in again', 'warning', 5000);
  }
  if (!res.ok) {
    const msg = data.error || (res.status >= 500 ? 'Server is not reachable right now. Please try again in a minute.' : `Request failed (${res.status})`);
    throw Object.assign(new Error(msg), { status: res.status, data });
  }
  return data;
}

// Today's date in India (YYYY-MM-DD). toISOString() is UTC, which is still
// "yesterday" before 05:30 IST — so forms defaulted to the wrong date at night.
function todayIST() { return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); }
// HTML-escape any user-entered text before putting it in innerHTML.
function h(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }
function rupees(paise) { const v = Math.round(paise || 0); const t = `₹${(Math.abs(v) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; return v < 0 ? `−${t}` : t; }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; }
// For text inside onclick="fn('…')": escaped for JavaScript first, then for HTML, so a name like
// x&#39;);alert(1)// stays plain text. (The old version missed "&" and could run such a name as code.)
function esc(s) {
  const js = String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"')
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029').replace(/</g, '\\x3c');
  return h(js);
}

// ── Toast ────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const tc = document.getElementById('toast-container');
  if (!tc) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  tc.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, duration);
}

// ── Modal ────────────────────────────────────────────────────
function openModal(title, bodyHtml, { wide } = {}) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal').style.maxWidth = wide ? '720px' : '520px';
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function closeModal() { document.getElementById('modal-overlay').classList.add('hidden'); }
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target === document.getElementById('modal-overlay')) closeModal(); });
});

// ── GST helpers (same maths as the server's ledger.gstSplit) ──
const GST_RATES = [0, 5, 12, 18, 28, 40];
function gstSplit(pricePaise, rateBp, inclusive) {
  const p = Math.round(pricePaise || 0), r = Number(rateBp) || 0;
  if (!r) return { gross: p, tax: 0, taxable: p };
  const tax = inclusive ? Math.round((p * r) / (10000 + r)) : Math.round((p * r) / 10000);
  const gross = inclusive ? p : p + tax;
  return { gross, tax, taxable: gross - tax };
}
/** Business profile incl. GST settings; cached for the session, refreshed after Settings save. */
async function getProfile(force) {
  if (!STATE.profile || force) STATE.profile = await api('GET', '/properties/profile');
  return STATE.profile;
}
const gstLabel = (bp, incl) => bp ? `${bp / 100}% GST ${incl ? 'incl.' : 'extra'}` : 'No GST';

// ── Cash change helper: guest gives ₹500 for ₹300 → "Give back ₹200" ──
// Only helps the cashier count; nothing extra is saved (the payment amount is what's recorded).
function cashChangeBox(pfx) {
  return `
    <div class="change-box" id="${pfx}-chg" hidden>
      <div class="change-row">
        <label for="${pfx}-given">Cash given by guest</label>
        <div class="change-in"><span>₹</span><input id="${pfx}-given" type="number" min="0" step="1" inputmode="numeric" placeholder="0" /></div>
      </div>
      <div class="change-notes">${[10, 20, 50, 100, 200, 500].map(n => `<button type="button" class="note-btn" data-note="${n}">₹${n}</button>`).join('')}
        <button type="button" class="note-btn" data-note="exact">Exact</button></div>
      <div class="change-out" id="${pfx}-out"></div>
    </div>`;
}
/** getDue() → rupees to collect; getMode() → 'cash' | … */
function bindCashChange(pfx, getDue, getMode) {
  const box = document.getElementById(`${pfx}-chg`);
  if (!box) return () => {};
  const given = document.getElementById(`${pfx}-given`);
  const out = document.getElementById(`${pfx}-out`);
  const update = () => {
    const due = Math.round((Number(getDue()) || 0) * 100);
    const show = getMode() === 'cash' && due > 0;
    box.hidden = !show;
    if (!show) return;
    const g = Math.round((parseFloat(given.value) || 0) * 100);
    out.className = 'change-out';
    if (!given.value) { out.innerHTML = `<span>To collect</span><b>${rupees(due)}</b>`; return; }
    if (g > due) { out.classList.add('give'); out.innerHTML = `<span>Give back to guest</span><b>${rupees(g - due)}</b>`; }
    else if (g < due) { out.classList.add('short'); out.innerHTML = `<span>Still short</span><b>${rupees(due - g)}</b>`; }
    else { out.classList.add('exact'); out.innerHTML = `<span>Exact amount</span><b>✓</b>`; }
  };
  given.addEventListener('input', update);
  box.querySelectorAll('.note-btn').forEach(b => b.addEventListener('click', () => {
    const due = Number(getDue()) || 0;
    if (b.dataset.note === 'exact') given.value = due;
    else { const n = Number(b.dataset.note); given.value = (parseFloat(given.value) || 0) + n; }
    update();
  }));
  update();
  return update;
}

// ── Navigation ───────────────────────────────────────────────
// Short menu. Pages with `tabs` group several screens behind one menu item.
// Each page/tab shows only if the signed-in user has one of its permissions.
const NAV = [
  { section: 'Daily work', items: [
    { id: 'dashboard', label: '🏠 Today' },
    { id: 'checkin',   label: '✅ Check In',     perms: ['checkin'] },
    { id: 'residents', label: '👥 Guests' },
    { id: 'payments',  label: '💳 Take Payment', perms: ['payments', 'approvals'] },
    { id: 'bookings',  label: '📌 Bookings',     perms: ['bookings'] },
  ] },
  { section: 'Money', items: [
    { id: 'expenses',  label: '📋 Expenses',     perms: ['expenses'] },
    { id: 'reconcile', label: '🗃 Cash Close',   perms: ['cash_close'] },
  ] },
  { section: 'Reports', items: [
    { id: 'summary',   label: '📈 Monthly Summary', perms: ['reports_finance'] },
    { id: 'reports',   label: '📊 Registers',       perms: ['reports_daily', 'reports_finance'] },
    { id: 'gst',       label: '🧾 GST Report',      perms: ['reports_finance'] },
    { id: 'daily',     label: '📅 Daily View',      perms: ['reports_daily'] },
  ] },
  { section: 'Setup', items: [
    { id: 'beds',      label: '🛏 Beds' },
    { id: 'catalog',   label: '☕ Items & Prices',  perms: ['settings'] },
    { id: 'settings',  label: '🏢 Business & GST',  perms: ['settings'] },
    { id: 'staff',     label: '👤 Users & Access',  perms: ['staff'] },
    { id: 'audit',     label: '🔍 Audit Log',       perms: ['audit'] },
    { id: 'account',   label: '🔑 My Account' },
  ] },
];
const PAGES = NAV.flatMap(g => g.items);

const allowed = (p) => !p.perms || p.perms.some(can);
function tabsOf(group) { return (group.tabs || []).filter(allowed); }
/** The menu group a page lives in (or null for a top-level page). */
function groupOf(page) { return null; }   // no hidden tabs any more: every screen has its own menu item

/** Does the signed-in user have this permission? */
function can(perm) {
  const u = STATE.user;
  if (!u) return false;
  if (u.role === 'owner' || u.role === 'superadmin') return true;
  return Array.isArray(u.permissions) && u.permissions.includes(perm);
}

function buildNav() {
  const nav = document.getElementById('nav-list');
  nav.innerHTML = NAV.map(g => {
    const items = g.items.filter(allowed);
    if (!items.length) return '';
    return `<li class="nav-section">${h(g.section)}</li>` +
      items.map(p => `<li><a href="#" data-page="${p.id}">${h(p.label)}</a></li>`).join('');
  }).join('');
  nav.querySelectorAll('[data-page]').forEach(a =>
    a.addEventListener('click', e => { e.preventDefault(); navigate(a.dataset.page); closeSidebar(); })
  );
}

function navigate(page) {
  // A menu group opens its last-used (or first allowed) tab.
  const g = PAGES.find(p => p.id === page && p.tabs);
  if (g) {
    const tabs = tabsOf(g);
    if (!tabs.length) return;
    STATE.lastTab = STATE.lastTab || {};
    page = tabs.some(t => t.id === STATE.lastTab[g.id]) ? STATE.lastTab[g.id] : tabs[0].id;
  }
  STATE.currentPage = page;
  const group = groupOf(page);
  if (group) { STATE.lastTab = STATE.lastTab || {}; STATE.lastTab[group.id] = page; }
  const navId = group ? group.id : page;
  document.querySelectorAll('.nav-list a').forEach(a =>
    a.classList.toggle('active', a.dataset.page === navId)
  );
  document.getElementById('page-title').textContent = group ? group.title : titleFor(page);
  renderPage(page);
}

function titleFor(page) {
  const map = { dashboard: 'Today', checkin: 'Check In', residents: 'Guests', payments: 'Take Payment', bookings: 'Bookings',
    expenses: 'Expenses', reconcile: 'Cash Close', summary: 'Monthly Summary', reports: 'Registers', gst: 'GST Report',
    daily: 'Daily View', beds: 'Beds', catalog: 'Items & Prices', settings: 'Business & GST', staff: 'Users & Access',
    audit: 'Audit Log', feedback: 'Tenant Feedback', admin: 'Admin Panel', account: 'My Account' };
  return map[page] || page;
}

function refreshCurrentPage() { if (STATE.currentPage) renderPage(STATE.currentPage); }

function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); }

// ── Screen helper ────────────────────────────────────────────
function showScreen(id) {
  ['login-screen', 'register-screen', 'forgot-screen', 'mpin-screen', 'main-app', 'loading-screen'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.add('hidden');
  });
  const target = document.getElementById(id);
  if (target) target.classList.remove('hidden');
}

// ── Auth ─────────────────────────────────────────────────────
async function init() {
  const loadingTimer = setTimeout(() => showScreen('login-screen'), 4000);
  try {
    const token = sessionStorage.getItem('db_token');
    const user  = JSON.parse(sessionStorage.getItem('db_user') || 'null');
    if (token && user) {
      STATE.token = token;
      STATE.user  = user;
      try {
        const me = await api('GET', '/auth/me');
        if (me && me.user) { STATE.user = me.user; sessionStorage.setItem('db_user', JSON.stringify(me.user)); } // fresh permissions
        clearTimeout(loadingTimer);
        showApp();
      } catch {
        sessionStorage.clear();
        STATE.token = null;
        STATE.user  = null;
        clearTimeout(loadingTimer);
        showScreen('login-screen');
      }
    } else {
      clearTimeout(loadingTimer);
      showScreen('login-screen');
    }
  } catch {
    clearTimeout(loadingTimer);
    showScreen('login-screen');
  }
}

// ── Login ────────────────────────────────────────────────────
let _loginListenerAttached = false;
document.addEventListener('DOMContentLoaded', () => {
  // Login
  if (!_loginListenerAttached) {
    document.getElementById('login-btn')?.addEventListener('click', handleLogin);
    document.getElementById('login-form')?.addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(e); });
    _loginListenerAttached = true;
  }

  // Screen navigation links
  document.getElementById('goto-register')?.addEventListener('click', e => { e.preventDefault(); showScreen('register-screen'); });
  document.getElementById('goto-forgot')?.addEventListener('click',   e => { e.preventDefault(); showScreen('forgot-screen'); });
  document.getElementById('goto-login')?.addEventListener('click',    e => { e.preventDefault(); showScreen('login-screen'); });
  document.getElementById('goto-login-2')?.addEventListener('click',  e => { e.preventDefault(); showScreen('login-screen'); });

  // Register form
  document.getElementById('register-btn')?.addEventListener('click', handleRegister);
  document.getElementById('register-form')?.addEventListener('keydown', e => { if (e.key === 'Enter') handleRegister(e); });

  // Forgot password — step 1 (send OTP)
  document.getElementById('forgot-send-btn')?.addEventListener('click', handleForgotSend);

  // Forgot password — step 2 (reset with OTP)
  document.getElementById('forgot-reset-btn')?.addEventListener('click', handleForgotReset);

  // Staff: first time / forgot MPIN
  document.getElementById('goto-mpin')?.addEventListener('click', e => { e.preventDefault(); showMpinScreen(); });
  document.getElementById('goto-login-3')?.addEventListener('click', e => { e.preventDefault(); showScreen('login-screen'); });
  document.getElementById('mp-save')?.addEventListener('click', submitMpinSetup);
  document.getElementById('mp-sms')?.addEventListener('click', e => { e.preventDefault(); requestMpinCode(); });
  document.getElementById('mpin-form')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitMpinSetup(); } });
});

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('login-error');
  err.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const data = await api('POST', '/auth/login', {
      email:    document.getElementById('login-email').value.trim(),
      password: document.getElementById('login-password').value,
    });
    document.getElementById('login-password').value = '';
    startSession(data);
  } catch (ex) {
    const msg = ex.status === 0
      ? 'Cannot reach server. Check your connection.'
      : (ex.message || 'Login failed');
    err.textContent = msg;
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

async function handleRegister(e) {
  e?.preventDefault();
  const btn = document.getElementById('register-btn');
  const err = document.getElementById('register-error');
  err.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Creating account…';
  try {
    const data = await api('POST', '/auth/register', {
      business_name: document.getElementById('reg-business').value.trim(),
      owner_name:    document.getElementById('reg-name').value.trim(),
      mobile:        document.getElementById('reg-mobile').value.trim(),
      email:         document.getElementById('reg-email').value.trim() || undefined,
      password:      document.getElementById('reg-password').value,
      pg_name:       document.getElementById('reg-pg-name').value.trim(),
      city:          document.getElementById('reg-city').value.trim() || undefined,
    });
    STATE.token = data.token;
    STATE.user  = data.user;
    sessionStorage.setItem('db_token', data.token);
    sessionStorage.setItem('db_user',  JSON.stringify(data.user));
    toast(`Welcome, ${h(data.user.name)}! Your 30-day trial has started.`, 'success', 6000);
    showApp();
  } catch (ex) {
    err.textContent = ex.message || 'Registration failed';
    err.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
}

// forgot step state
let _forgotMobile = '';

async function handleForgotSend(e) {
  e?.preventDefault();
  const btn = document.getElementById('forgot-send-btn');
  const err = document.getElementById('forgot-error');
  err.classList.add('hidden');
  const mobile = document.getElementById('forgot-mobile').value.trim();
  if (!mobile) { err.textContent = 'Enter your registered mobile number'; err.classList.remove('hidden'); return; }
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await api('POST', '/auth/forgot-password', { mobile });
    _forgotMobile = mobile;
    // Show step 2
    document.getElementById('forgot-step-1').classList.add('hidden');
    document.getElementById('forgot-step-2').classList.remove('hidden');
    toast('OTP sent to your WhatsApp', 'success');
  } catch (ex) {
    err.textContent = ex.message || 'Failed to send OTP';
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send OTP';
  }
}

async function handleForgotReset(e) {
  e?.preventDefault();
  const btn = document.getElementById('forgot-reset-btn');
  const err = document.getElementById('forgot-reset-error');
  err.classList.add('hidden');
  const otp      = document.getElementById('forgot-otp').value.trim();
  const password = document.getElementById('forgot-new-password').value;
  if (!otp || !password) { err.textContent = 'Enter OTP and new password'; err.classList.remove('hidden'); return; }
  btn.disabled = true;
  btn.textContent = 'Resetting…';
  try {
    await api('POST', '/auth/reset-password', { mobile: _forgotMobile, otp, new_password: password });
    toast('Password reset! Please log in.', 'success');
    showScreen('login-screen');
  } catch (ex) {
    err.textContent = ex.message || 'Reset failed';
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Reset Password';
  }
}

function showApp() {
  showScreen('main-app');
  document.getElementById('user-badge').textContent = `${STATE.user.name} · ${STATE.user.role}`;
  // Remove old listeners before adding (guard against double-attach after login → logout → login)
  const logoutBtn = document.getElementById('logout-btn');
  const newLogout = logoutBtn.cloneNode(true);
  logoutBtn.parentNode.replaceChild(newLogout, logoutBtn);
  newLogout.addEventListener('click', logout);

  document.getElementById('menu-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  // Superadmin gets its own nav + page
  if (STATE.user.role === 'superadmin') {
    document.getElementById('nav-list').innerHTML = `
      <li><a href="#" data-page="admin" class="active">👑 Admin Panel</a></li>
    `;
    document.getElementById('nav-list').querySelector('[data-page=admin]').addEventListener('click', e => {
      e.preventDefault(); navigate('admin'); closeSidebar();
    });
    navigate('admin');
    if (!navigator.onLine) document.getElementById('offline-indicator')?.classList.remove('hidden');
    return;
  }

  buildNav();
  navigate('dashboard');
  if (!navigator.onLine) document.getElementById('offline-indicator')?.classList.remove('hidden');
}

function logout() {
  sessionStorage.clear();
  STATE.token = null;
  STATE.user  = null;
  location.reload();
}

// ── Pages ────────────────────────────────────────────────────
async function renderPage(page) {
  const main = document.getElementById('page-content');
  document.getElementById('header-actions').innerHTML = '';
  STATE.currentPage = page;
  // Grouped pages get a tab bar; the screen itself renders below it.
  const group = groupOf(page);
  let el = main;
  if (group) {
    const tabs = tabsOf(group);
    main.innerHTML = `
      <div class="sub-tabs" role="tablist">${tabs.map(t =>
        `<button role="tab" class="sub-tab ${t.id === page ? 'active' : ''}" aria-selected="${t.id === page}" onclick="navigate('${t.id}')">${h(t.label)}</button>`).join('')}
      </div>
      <div id="sub-content"></div>`;
    el = document.getElementById('sub-content');
  }
  el.innerHTML = '<div class="empty-state"><div class="loading-spinner" style="margin:0 auto"></div></div>';
  try {
    switch (page) {
      case 'dashboard': await renderDashboard(el); break;
      case 'beds':      await renderBeds(el);      break;
      case 'checkin':   await renderCheckin(el);   break;
      case 'residents': await renderResidents(el); break;
      case 'payments':  await renderPayments(el);  break;
      case 'bookings':  await renderBookings(el);  break;
      case 'reconcile': await renderReconcile(el); break;
      case 'expenses':  await renderExpenses(el);  break;
      case 'reports':   await renderReports(el);   break;
      case 'gst':       await renderReports(el, 'gst'); break;
      case 'summary':   await renderMonthly(el);   break;
      case 'daily':     await renderDaily(el);     break;
      case 'staff':     await renderStaff(el);     break;
      case 'feedback':  await renderFeedback(el);  break;
      case 'catalog':   await renderCatalog(el);   break;
      case 'audit':     await renderAudit(el);     break;
      case 'settings':  await renderSettings(el);  break;
      case 'account':   await renderAccount(el);   break;
      case 'admin':     await renderAdminPanel(el); break;
      default:          el.innerHTML = '<div class="empty-state"><p>Page not found</p></div>';
    }
  } catch (ex) {
    if (ex && ex.status === 401) return;   // already sent to the login screen
    el.innerHTML = `<div class="error-msg">Failed to load: ${h(ex.message)}</div>
      <button class="btn btn-outline btn-sm mt-12" onclick="refreshCurrentPage()">Try again</button>`;
  }
}

// ── Dashboard ────────────────────────────────────────────────
async function renderDashboard(el) {
  const d = await api('GET', '/dashboard/today');
  const t = d.tasks;
  const b = d.beds;
  const occ = b.total ? Math.round((b.occupied * 100) / b.total) : 0;
  const task = (icon, title, count, body, cls = '') => `
    <div class="task ${count ? cls : 'done'}">
      <div class="task-head"><span class="task-icon">${icon}</span><strong>${title}</strong><span class="task-count">${count}</span></div>
      ${count ? `<div class="task-body">${body}</div>` : '<div class="task-body text-muted">Nothing to do ✓</div>'}
    </div>`;
  const row = (main, sub, btn) => `<div class="task-row"><div><div class="td-name">${main}</div><div class="td-small">${sub}</div></div>${btn || ''}</div>`;

  el.innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>Occupancy</span><strong>${occ}%</strong><em>${b.occupied} of ${b.total} beds</em></div>
      <div class="kpi"><span>Vacant beds</span><strong>${b.available}</strong><em>${b.reserved} on hold · ${b.cleaning} cleaning</em></div>
      ${d.collected_today_paise !== undefined ? `<div class="kpi"><span>Collected today</span><strong>${rupees(d.collected_today_paise)}</strong><em>${d.collected_today_cash_paise !== undefined ? `Cash ${rupees(d.collected_today_cash_paise)} · Online ${rupees(d.collected_today_online_paise)}` : 'cash, UPI and card'}</em></div>` : ''}
      ${t.collect_dues ? `<div class="kpi ${t.collect_dues.total_paise ? 'bad' : ''}"><span>Dues pending</span><strong>${rupees(t.collect_dues.total_paise)}</strong><em>${t.collect_dues.count} residents</em></div>` : ''}
    </div>

    <div class="quick btn-group mb-20">
      ${can('checkin') ? `<button class="btn btn-primary" onclick="navigate('checkin')">✅ Check In</button>` : ''}
      ${can('checkout') ? `<button class="btn btn-outline" onclick="navigate('residents')">🚪 Check Out</button>` : ''}
      ${can('payments') ? `<button class="btn btn-outline" onclick="navigate('payments')">💳 Take Payment</button>` : ''}
      ${can('addons') ? `<button class="btn btn-outline" onclick="showAddItemModal()">☕ Add item</button>` : ''}
      ${can('cash_close') ? `<button class="btn btn-outline" onclick="navigate('reconcile')">🗃 Close Cash</button>` : ''}
    </div>

    <h3 class="tasks-title">Today's tasks · ${fmtDate(d.date)}</h3>
    <div class="tasks">
      ${t.close_cash.yesterday_open && can('cash_close') ? `
        <div class="task warn"><div class="task-head"><span class="task-icon">🗃</span><strong>Yesterday's cash is not closed</strong></div>
          <div class="task-body"><button class="btn btn-warning btn-sm" onclick="navigate('reconcile')">Close cash now</button></div></div>` : ''}
      ${task('🚪', 'Leaving today', t.leaving_today.count, t.leaving_today.items.map(r =>
        row(`${h(r.full_name)} · ${h(r.bed || '')}`, h(r.mobile), can('checkout') ? `<button class="btn btn-danger btn-sm" onclick="showCheckoutModal('${r.id}','${esc(r.full_name)}')">Check out</button>` : '')).join(''), 'warn')}
      ${t.collect_dues ? task('💰', 'Collect dues', t.collect_dues.count, t.collect_dues.items.map(r =>
        row(`${h(r.full_name)} · ${rupees(r.dues_paise)}`, `${h(r.bed || (r.status === 'checked_out' ? 'left' : ''))} · ${r.days_overdue} days overdue`,
          can('payments') ? `<button class="btn btn-primary btn-sm" onclick="showPaymentModal('${r.id}','${esc(r.full_name)}')">Collect</button>` : '')).join('')
          + (t.collect_dues.count > t.collect_dues.items.length ? `<div class="td-small mt-12">+ ${t.collect_dues.count - t.collect_dues.items.length} more in Reports → Outstanding Dues</div>` : ''), 'bad') : ''}
      ${(d.left_today || []).length && (can('payments') || can('reports_finance') || can('checkout')) ? task('🧾', 'Left today — bills', d.left_today.length, d.left_today.map(r =>
        row(`${h(r.full_name)} · ${h(r.bed || '')}`, h(r.mobile), `<button class="btn btn-outline btn-sm" onclick="showBill('${r.id}')">🧾 Bill</button>`)).join('')) : ''}
      ${task('⏰', 'Overstaying', t.overstaying.count, t.overstaying.items.map(r =>
        row(`${h(r.full_name)} · ${h(r.bed || '')}`, `was due ${fmtDate(r.expected_checkout)}`,
          can('checkout') ? `<button class="btn btn-outline btn-sm" onclick="showCheckoutModal('${r.id}','${esc(r.full_name)}')">Check out</button>` : '')).join(''), 'warn')}
      ${task('📌', 'Arrivals on hold', t.arrivals.count, t.arrivals.items.map(a =>
        row(`${h(a.prospect_name)} · ${h(a.bed || '')}`, `${h(a.prospect_phone)} · hold till ${fmtDate(a.lock_expires_at)}`,
          can('checkin') ? `<button class="btn btn-primary btn-sm" onclick="navigate('checkin')">Check in</button>` : '')).join(''))}
      ${task('🧹', 'Beds to clean', t.beds_to_clean.count, t.beds_to_clean.items.map(x =>
        row(h(x.bed), 'mark ready when cleaned', `<button class="btn btn-outline btn-sm" onclick="markBedReady('${x.id}')">Ready</button>`)).join(''))}
      ${can('approvals') ? task('✔️', 'Waiting for your approval', t.approvals.count, t.approvals.items.map(a =>
        row(`${h(a.full_name)} · ${rupees(a.amount_paise)}`, a.type === 'deposit_refund' ? 'Refund at checkout' : h(a.type),
          `<button class="btn btn-success btn-sm" onclick="approvePayment('${a.id}','approved')">Approve</button>`)).join(''), 'warn') : ''}
    </div>`;
}

async function markBedReady(bedId) {
  try { await api('PATCH', `/beds/${bedId}/status`, { status: 'available' }); toast('Bed is ready', 'success'); refreshCurrentPage(); }
  catch (ex) { toast(ex.message, 'error'); }
}

// ── Beds — Floor Map ──────────────────────────────────────────
async function renderBeds(el) {
  const floors = await api('GET', '/floors');
  const ha = document.getElementById('header-actions');
  if (can('beds_setup')) {
    ha.innerHTML = `<button class="btn btn-primary btn-sm" onclick="showAddFloorModal()">+ Add floor</button>`;
  }
  if (!floors.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🛏</div>
      <p>No beds yet.</p>
      ${can('beds_setup') ? `<p class="mt-12">Add your first floor: choose how many bunkers it has and how many beds each bunker has.<br/>Beds are numbered automatically: <b>0A1, 0A2, 0B1…</b> You can change the names later.</p>
      <button class="btn btn-primary mt-12" onclick="showAddFloorModal()">+ Add floor</button>` : ''}</div>`;
    return;
  }
  let total = 0, occ = 0, avail = 0;
  floors.forEach(f => f.rooms.forEach(rm => { total += rm.total_beds; occ += rm.occupied; avail += rm.beds.filter(b => b.status === 'available').length; }));
  window._floorData = floors;
  const idx = Math.min(window._floorIdx || 0, floors.length - 1);
  el.innerHTML = `
    <div class="kpis mb-20">
      <div class="kpi"><span>Total beds</span><strong>${total}</strong></div>
      <div class="kpi"><span>Occupied</span><strong>${occ}</strong></div>
      <div class="kpi good"><span>Vacant</span><strong>${avail}</strong></div>
    </div>
    <div class="floor-tabs mb-12 btn-group">
      ${floors.map((f, i) => `<button class="btn btn-sm ${i === idx ? 'btn-primary' : 'btn-outline'}" onclick="switchFloor(${i})">${h(f.label)} <span class="td-small">(${f.rooms.reduce((a, r) => a + r.total_beds, 0)})</span></button>`).join('')}
    </div>
    <div class="legend mb-12"><span class="dot available"></span>Vacant <span class="dot occupied"></span>Occupied <span class="dot cleaning"></span>Cleaning <span class="dot reserved"></span>On hold</div>
    <div id="floor-content"></div>`;
  switchFloor(idx);
}

function switchFloor(idx) {
  window._floorIdx = idx;
  document.querySelectorAll('.floor-tabs button').forEach((b, i) => { b.className = `btn btn-sm ${i === idx ? 'btn-primary' : 'btn-outline'}`; });
  const floor = window._floorData[idx];
  if (!floor) return;
  const edit = !!window._bedEdit && can('beds_setup');
  const isFree = (b) => !b.resident_name && b.status !== 'occupied' && b.status !== 'reserved';
  const fc = document.getElementById('floor-content');
  fc.innerHTML = `
    ${can('beds_setup') ? `<div class="btn-group mb-12">
      ${edit ? `
        <button class="btn btn-primary btn-sm" onclick="setBedEdit(false)">✓ Done</button>
        <button class="btn btn-outline btn-sm" onclick="showAddBunkersModal('${floor.id}','${esc(floor.label)}')">+ Add bunker</button>
        ${floor.rooms.length ? `<button class="btn btn-outline btn-sm" onclick="showRenameModal(${idx})">✏️ Change names</button>` : ''}
        <button class="btn btn-outline btn-sm text-danger" onclick="removeFloorAsk('${floor.id}','${esc(floor.label)}')">🗑 Remove ${h(floor.label)}</button>`
      : `<button class="btn btn-outline btn-sm" onclick="setBedEdit(true)">✏️ Change beds (add / remove / rename)</button>`}
    </div>
    ${edit ? `<p class="td-small mb-12">Tap <b>+ Bed</b> to add a bed, <b>✕</b> to remove a bed, or <b>Remove bunker</b>. Beds with a guest or a booking can't be removed.</p>` : ''}` : ''}
    ${floor.rooms.length ? `<div class="bunker-grid">${floor.rooms.map(rm => `
      <div class="bunker ${edit ? 'editing' : ''}">
        <div class="bunker-name">Bunker ${h(rm.room_number)}</div>
        <div class="bunker-beds">${rm.beds.map(b => `
          <div class="bed-wrap">
            <button class="bed-chip ${b.status}" onclick="showBedDetail('${b.id}')" title="${h(b.status)}">
              <span class="bed-no">${h(b.bed_label)}</span>
              <span class="bed-who">${b.resident_name ? h(b.resident_name) : (b.status === 'available' ? 'Vacant' : h(b.status))}</span>
            </button>
            ${edit && isFree(b) ? `<button class="bed-x" title="Remove bed ${h(b.bed_label)}" aria-label="Remove bed ${h(b.bed_label)}" onclick="removeBedAsk('${b.id}','${esc(b.bed_label)}')">✕</button>` : ''}
          </div>`).join('')}
        </div>
        ${edit ? `<div class="bunker-tools">
          <button class="btn btn-outline btn-sm" onclick="addBedToBunker('${rm.id}')">+ Bed</button>
          <button class="btn btn-outline btn-sm text-danger" onclick="removeBunkerAsk('${rm.id}','${esc(rm.room_number)}')">Remove bunker</button>
        </div>` : ''}
      </div>`).join('')}</div>`
    : `<div class="empty-state"><p>No bunkers on this floor yet.</p>
        ${can('beds_setup') ? `<button class="btn btn-primary mt-12" onclick="showAddBunkersModal('${floor.id}','${esc(floor.label)}')">+ Add bunkers</button>` : ''}</div>`}`;
}

function setBedEdit(on) { window._bedEdit = on; switchFloor(window._floorIdx || 0); }

async function addBedToBunker(roomId) {
  try { const b = await api('POST', `/rooms/${roomId}/beds`, {}); toast(`Bed ${b.bed_label} added`, 'success'); renderPage('beds'); }
  catch (ex) { toast(ex.message, 'error'); }
}
async function removeBedAsk(bedId, label) {
  if (!confirm(`Remove bed ${label}?`)) return;
  try { await api('DELETE', `/beds/${bedId}`); toast(`Bed ${label} removed`, 'success'); renderPage('beds'); }
  catch (ex) { toast(ex.message, 'error'); }
}
async function removeBunkerAsk(roomId, name) {
  if (!confirm(`Remove bunker ${name} and all its beds?`)) return;
  try { const r = await api('DELETE', `/rooms/${roomId}`); toast(`Bunker ${name} removed (${r.beds} beds)`, 'success'); renderPage('beds'); }
  catch (ex) { toast(ex.message, 'error'); }
}
async function removeFloorAsk(floorId, label) {
  if (!confirm(`Remove ${label} with all its bunkers and beds?`)) return;
  try { const r = await api('DELETE', `/floors/${floorId}`); toast(`${label} removed (${r.beds} beds)`, 'success'); window._floorIdx = 0; renderPage('beds'); }
  catch (ex) { toast(ex.message, 'error'); }
}

// Change names of the floor, its bunkers and beds (e.g. 0A1 → 101-A).
function showRenameModal(idx) {
  const floor = window._floorData[idx];
  if (!floor) return;
  openModal(`Change names: ${floor.label}`, `
    <p class="td-small">Type your own names, e.g. <b>101-A</b>, <b>101-B</b>. Every bed needs its own name.
      Bills and history stay linked — only the name changes.</p>
    <div class="field mt-12"><label for="rn-floor">Floor name</label><input id="rn-floor" maxlength="40" value="${h(floor.label)}" /></div>
    <div class="rename-list">${floor.rooms.map(rm => `
      <div class="rename-bunker">
        <div class="field"><label for="rn-r-${rm.id}">Bunker</label><input id="rn-r-${rm.id}" data-room="${rm.id}" maxlength="20" value="${h(rm.room_number)}" /></div>
        <div class="rename-beds">${rm.beds.map(b => `
          <div class="field"><label for="rn-b-${b.id}">Bed</label><input id="rn-b-${b.id}" data-bed="${b.id}" maxlength="20" value="${h(b.bed_label)}" /></div>`).join('')}
        </div>
      </div>`).join('')}
    </div>
    <div id="rn-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12">
      <button class="btn btn-primary" id="rn-save" onclick="submitRename('${floor.id}')">Save names</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>`, { wide: true });
}

async function submitRename(floorId) {
  const err = document.getElementById('rn-error'); err.classList.add('hidden');
  const btn = document.getElementById('rn-save'); btn.disabled = true;
  const rooms = [...document.querySelectorAll('[data-room]')].map(i => ({ id: i.dataset.room, name: i.value.trim() }));
  const beds  = [...document.querySelectorAll('[data-bed]')].map(i => ({ id: i.dataset.bed, label: i.value.trim() }));
  try {
    const empty = [...rooms.map(r => r.name), ...beds.map(b => b.label)].some(v => !v);
    if (empty) throw new Error('A name is empty. Every bunker and bed needs a name.');
    const seen = new Set();
    for (const b of beds) { const k = b.label.toUpperCase(); if (seen.has(k)) throw new Error(`Bed name "${b.label}" is used twice`); seen.add(k); }
    const r = await api('PATCH', '/beds/names', { floors: [{ id: floorId, label: document.getElementById('rn-floor').value.trim() }], rooms, beds });
    toast(r.changed ? 'Names saved' : 'Nothing changed', 'success'); closeModal(); renderPage('beds');
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); btn.disabled = false; }
}

async function saveBedName(bedId) {
  const label = document.getElementById('br-name').value.trim();
  if (!label) { toast('Type a bed name', 'warning'); return; }
  try { await api('PATCH', '/beds/names', { beds: [{ id: bedId, label }] }); toast('Bed name saved', 'success'); closeModal(); refreshCurrentPage(); }
  catch (ex) { toast(ex.message, 'error'); }
}

function showAddFloorModal() {
  const next = (window._floorData || []).reduce((m, f) => Math.max(m, f.floor_number + 1), 0);
  openModal('Add Floor', `
    <div class="field-row">
      <div class="field"><label>Floor number *</label><input id="af-num" type="number" min="0" value="${next}" /><div class="field-note">0 = Ground floor. Used as the first digit of bed numbers.</div></div>
      <div class="field"><label>Name *</label><input id="af-label" value="${next === 0 ? 'Ground Floor' : `Floor ${next}`}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Number of bunkers *</label><input id="af-bunkers" type="number" min="1" max="100" value="6" /></div>
      <div class="field"><label>Beds per bunker *</label><input id="af-per" type="number" min="1" max="6" value="2" /></div>
    </div>
    <div class="field"><label>Rate per bed per day (₹)</label><input id="af-rate" type="number" min="0" step="0.01" placeholder="e.g. 400" /></div>
    <div class="preview-box" id="af-preview"></div>
    <div id="af-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12">
      <button class="btn btn-primary" id="af-submit" onclick="submitAddFloor()">Create floor and beds</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>`);
  const upd = () => {
    const n = document.getElementById('af-num').value || '0';
    const k = Math.max(0, Math.min(100, parseInt(document.getElementById('af-bunkers').value) || 0));
    const per = Math.max(0, Math.min(6, parseInt(document.getElementById('af-per').value) || 0));
    const letters = Array.from({ length: Math.min(k, 3) }, (_, i) => String.fromCharCode(65 + i));
    const sample = letters.map(L => Array.from({ length: per }, (_, j) => `${n}${L}${j + 1}`).join(', ')).join(' · ');
    document.getElementById('af-preview').innerHTML = k && per ? `<b>${k * per} beds</b> will be created: ${h(sample)}${k > 3 ? ' …' : ''}` : '';
  };
  ['af-num', 'af-bunkers', 'af-per'].forEach(id => document.getElementById(id).addEventListener('input', upd));
  upd();
}

async function submitAddFloor() {
  const err = document.getElementById('af-error'); err.classList.add('hidden');
  const btn = document.getElementById('af-submit'); btn.disabled = true;
  try {
    const f = await api('POST', '/floors', {
      floor_number: parseInt(document.getElementById('af-num').value),
      label: document.getElementById('af-label').value.trim(),
    });
    const r = await api('POST', `/floors/${f.id}/bunkers`, {
      bunkers: parseInt(document.getElementById('af-bunkers').value),
      beds_per_bunker: parseInt(document.getElementById('af-per').value),
      daily_rate_paise: Math.round((parseFloat(document.getElementById('af-rate').value) || 0) * 100),
    });
    toast(`${f.label}: ${r.total_beds} beds created`, 'success'); closeModal(); window._floorIdx = 99; renderPage('beds');
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); btn.disabled = false; }
}

function showAddBunkersModal(floorId, floorLabel) {
  openModal(`Add bunkers to ${floorLabel}`, `
    <div class="field-row">
      <div class="field"><label>Number of bunkers *</label><input id="ab-count" type="number" min="1" max="100" value="1" /></div>
      <div class="field"><label>Beds per bunker *</label><input id="ab-per" type="number" min="1" max="6" value="2" /></div>
    </div>
    <div class="field"><label>Rate per bed per day (₹)</label><input id="ab-rate" type="number" min="0" step="0.01" placeholder="e.g. 400" /></div>
    <p class="field-note">New bunkers continue the letters on this floor (e.g. after 0F comes 0G).</p>
    <div id="ab-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12">
      <button class="btn btn-primary" onclick="submitAddBunkers('${floorId}')">Add bunkers</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>`);
}

async function submitAddBunkers(floorId) {
  const err = document.getElementById('ab-error'); err.classList.add('hidden');
  try {
    const r = await api('POST', `/floors/${floorId}/bunkers`, {
      bunkers: parseInt(document.getElementById('ab-count').value),
      beds_per_bunker: parseInt(document.getElementById('ab-per').value),
      daily_rate_paise: Math.round((parseFloat(document.getElementById('ab-rate').value) || 0) * 100),
    });
    toast(`${r.total_beds} beds added (${r.created.map(c => c.bunker).join(', ')})`, 'success'); closeModal(); renderPage('beds');
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

async function showBedDetail(bedId) {
  const b = await api('GET', `/beds/${bedId}`);
  const isOwnerMgr = ['owner','manager'].includes(STATE.user.role);
  openModal(`Bed: ${b.bed_label}`, `
    <div class="field-row">
      <div><div class="stat-label">Status</div><span class="badge badge-${b.status==='available'?'success':b.status==='occupied'?'info':'warning'}">${b.status}</span></div>
      <div><div class="stat-label">Bunker</div><p>${h(b.room_number||'—')} · ${h(b.floor_label||'')}</p></div>
    </div>
    ${b.base_rate_paise ? `<div><div class="stat-label">Base Rate</div><p>${rupees(b.base_rate_paise)}/month</p></div>` : ''}
    ${b.daily_rate_paise ? `<div><div class="stat-label">Daily Rate</div><p>${rupees(b.daily_rate_paise)}/day</p></div>` : ''}
    ${b.resident_name ? `
      <hr class="divider"/>
      <div><strong>${h(b.resident_name)}</strong> · ${b.resident_mobile||''}</div>
      <div class="text-muted">Check-in: ${fmtDate(b.check_in_date)} · Expected out: ${fmtDate(b.expected_checkout)}</div>
      <div>Rate: ${rupees(b.rate_paise)} / ${b.rate_type === 'daily' ? 'day' : b.rate_type === 'weekly' ? 'week' : 'month'}</div>
      <div class="btn-group mt-12">
        <button class="btn btn-outline btn-sm" onclick="closeModal();showResidentDetail('${b.resident_id}')">View Details</button>
        ${can('payments') ? `<button class="btn btn-outline btn-sm" onclick="closeModal();showPaymentModal('${b.resident_id}','${esc(b.resident_name)}')">Record Payment</button>` : ''}
        ${can('addons') ? `<button class="btn btn-outline btn-sm" onclick="closeModal();showAddItemModal('${b.resident_id}','${esc(b.resident_name)}')">☕ Add item</button>` : ''}
        ${can('checkout') ? `<button class="btn btn-danger btn-sm" onclick="closeModal();showCheckoutModal('${b.resident_id}','${esc(b.resident_name)}')">Check Out</button>` : ''}
      </div>
    ` : ''}
    ${!b.resident_name && (b.status === 'available' || b.status === 'reserved') ? `
      <hr class="divider"/>
      <div class="btn-group">
        ${can('checkin') ? `<button class="btn btn-primary btn-sm" onclick="closeModal();navigateCheckinForBed('${b.id}')">✅ Check In to this bed</button>` : ''}
      </div>
    ` : ''}
    ${!b.resident_name && b.status !== 'occupied' ? `
      <hr class="divider"/>
      <div class="section-title">Change Status</div>
      <div class="btn-group">
        ${['available','cleaning'].filter(s=>s!==b.status).map(s =>
          `<button class="btn btn-outline btn-sm" onclick="changeBedStatus('${bedId}','${s}')">Set ${s}</button>`
        ).join('')}
      </div>
    ` : ''}
    ${can('beds_setup') ? `
      <hr class="divider"/>
      ${!b.resident_name && b.status !== 'occupied' && b.status !== 'reserved' ? `<div class="mb-12"><button class="btn btn-outline btn-sm text-danger" onclick="closeModal();removeBedAsk('${bedId}','${esc(b.bed_label)}')">🗑 Remove this bed</button></div>` : ''}
      <div class="section-title">Bed name</div>
      <div class="field-row">
        <div class="field"><label for="br-name">Name</label><input id="br-name" maxlength="20" value="${h(b.bed_label)}" /></div>
        <div><button class="btn btn-outline btn-sm" style="margin-top:24px" onclick="saveBedName('${bedId}')">Save name</button></div>
      </div>
      <div class="section-title">Set Daily Rate</div>
      <div class="field-row">
        <div class="field"><label>Daily Rate (₹/day)</label><input id="br-rate" type="number" min="0" step="0.01" value="${((b.daily_rate_paise||0)/100).toFixed(2)}" /></div>
        <div><button class="btn btn-outline btn-sm" style="margin-top:24px" onclick="saveBedRate('${bedId}')">Save Rate</button></div>
      </div>
    ` : ''}
  `);
}

function navigateCheckinForBed(bedId) {
  navigate('checkin');
  setTimeout(() => {
    const sel = document.getElementById('ci-bed');
    if (sel) { sel.value = bedId; sel.dispatchEvent(new Event('change')); }
  }, 300);
}

async function saveBedRate(bedId) {
  try {
    const rate = Math.round((parseFloat(document.getElementById('br-rate').value) || 0) * 100);
    await api('PATCH', `/beds/${bedId}/rate`, { daily_rate_paise: rate });
    toast(`Rate set to ${rupees(rate)}/day`, 'success');
    closeModal(); renderPage('beds');
  } catch(ex) { toast(ex.message, 'error'); }
}

async function changeBedStatus(bedId, status) {
  try {
    await api('PATCH', `/beds/${bedId}/status`, { status });
    toast(`Bed set to ${status}`, 'success');
    closeModal();
    renderPage('beds');
  } catch(ex) { toast(ex.message, 'error'); }
}

async function showAddBedModal() {
  const floors = await api('GET', '/floors');
  const roomOptions = floors.flatMap(f => f.rooms.map(r =>
    `<option value="${r.id}">${h(f.label)} › Room ${h(r.room_number)}</option>`
  )).join('');
  openModal('Add Bed', `
    <div class="field"><label>Room</label><select id="ab-room">${roomOptions}</select></div>
    <div class="field-row">
      <div class="field"><label>Bed Label *</label><input id="ab-label" placeholder="e.g. 101-D" /></div>
      <div class="field"><label>Daily Rate (₹/day)</label><input id="ab-rate" type="number" min="0" step="0.01" value="0" placeholder="e.g. 500 for ₹500/day" /></div>
    </div>
    <div class="btn-group mt-12">
      <button class="btn btn-primary" onclick="submitAddBed()">Add Bed</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitAddBed() {
  try {
    await api('POST', '/beds', {
      room_id: document.getElementById('ab-room').value,
      bed_label: document.getElementById('ab-label').value,
      daily_rate_paise: Math.round((parseFloat(document.getElementById('ab-rate').value) || 0) * 100),
    });
    toast('Bed added', 'success'); closeModal(); renderPage('beds');
  } catch(ex) { toast(ex.message, 'error'); }
}

// ── Check In ─────────────────────────────────────────────────
const ID_TYPES = [
  ['aadhaar', 'Aadhaar', '12-digit number'],
  ['driving_licence', 'Driving Licence', 'e.g. MH1220110012345'],
  ['passport', 'Passport', 'e.g. K1234567'],
  ['voter_id', 'Voter ID', 'e.g. ABC1234567'],
  ['pan', 'PAN Card', 'e.g. ABCDE1234F'],
  ['other', 'Other', 'ID number'],
];

async function renderCheckin(el) {
  const [avail, reserved] = await Promise.all([
    api('GET', '/beds?status=available'),
    api('GET', '/beds?status=reserved'),
  ]);
  const beds = [...avail, ...reserved];
  if (!beds.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🛏</div><p>No vacant beds right now.</p></div>`;
    return;
  }
  window._bedRates = {};
  beds.forEach(b => { window._bedRates[b.id] = b.daily_rate_paise || 0; });
  const prof = await getProfile(true).catch(() => ({}));
  const rentGst = prof.gst_enabled ? { bp: prof.rent_gst_rate_bp || 0, incl: prof.rent_gst_inclusive !== false } : { bp: 0, incl: true };
  const bedOpts = beds.map(b => `<option value="${b.id}">${h(b.bed_label)}${b.status === 'reserved' ? ' (on hold)' : ''}${b.daily_rate_paise ? ` — ${rupees(b.daily_rate_paise)}/day` : ''}</option>`).join('');
  const today = todayIST();

  el.innerHTML = `
    <form id="checkin-form" class="card ci" onsubmit="return false">
      <div id="ci-error" class="error-msg hidden"></div>

      <div class="ci-step"><span class="ci-num">1</span><strong>Guest</strong></div>
      <div class="field-row">
        <div class="field"><label for="ci-name">Full name *</label><input id="ci-name" autocomplete="off" required /></div>
        <div class="field"><label for="ci-mobile">Mobile *</label><input id="ci-mobile" type="tel" inputmode="numeric" maxlength="12" required /></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="ci-idtype">ID proof *</label>
          <select id="ci-idtype">${ID_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="field"><label for="ci-idnum">ID number *</label><input id="ci-idnum" autocomplete="off" placeholder="12-digit number" /></div>
      </div>
      <div class="field">
        <label>Photo of ID <span class="field-note">(front and back — optional but recommended)</span></label>
        <div class="upload-row">
          <label class="upload-box" id="up-front-box"><input type="file" id="up-front" accept="image/*,application/pdf" capture="environment" hidden /><span>📷 Front</span></label>
          <label class="upload-box" id="up-back-box"><input type="file" id="up-back" accept="image/*,application/pdf" capture="environment" hidden /><span>📷 Back</span></label>
        </div>
      </div>

      <div class="ci-step"><span class="ci-num">2</span><strong>Stay</strong></div>
      <div class="field-row">
        <div class="field"><label for="ci-bed">Bed *</label><select id="ci-bed">${bedOpts}</select></div>
        <div class="field"><label for="ci-rate-type">Charged</label>
          <select id="ci-rate-type"><option value="daily">Per day</option><option value="weekly">Per week</option><option value="monthly">Per month</option></select></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="ci-checkin">Check-in *</label><input id="ci-checkin" type="date" value="${today}" /></div>
        <div class="field"><label for="ci-checkout">Leaving on *</label><input id="ci-checkout" type="date" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="ci-rent">Rate (₹) *</label><input id="ci-rent" type="number" min="0" step="0.01" inputmode="decimal" /></div>
        <div class="field"><label for="ci-deposit">Deposit (₹)</label><input id="ci-deposit" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0" /></div>
      </div>

      <div class="ci-step"><span class="ci-num">3</span><strong>Payment now</strong></div>
      <div class="field-row">
        <div class="field"><label for="ci-advance">Rent paid now (₹)</label><input id="ci-advance" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0" /></div>
        <div class="field"><label for="ci-mode">Paid by</label>
          <select id="ci-mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank_transfer">Bank transfer</option></select></div>
      </div>
      <div class="summary-box" id="ci-summary"></div>
      ${cashChangeBox('ci')}

      <details class="more">
        <summary>More details (address, emergency contact, notes)</summary>
        <div class="field"><label for="ci-address">Permanent address</label><textarea id="ci-address" rows="2"></textarea></div>
        <div class="field-row">
          <div class="field"><label for="ci-ec-name">Emergency contact name</label><input id="ci-ec-name" /></div>
          <div class="field"><label for="ci-ec-mobile">Emergency contact mobile</label><input id="ci-ec-mobile" type="tel" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="ci-from">Coming from</label><input id="ci-from" /></div>
          <div class="field"><label for="ci-purpose">Purpose of stay</label><input id="ci-purpose" placeholder="Work, study, travel…" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="ci-due-day">Monthly rent due on day</label><input id="ci-due-day" type="number" min="1" max="28" /><div class="field-note">For monthly stays. Default: the check-in day.</div></div>
          <div class="field"><label for="ci-notes">Notes</label><input id="ci-notes" /></div>
        </div>
      </details>

      <label class="consent"><input type="checkbox" id="ci-consent" /> The guest agrees to their ID being stored (DPDP Act 2023)</label>

      <div class="btn-group mt-12">
        <button type="submit" id="ci-submit" class="btn btn-primary btn-lg" onclick="submitCheckin()">✅ Check in</button>
        <button type="button" class="btn btn-outline" onclick="navigate('dashboard')">Cancel</button>
      </div>
    </form>`;

  window._ciFiles = {};
  const $ = (id) => document.getElementById(id);
  const setOut = () => {
    const t = $('ci-rate-type').value, start = $('ci-checkin').value || today;
    const days = t === 'daily' ? 1 : t === 'weekly' ? 7 : 30;
    $('ci-checkout').value = new Date(Date.parse(start) + days * 86400000).toISOString().slice(0, 10);
  };
  const fillRate = () => {
    const daily = window._bedRates[$('ci-bed').value] || 0;
    if (!daily) return;
    const t = $('ci-rate-type').value;
    $('ci-rent').value = ((daily * (t === 'daily' ? 1 : t === 'weekly' ? 7 : 30)) / 100).toFixed(2);
  };
  const summary = () => {
    const rate = parseFloat($('ci-rent').value) || 0, dep = parseFloat($('ci-deposit').value) || 0, adv = parseFloat($('ci-advance').value) || 0;
    const t = $('ci-rate-type').value;
    const nights = Math.max(0, Math.round((Date.parse($('ci-checkout').value) - Date.parse($('ci-checkin').value)) / 86400000));
    const stay = t === 'daily' ? rate * nights : null;
    const withGst = (rupeesAmt) => gstSplit(Math.round(rupeesAmt * 100), rentGst.bp, rentGst.incl).gross;
    const gstNote = rentGst.bp ? ` · rent ${rentGst.incl ? 'includes' : 'plus'} ${rentGst.bp / 100}% GST` +
      (rentGst.incl ? '' : ` = ${rupees(withGst(rate))} per ${t === 'daily' ? 'day' : t === 'weekly' ? 'week' : 'month'}`) : '';
    $('ci-summary').innerHTML = `
      <div><span>Collect now</span><b>${rupees(Math.round((dep + adv) * 100))}</b></div>
      <div class="td-small">Deposit ${rupees(Math.round(dep * 100))} + rent ${rupees(Math.round(adv * 100))}${stay !== null && nights ? ` · full stay of ${nights} night${nights > 1 ? 's' : ''} = ${rupees(withGst(stay))}` : ''}${gstNote}</div>`;
  };
  const idHint = () => { const t = ID_TYPES.find(x => x[0] === $('ci-idtype').value); $('ci-idnum').placeholder = t ? t[2] : ''; };
  $('ci-bed').addEventListener('change', () => { fillRate(); summary(); });
  $('ci-rate-type').addEventListener('change', () => { fillRate(); setOut(); summary(); });
  $('ci-checkin').addEventListener('change', () => { setOut(); summary(); });
  ['ci-checkout', 'ci-rent', 'ci-deposit', 'ci-advance'].forEach(id => $(id).addEventListener('input', summary));
  const ciChange = bindCashChange('ci', () => (parseFloat($('ci-deposit').value) || 0) + (parseFloat($('ci-advance').value) || 0), () => $('ci-mode').value);
  ['ci-deposit', 'ci-advance'].forEach(id => $(id).addEventListener('input', ciChange));
  $('ci-mode').addEventListener('change', ciChange);
  $('ci-idtype').addEventListener('change', idHint);
  ['front', 'back'].forEach(side => $(`up-${side}`).addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      window._ciFiles[side] = await fileToUpload(f);
      $(`up-${side}-box`).classList.add('done');
      $(`up-${side}-box`).querySelector('span').textContent = `✓ ${side === 'front' ? 'Front' : 'Back'} added`;
    } catch (ex) { toast(ex.message, 'error'); }
  }));
  fillRate(); setOut(); summary(); idHint();
}

/** Shrink a phone photo to ≤1600px JPEG (~200–400 KB) before upload; PDFs pass through. */
async function fileToUpload(file) {
  if (file.type === 'application/pdf') {
    if (file.size > 1500 * 1024) throw new Error('PDF is too large (max 1.5 MB)');
    return await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => bad(new Error('Could not read the file')); r.readAsDataURL(file); });
  }
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo or a PDF');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('Could not open the photo')); i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } finally { URL.revokeObjectURL(url); }
}

async function uploadResidentDocs(residentId, files) {
  let failed = 0;
  for (const [side, dataUrl] of Object.entries(files)) {
    try { await api('POST', `/residents/${residentId}/documents`, { doc_type: side === 'front' ? 'id_front' : 'id_back', data_url: dataUrl }); }
    catch (_) { failed++; }
  }
  return failed;
}



async function submitCheckin() {
  const err = document.getElementById('ci-error');
  err.classList.add('hidden');
  const $ = (id) => document.getElementById(id);
  const fail = (msg, focusId) => {
    err.textContent = msg; err.classList.remove('hidden'); err.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (focusId) $(focusId).focus();
  };
  if (!$('ci-name').value.trim()) return fail('Enter the guest\'s name', 'ci-name');
  if ($('ci-mobile').value.replace(/\D/g, '').length < 10) return fail('Enter a 10-digit mobile number', 'ci-mobile');
  if (!$('ci-idnum').value.trim()) return fail('Enter the ID number', 'ci-idnum');
  if (!$('ci-checkout').value) return fail('Choose the leaving date', 'ci-checkout');
  if (!(parseFloat($('ci-rent').value) > 0)) return fail('Enter the rate', 'ci-rent');
  if (!$('ci-consent').checked) return fail('Tick the consent box to store the guest\'s ID', 'ci-consent');

  const btn = $('ci-submit');
  btn.disabled = true; btn.textContent = 'Checking in…';
  try {
    const checkIn = $('ci-checkin').value;
    const data = {
      full_name: $('ci-name').value.trim(), mobile: $('ci-mobile').value.trim(),
      id_type: $('ci-idtype').value, id_number: $('ci-idnum').value.trim(), id_consent: true,
      bed_id: $('ci-bed').value, check_in_date: checkIn, expected_checkout: $('ci-checkout').value,
      rate_type: $('ci-rate-type').value,
      rate_paise: Math.round((parseFloat($('ci-rent').value) || 0) * 100),
      deposit_paise: Math.round((parseFloat($('ci-deposit').value) || 0) * 100),
      amount_paid_paise: Math.round((parseFloat($('ci-advance').value) || 0) * 100),
      payment_mode: $('ci-mode').value,
      permanent_address: $('ci-address').value.trim(), emergency_contact_name: $('ci-ec-name').value.trim(),
      emergency_contact_mobile: $('ci-ec-mobile').value.trim(), coming_from: $('ci-from').value.trim(),
      purpose_of_visit: $('ci-purpose').value.trim(), notes: $('ci-notes').value.trim(),
      rent_due_day: parseInt($('ci-due-day').value) || Math.min(28, parseInt(checkIn.slice(8)) || 1),
    };
    const res = await api('POST', '/residents', data);
    const failed = await uploadResidentDocs(res.resident.id, window._ciFiles || {});
    toast(failed ? `${data.full_name} checked in. ${failed} ID photo(s) did not upload — add them from the resident's page.`
                 : `${data.full_name} checked in to ${$('ci-bed').selectedOptions[0].text.split(' ')[0]}`, failed ? 'warning' : 'success', 6000);
    navigate('dashboard');
  } catch (ex) {
    fail(ex.message || 'Check-in failed');
    btn.disabled = false; btn.textContent = '✅ Check in';
  }
}

// ── Residents ─────────────────────────────────────────────────
async function renderResidents(el) {
  const ha = document.getElementById('header-actions');
  ha.innerHTML = `
    <input id="res-search" class="hdr-input" placeholder="Search name, mobile or bed…" />
    <select id="res-status" class="hdr-input" aria-label="Show"><option value="active">Staying now</option><option value="checked_out">Left (past guests)</option><option value="all">All guests</option></select>`;
  if (STATE.resStatus) document.getElementById('res-status').value = STATE.resStatus;

  async function load() {
    const search = document.getElementById('res-search')?.value.trim().toLowerCase() || '';
    const status = document.getElementById('res-status')?.value || 'active';
    STATE.resStatus = status;
    const all = await api('GET', `/residents?status=${status}`);
    const residents = search ? all.filter(r => [r.full_name, r.mobile, r.bed_label].some(v => String(v || '').toLowerCase().includes(search))) : all;
    const today = todayIST();
    el.innerHTML = residents.length ? `
      <div class="card table-wrap">
        <table class="res-table">
          <thead><tr><th>Resident</th><th>Bed</th><th>Stay</th><th class="num">Dues</th><th></th></tr></thead>
          <tbody>
            ${residents.map(r => {
              const out = r.actual_checkout || r.expected_checkout;
              const late = r.status === 'active' && out && out < today;
              return `<tr>
                <td><a href="#" class="td-name" onclick="event.preventDefault();showResidentDetail('${r.id}')">${h(r.full_name)}</a><div class="td-small">${h(r.mobile)}</div></td>
                <td><b>${h(r.bed_label || '—')}</b></td>
                <td>${fmtDate(r.check_in_date)} → <span class="${late ? 'text-danger' : ''}">${fmtDate(out)}</span>${late ? '<div class="td-small text-danger">overstaying</div>' : ''}${r.status !== 'active' ? '<div class="td-small">left</div>' : ''}</td>
                <td class="num">${r.pending_rent_paise > 0 ? `<span class="text-danger fw-bold">${rupees(r.pending_rent_paise)}</span>` : r.advance_credit_paise > 0 ? `<span class="text-success">${rupees(r.advance_credit_paise)} adv</span>` : '<span class="text-success">Paid</span>'}</td>
                <td class="actions">
                  ${r.status === 'active' && can('addons') ? `<button class="btn btn-outline btn-sm" title="Add tea, coffee, laundry… to the bill" onclick="showAddItemModal('${r.id}','${esc(r.full_name)}')">☕ Item</button>` : ''}
                  ${r.status === 'active' && can('payments') ? `<button class="btn btn-outline btn-sm" onclick="showPaymentModal('${r.id}','${esc(r.full_name)}')">Pay</button>` : ''}
                  ${r.status !== 'active' && (can('payments') || can('reports_finance') || can('checkout')) ? `<button class="btn btn-outline btn-sm" onclick="showBill('${r.id}')">🧾 Bill</button>` : ''}
                  ${r.status === 'active' && can('checkout') ? `<button class="btn btn-danger btn-sm" onclick="showCheckoutModal('${r.id}','${esc(r.full_name)}')">Check out</button>` : ''}
                </td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>` : `<div class="empty-state"><div class="empty-icon">👥</div><p>${status === 'active' && !search ? 'Nobody is staying now.' : 'No guests found'}</p>
      ${status === 'active' ? `<button class="btn btn-outline btn-sm mt-12" onclick="STATE.resStatus='checked_out';renderPage('residents')">See past guests</button>` : ''}</div>`;
  }
  await load();
  document.getElementById('res-search').addEventListener('input', () => { clearTimeout(window._rsTimer); window._rsTimer = setTimeout(load, 250); });
  document.getElementById('res-status').addEventListener('change', load);
}

async function showResidentDetail(id) {
  const r = await api('GET', `/residents/${id}`);
  const docs = r.documents || [];
  const label = { id_front: 'ID front', id_back: 'ID back', photo: 'Photo', other: 'Document' };
  openModal(`${r.full_name}`, `
    <dl class="facts">
      <div><dt>Mobile</dt><dd>${h(r.mobile)}</dd></div>
      <div><dt>Bed</dt><dd>${h(r.bed_label || '—')}</dd></div>
      <div><dt>Check-in</dt><dd>${fmtDate(r.check_in_date)}</dd></div>
      <div><dt>${r.status === 'active' ? 'Leaving on' : 'Left on'}</dt><dd>${fmtDate(r.actual_checkout || r.expected_checkout)}</dd></div>
      <div><dt>Rate</dt><dd>${rupees(r.rate_paise)} / ${r.rate_type === 'daily' ? 'day' : r.rate_type === 'weekly' ? 'week' : 'month'}</dd></div>
      <div><dt>ID proof</dt><dd>${h(r.id_display || r.aadhaar_display || '—')}</dd></div>
      ${r.balance ? `<div><dt>${r.balance.dues_paise >= 0 ? 'Dues' : 'Advance paid'}</dt><dd class="${r.balance.dues_paise > 0 ? 'text-danger' : 'text-success'} fw-bold">${rupees(Math.abs(r.balance.dues_paise))}</dd></div>
      <div><dt>Deposit held</dt><dd>${rupees(r.balance.deposit_paise)}</dd></div>` : ''}
    </dl>
    <div class="section-title">ID documents</div>
    <div class="doc-row">
      ${docs.map(d => can('view_id_docs')
        ? `<button class="btn btn-outline btn-sm" onclick="viewDocument('${r.id}','${d.id}')">📄 ${label[d.doc_type] || 'Document'}</button>`
        : `<span class="badge badge-gray">📄 ${label[d.doc_type] || 'Document'}</span>`).join('') || '<span class="text-muted">No ID photo uploaded</span>'}
      ${can('checkin') || can('view_id_docs') ? `<label class="btn btn-outline btn-sm">+ Add photo<input type="file" accept="image/*,application/pdf" capture="environment" hidden onchange="addResidentDoc('${r.id}', this)" /></label>` : ''}
    </div>
    <div class="btn-group mt-12">
      ${r.status === 'active' && can('payments') ? `<button class="btn btn-primary btn-sm" onclick="closeModal();showPaymentModal('${r.id}','${esc(r.full_name)}')">Record payment</button>` : ''}
      ${r.status === 'active' && can('addons') ? `<button class="btn btn-outline btn-sm" onclick="closeModal();showAddItemModal('${r.id}','${esc(r.full_name)}')">☕ Add item</button>` : ''}
      ${can('payments') || can('reports_finance') || can('checkout') ? `<button class="btn btn-outline btn-sm" onclick="closeModal();showBill('${r.id}')">🧾 Bill</button>` : ''}
      ${can('payments') || can('reports_finance') ? `<button class="btn btn-outline btn-sm" onclick="closeModal();showStatement('${r.id}')">Statement</button>` : ''}
      ${r.status === 'active' && can('checkout') ? `<button class="btn btn-danger btn-sm" onclick="closeModal();showCheckoutModal('${r.id}','${esc(r.full_name)}')">Check out</button>` : ''}
    </div>
  `, { wide: true });
}

async function viewDocument(residentId, docId) {
  try {
    const res = await fetch(`/api/v1/residents/${residentId}/documents/${docId}`, { headers: { Authorization: `Bearer ${STATE.token}` } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not open the document');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const isPdf = blob.type === 'application/pdf';
    openModal('ID document', isPdf ? `<iframe src="${url}" style="width:100%;height:70vh;border:0"></iframe>` : `<img src="${url}" alt="ID document" style="width:100%;border-radius:8px" />`, { wide: true });
  } catch (ex) { toast(ex.message, 'error'); }
}

async function addResidentDoc(residentId, input) {
  const f = input.files[0];
  if (!f) return;
  try {
    const dataUrl = await fileToUpload(f);
    await api('POST', `/residents/${residentId}/documents`, { doc_type: 'id_front', data_url: dataUrl });
    toast('ID photo saved', 'success');
    showResidentDetail(residentId);
  } catch (ex) { toast(ex.message, 'error'); }
}

async function showCheckoutModal(id, name) {
  const today = todayIST();
  openModal(`Check out: ${name}`, `
    <div class="field-row">
      <div class="field"><label for="co-date">Leaving date</label><input id="co-date" type="date" value="${today}" max="${today}" /></div>
      <div class="field"><label for="co-extra">Damage / extra charges (₹)</label><input id="co-extra" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0" /></div>
    </div>
    <div class="field" id="co-note-wrap" hidden><label for="co-extra-note">What for?</label><input id="co-extra-note" placeholder="e.g. broken locker key" /></div>
    <div id="co-bill" class="bill"><div class="loading-spinner" style="margin:12px auto"></div></div>
    <div class="field"><label for="co-mode">Money paid / returned by</label>
      <select id="co-mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank transfer</option><option value="card">Card</option></select></div>
    ${cashChangeBox('co')}
    <div id="co-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12">
      <button class="btn btn-danger btn-lg" id="co-submit" disabled onclick="submitCheckout('${id}')">Confirm check-out</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>`);
  const load = async () => {
    const date = document.getElementById('co-date').value || today;
    const extra = Math.round((parseFloat(document.getElementById('co-extra').value) || 0) * 100);
    document.getElementById('co-note-wrap').hidden = !extra;
    try {
      const p = await api('GET', `/residents/${id}/checkout-preview?date=${date}&extra_paise=${extra}`);
      window._coPreview = p;
      const line = (l, v, cls = '') => `<div class="bill-line ${cls}"><span>${l}</span><span>${v}</span></div>`;
      document.getElementById('co-bill').innerHTML =
        line(`Rent for ${p.resident.nights} ${p.resident.rate_type === 'daily' ? 'night' : 'day'}${p.resident.nights > 1 ? 's' : ''} (${fmtDate(p.resident.check_in_date)} → ${fmtDate(date)})`, rupees(p.rent_total_paise))
        + (p.other_charges_paise ? line('Other charges', rupees(p.other_charges_paise)) : '')
        + (p.extra_charges_paise ? line('Damage / extra', rupees(p.extra_charges_paise)) : '')
        + line('Already paid', '− ' + rupees(p.paid_paise))
        + line('Deposit held', rupees(p.deposit_held_paise))
        + (p.to_collect_paise > 0
          ? line('<b>Collect from guest</b>', `<b>${rupees(p.to_collect_paise)}</b>`, 'bill-total bad')
          : line('<b>Give back to guest</b>', `<b>${rupees(p.refund_paise)}</b>`, 'bill-total good'))
        + (p.needs_approval ? '<div class="td-small mt-12">The refund will wait for the owner\'s approval. The bed is freed after approval.</div>' : '');
      window._coChange && window._coChange();
      const btn = document.getElementById('co-submit');
      btn.disabled = false;
      btn.textContent = p.to_collect_paise > 0 ? `Collect ${rupees(p.to_collect_paise)} & check out`
        : p.refund_paise > 0 ? `Refund ${rupees(p.refund_paise)} & check out` : 'Confirm check-out';
    } catch (ex) {
      document.getElementById('co-bill').innerHTML = `<div class="error-msg">${h(ex.message)}</div>`;
      document.getElementById('co-submit').disabled = true;
    }
  };
  window._coChange = bindCashChange('co', () => (window._coPreview && window._coPreview.to_collect_paise > 0 ? window._coPreview.to_collect_paise / 100 : 0),
    () => document.getElementById('co-mode').value);
  document.getElementById('co-mode').addEventListener('change', window._coChange);
  document.getElementById('co-date').addEventListener('change', load);
  document.getElementById('co-extra').addEventListener('input', () => { clearTimeout(window._coT); window._coT = setTimeout(load, 300); });
  load();
}

async function submitCheckout(id) {
  const err = document.getElementById('co-error');
  err.classList.add('hidden');
  const p = window._coPreview;
  if (!p) return;
  const btn = document.getElementById('co-submit');
  btn.disabled = true;
  try {
    const res = await api('POST', `/residents/${id}/checkout`, {
      checkout_date: document.getElementById('co-date').value,
      extra_charges_paise: p.extra_charges_paise,
      extra_charges_note: document.getElementById('co-extra-note').value.trim() || undefined,
      deposit_refund_paise: p.refund_paise,
      collect_paise: p.to_collect_paise,
      payment_mode: document.getElementById('co-mode').value,
    });
    toast(res.refund_pending_approval ? 'Check-out sent for owner approval' : 'Checked out. Bed marked for cleaning.',
      res.refund_pending_approval ? 'warning' : 'success', 5000);
    closeModal(); refreshCurrentPage();
    // Show the final bill right away: print it or send it on WhatsApp. It stays in Guests → Left.
    showBill(id, { justCheckedOut: !res.refund_pending_approval });
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); btn.disabled = false; }
}

// ── Payments ─────────────────────────────────────────────────
async function renderPayments(el) {
  const [residents, pending] = await Promise.all([
    api('GET', '/residents?status=active'),
    api('GET', '/payments/pending-approvals').catch(() => []),
  ]);

  const resOpts = residents.map(r =>
    `<option value="${r.id}">${h(r.full_name)} — ${h(r.bed_label||'')}</option>`
  ).join('');

  el.innerHTML = `
    ${pending.length ? `
      <div class="card mb-20" style="border-left:3px solid var(--warning)">
        <strong>⚠️ ${pending.length} Pending Approval(s)</strong>
        <div class="table-wrap mt-12">
          <table>
            <thead><tr><th>Resident</th><th>Type</th><th>Amount</th><th>Recorded</th><th>Actions</th></tr></thead>
            <tbody>
              ${pending.map(p => `
                <tr>
                  <td>${h(p.resident_name)}</td><td>${p.type}</td>
                  <td>${rupees(p.amount_paise)}</td><td>${fmtDate(p.created_at)}</td>
                  <td>
                    <button class="btn btn-success btn-sm" onclick="approvePayment('${p.id}','approved')">Approve</button>
                    <button class="btn btn-danger btn-sm" onclick="approvePayment('${p.id}','rejected')">Reject</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    ` : ''}
    <div class="card">
      <strong>Record Payment</strong>
      <div class="field mt-12"><label>Resident *</label><select id="pay-resident">${resOpts}</select></div>
      <div class="field-row">
        <div class="field"><label>Type</label>
          <select id="pay-type">
            <option value="rent">Rent</option><option value="deposit">Deposit</option>
            <option value="advance">Advance</option><option value="extra_charge">Extra Charge</option>
          </select>
        </div>
        <div class="field"><label>Amount (₹) *</label><input id="pay-amount" type="number" min="0.01" step="0.01" placeholder="e.g. 5000" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Payment Mode</label>
          <select id="pay-mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank_transfer">Bank Transfer</option></select>
        </div>
        <div class="field"><label>Billing Month</label><input id="pay-month" type="month" value="${todayIST().slice(0,7)}" /></div>
      </div>
      ${cashChangeBox('pay')}
      <div class="field"><label>Notes</label><input id="pay-notes" /></div>
      <div id="pay-error" class="error-msg hidden"></div>
      <button class="btn btn-primary mt-12" onclick="submitPayment()">💳 Record Payment</button>
    </div>
  `;
  const upd = bindCashChange('pay', () => document.getElementById('pay-amount').value, () => document.getElementById('pay-mode').value);
  document.getElementById('pay-amount').addEventListener('input', upd);
  document.getElementById('pay-mode').addEventListener('change', upd);
}

async function showPaymentModal(residentId, residentName) {
  let dues = 0;
  try { const r = await api('GET', `/residents/${residentId}`); dues = r.balance && r.balance.dues_paise > 0 ? r.balance.dues_paise : 0; } catch (_) { /* amount can still be typed */ }
  openModal(`Take payment: ${residentName}`, `
    <input type="hidden" id="pm-resident" value="${residentId}" />
    <div class="field-row">
      <div class="field"><label>Type</label>
        <select id="pm-type"><option value="rent">Rent</option><option value="advance">Advance</option><option value="deposit">Deposit</option><option value="extra_charge">Extra Charge</option></select>
      </div>
      <div class="field"><label>Amount (₹) *</label><input id="pm-amount" type="number" min="0.01" step="0.01" placeholder="e.g. 5000" value="${dues ? (dues / 100) : ''}" />
        ${dues ? `<div class="field-note">Due now: ${rupees(dues)}</div>` : ''}</div>
    </div>
    <div class="field-row">
      <div class="field"><label>Payment Mode</label>
        <select id="pm-mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option><option value="bank_transfer">Bank Transfer</option></select>
      </div>
      <div class="field"><label>Billing Month</label><input id="pm-month" type="month" value="${todayIST().slice(0,7)}" /></div>
    </div>
    ${cashChangeBox('pm')}
    <div class="field"><label>Notes</label><input id="pm-notes" /></div>
    <div id="pm-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12">
      <button class="btn btn-primary" onclick="submitModalPayment()">💳 Record Payment</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>
  `);
  const upd = bindCashChange('pm', () => document.getElementById('pm-amount').value, () => document.getElementById('pm-mode').value);
  document.getElementById('pm-amount').addEventListener('input', upd);
  document.getElementById('pm-mode').addEventListener('change', upd);
}

// Records a payment; if the server says an identical one was saved <1 min ago,
// ask before saving it again (protects against double-clicks and double entry).
async function postPayment(body) {
  try {
    return await api('POST', '/payments', body);
  } catch (ex) {
    if (ex.data && ex.data.code === 'POSSIBLE_DUPLICATE' &&
        confirm('The same payment was recorded less than a minute ago.\n\nRecord it AGAIN as a second payment?')) {
      return api('POST', '/payments', { ...body, confirm_duplicate: true });
    }
    throw ex;
  }
}

async function submitModalPayment() {
  const err = document.getElementById('pm-error');
  err.classList.add('hidden');
  try {
    await postPayment({
      resident_id:   document.getElementById('pm-resident').value,
      type:          document.getElementById('pm-type').value,
      amount_paise:  Math.round((parseFloat(document.getElementById('pm-amount').value) || 0) * 100),
      payment_mode:  document.getElementById('pm-mode').value,
      billing_month: document.getElementById('pm-month').value,
      notes:         document.getElementById('pm-notes').value,
    });
    toast('Payment recorded', 'success');
    closeModal();
    refreshCurrentPage();
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

async function submitPayment() {
  const err = document.getElementById('pay-error');
  err.classList.add('hidden');
  try {
    await postPayment({
      resident_id:   document.getElementById('pay-resident').value,
      type:          document.getElementById('pay-type').value,
      amount_paise:  Math.round((parseFloat(document.getElementById('pay-amount').value) || 0) * 100),
      payment_mode:  document.getElementById('pay-mode').value,
      billing_month: document.getElementById('pay-month').value,
      notes:         document.getElementById('pay-notes').value,
    });
    toast('Payment recorded and receipt generated', 'success');
    renderPage('payments');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

async function approvePayment(id, decision) {
  try {
    await api('POST', `/payments/${id}/approve`, { decision });
    toast(`Payment ${decision}`, decision === 'approved' ? 'success' : 'warning');
    refreshCurrentPage();
  } catch(ex) { toast(ex.message, 'error'); }
}

// ── Add-ons ───────────────────────────────────────────────────
// ── Add item to a guest's bill (tea, coffee, laundry…) ─────────
// Items come from Settings → Items & Prices. "Add to bill" puts the amount in
// the guest's dues (collected later or at checkout); "Paid now" records the
// payment at the same time.
async function showAddItemModal(residentId, residentName) {
  let catalog = [], guests = [], prof = {};
  try {
    [catalog, guests, prof] = await Promise.all([
      api('GET', '/addons/catalog'),
      residentId ? Promise.resolve([]) : api('GET', '/residents?status=active'),
      getProfile(true).catch(() => ({})),
    ]);
  } catch (ex) { toast(ex.message, 'error'); return; }
  const gstOn = !!prof.gst_enabled;
  // Price the guest pays per unit (GST added when the item's price is "plus GST").
  catalog.forEach(c => { c._bp = gstOn ? (c.gst_rate_bp || 0) : 0; c._incl = c.gst_inclusive !== 0; c._each = gstSplit(c.default_price_paise, c._bp, c._incl).gross; });
  if (!residentId && !guests.length) { toast('No guest is staying right now', 'warning'); return; }

  window._cart = { lines: [], catalog, gstOn };
  openModal(residentName ? `Add item: ${residentName}` : 'Add item to bill', `
    ${residentId ? `<input type="hidden" id="ai-guest" value="${h(residentId)}" />` : `
      <div class="field"><label for="ai-guest">Guest *</label>
        <select id="ai-guest"><option value="">— choose guest —</option>${guests.map(g =>
          `<option value="${h(g.id)}">${h(g.bed_label || '—')} · ${h(g.full_name)}</option>`).join('')}</select></div>`}
    ${catalog.length ? `
      <div class="section-title">Tap to add</div>
      <div class="item-grid">${catalog.map((c, i) =>
        `<button type="button" class="item-btn" onclick="cartAdd(${i})"><span>${h(c.name)}</span><b>${rupees(c._each)}</b>${c._bp ? `<em>${c._incl ? 'incl.' : '+'} ${c._bp / 100}% GST</em>` : ''}</button>`).join('')}
      </div>` : `
      <div class="preview-box">Your price list is empty. ${can('settings')
        ? `<a href="#" onclick="event.preventDefault();closeModal();navigate('catalog')">Add items like Tea, Coffee in Settings → Items &amp; Prices</a>, or type an item below.`
        : 'Ask the owner to add items in Settings → Items & Prices, or type an item below.'}</div>`}
    <details class="mt-12" ${catalog.length ? '' : 'open'}><summary class="td-small">Something not in the list?</summary>
      <div class="field-row mt-12">
        <div class="field"><label for="ai-other-name">Item</label><input id="ai-other-name" maxlength="60" placeholder="e.g. Extra blanket" /></div>
        <div class="field"><label for="ai-other-price">Price (₹)</label><input id="ai-other-price" type="number" min="1" step="1" inputmode="numeric" /></div>
      </div>
      <button type="button" class="btn btn-outline btn-sm" onclick="cartAddOther()">+ Add</button>
    </details>
    <div id="ai-cart" class="mt-12"></div>
    <div class="field mt-12"><label>How will the guest pay?</label>
      <div class="choice-row">
        <label class="choice"><input type="radio" name="ai-when" value="monthly_bill" checked onchange="cartRender()" /> Add to bill <span class="td-small">(pay later / at checkout)</span></label>
        <label class="choice"><input type="radio" name="ai-when" value="immediate" onchange="cartRender()" /> Paid now</label>
      </div>
    </div>
    <div class="field" id="ai-mode-wrap" hidden><label for="ai-mode">Paid by</label>
      <select id="ai-mode" onchange="cartRender()"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></select></div>
    ${cashChangeBox('ai')}
    <div id="ai-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12">
      <button class="btn btn-primary" id="ai-submit" onclick="submitAddItems()" disabled>Add to bill</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>`);
  window._cart.change = bindCashChange('ai', () => document.querySelector('input[name="ai-when"]:checked')?.value === 'immediate' ? (window._cart.total || 0) / 100 : 0,
    () => document.getElementById('ai-mode').value);
  cartRender();
}

function cartAdd(i) {
  const c = window._cart.catalog[i];
  if (!c) return;
  const line = window._cart.lines.find(l => l.catalog_item_id === c.id);
  if (line) line.quantity = Math.min(99, line.quantity + 1);
  else window._cart.lines.push({ catalog_item_id: c.id, name: c.name, unit: c.default_price_paise, bp: c._bp, incl: c._incl, quantity: 1 });
  cartRender();
}

function cartAddOther() {
  const name = document.getElementById('ai-other-name').value.trim();
  const unit = Math.round((parseFloat(document.getElementById('ai-other-price').value) || 0) * 100);
  if (!name) { toast('Type the item name', 'warning'); return; }
  if (unit <= 0) { toast('Type a price more than ₹0', 'warning'); return; }
  window._cart.lines.push({ name, unit, bp: 0, incl: true, quantity: 1 });
  document.getElementById('ai-other-name').value = '';
  document.getElementById('ai-other-price').value = '';
  cartRender();
}

function cartQty(idx, delta) {
  const l = window._cart.lines[idx];
  if (!l) return;
  l.quantity += delta;
  if (l.quantity < 1) window._cart.lines.splice(idx, 1);
  else l.quantity = Math.min(99, l.quantity);
  cartRender();
}

function cartRender() {
  const box = document.getElementById('ai-cart');
  if (!box) return;
  const lines = window._cart.lines;
  lines.forEach(l => { l._g = gstSplit(l.unit * l.quantity, l.bp, l.incl); });
  const total = lines.reduce((a, l) => a + l._g.gross, 0);
  const gst = lines.reduce((a, l) => a + l._g.tax, 0);
  box.innerHTML = lines.length ? `
    <table class="cart"><tbody>${lines.map((l, i) => `
      <tr><td>${h(l.name)}<div class="td-small">${rupees(l.unit)} each${l.bp ? ` · ${l.incl ? 'incl.' : '+'} ${l.bp / 100}% GST` : ''}</div></td>
        <td class="qty"><button type="button" class="btn btn-outline btn-sm" onclick="cartQty(${i},-1)" aria-label="Less">−</button>
          <b>${l.quantity}</b>
          <button type="button" class="btn btn-outline btn-sm" onclick="cartQty(${i},1)" aria-label="More">+</button></td>
        <td class="num">${rupees(l._g.gross)}</td></tr>`).join('')}
    </tbody><tfoot>${gst ? `<tr><td colspan="2" class="td-small">GST included in total</td><td class="num td-small">${rupees(gst)}</td></tr>` : ''}
      <tr><td colspan="2"><b>Total</b></td><td class="num"><b>${rupees(total)}</b></td></tr></tfoot></table>`
    : '<div class="td-small text-muted">No items added yet.</div>';
  const paidNow = document.querySelector('input[name="ai-when"]:checked')?.value === 'immediate';
  document.getElementById('ai-mode-wrap').hidden = !paidNow;
  window._cart.total = total;
  if (window._cart.change) window._cart.change();
  const btn = document.getElementById('ai-submit');
  btn.disabled = !lines.length;
  btn.textContent = lines.length ? (paidNow ? `Save · ${rupees(total)} paid` : `Add ${rupees(total)} to bill`) : 'Add to bill';
}

async function submitAddItems() {
  const err = document.getElementById('ai-error'); err.classList.add('hidden');
  const residentId = document.getElementById('ai-guest').value;
  if (!residentId) { err.textContent = 'Choose the guest first'; err.classList.remove('hidden'); return; }
  const lines = window._cart.lines;
  if (!lines.length) return;
  const when = document.querySelector('input[name="ai-when"]:checked').value;
  const btn = document.getElementById('ai-submit'); btn.disabled = true;
  try {
    const r = await api('POST', `/residents/${residentId}/addons`, {
      items: lines.map(l => l.catalog_item_id
        ? { catalog_item_id: l.catalog_item_id, quantity: l.quantity }
        : { name: l.name, unit_price_paise: l.unit, quantity: l.quantity }),
      billing_mode: when,
      payment_mode: document.getElementById('ai-mode').value,
    });
    toast(when === 'immediate' ? `${rupees(r.total_paise)} saved as paid` : `${rupees(r.total_paise)} added to the bill`, 'success');
    closeModal();
    refreshCurrentPage();
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); btn.disabled = false; }
}

// ── Bookings ──────────────────────────────────────────────────
async function renderBookings(el) {
  const [bookings, beds] = await Promise.all([
    api('GET', '/bookings'),
    api('GET', '/beds?status=available'),
  ]);
  const bedOpts = beds.map(b => `<option value="${b.id}">${h(b.bed_label)} (${h(b.room_number||'')})</option>`).join('');

  el.innerHTML = `
    <div class="card mb-20">
      <strong>New Booking (Bed Lock)</strong>
      <div class="field-row mt-12">
        <div class="field"><label>Bed *</label><select id="bk-bed">${bedOpts||'<option value="">No available beds</option>'}</select></div>
        <div class="field"><label>Prospect Name *</label><input id="bk-name" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Prospect Phone *</label><input id="bk-phone" type="tel" /></div>
        <div class="field"><label>Advance Deposit (₹)</label><input id="bk-deposit" type="number" min="0" step="0.01" value="0" /></div>
      </div>
      <div id="bk-error" class="error-msg hidden"></div>
      <button class="btn btn-primary mt-12" onclick="submitBooking()">🔒 Lock Bed</button>
    </div>
    <div class="card">
      <strong>Active Bookings</strong>
      ${bookings.length ? `
        <div class="table-wrap mt-12">
          <table>
            <thead><tr><th>Prospect</th><th>Bed</th><th>Advance</th><th>Expires</th><th>Actions</th></tr></thead>
            <tbody>
              ${bookings.map(b => `
                <tr>
                  <td><div class="td-name">${h(b.prospect_name)}</div><div class="td-small">${h(b.prospect_phone)}</div></td>
                  <td>${h(b.bed_label||'')} ${h(b.room_number||'')}</td>
                  <td>${rupees(b.advance_deposit_paise)}</td>
                  <td>${fmtDate(b.lock_expires_at)}</td>
                  <td>
                    <button class="btn btn-success btn-sm" onclick="confirmBooking('${b.id}')">Confirm</button>
                    <button class="btn btn-danger btn-sm" onclick="cancelBooking('${b.id}')">Cancel</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<p class="text-muted mt-12">No active bookings</p>'}
    </div>
  `;
}

async function submitBooking() {
  const err = document.getElementById('bk-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/bookings', {
      bed_id:                document.getElementById('bk-bed').value,
      prospect_name:         document.getElementById('bk-name').value.trim(),
      prospect_phone:        document.getElementById('bk-phone').value.trim(),
      advance_deposit_paise: Math.round((parseFloat(document.getElementById('bk-deposit').value) || 0) * 100),
    });
    toast('Bed locked for 24 hours', 'success'); renderPage('bookings');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

async function confirmBooking(id) {
  try { await api('POST', `/bookings/${id}/confirm`); toast('Booking confirmed', 'success'); renderPage('bookings'); }
  catch(ex) { toast(ex.message, 'error'); }
}
async function cancelBooking(id) {
  try { await api('POST', `/bookings/${id}/cancel`); toast('Booking cancelled, bed released', 'warning'); renderPage('bookings'); }
  catch(ex) { toast(ex.message, 'error'); }
}

// ── Cash Reconciliation ───────────────────────────────────────
async function renderReconcile(el) {
  const date = todayIST();
  let pv = null;
  try { pv = await api('GET', `/reconciliation/cash/preview?date=${date}`); } catch (_) { pv = null; }
  const firstClose = pv && pv.opening_cash_paise == null;
  el.innerHTML = `
    <div class="card">
      <strong>Close Cash Drawer</strong>
      <p class="text-muted mt-12" style="font-size:13px">Count the cash in the drawer. The system expects:
        opening cash + cash received − cash paid out (expenses, refunds)${pv && pv.from_date && pv.from_date !== date ? ` since ${fmtDate(pv.from_date)}` : ''}.</p>
      ${pv ? `
        <div class="stat-grid mt-12" id="rc-preview">
          <div class="stat-card gray"><div class="stat-label">Opening</div><div class="stat-value" style="font-size:16px">${firstClose ? 'first close' : rupees(pv.opening_cash_paise)}</div></div>
          <div class="stat-card success"><div class="stat-label">Cash In</div><div class="stat-value" style="font-size:16px">${rupees(pv.cash_in_paise)}</div></div>
          <div class="stat-card danger"><div class="stat-label">Cash Out</div><div class="stat-value" style="font-size:16px">${rupees(pv.cash_out_paise)}</div></div>
          <div class="stat-card accent"><div class="stat-label">Expected</div><div class="stat-value" style="font-size:16px">${firstClose ? '—' : rupees(pv.expected_cash_paise)}</div></div>
        </div>
        ${pv.is_closed ? `<div class="error-msg mt-12">Cash is already closed up to ${fmtDate(pv.closed_through)}.</div>` : ''}
      ` : ''}
      <div class="field-row mt-12">
        <div class="field"><label>Date *</label><input id="rc-date" type="date" max="${date}" value="${date}" /></div>
        <div class="field"><label>Drawer Amount (₹) *</label><input id="rc-amount" type="number" min="0" step="0.01" placeholder="Physical cash count in ₹" /></div>
      </div>
      ${firstClose ? `<div class="field"><label>Opening Cash (₹) — first close only</label><input id="rc-opening" type="number" min="0" step="0.01" value="0" /><div class="td-small">Cash that was already in the drawer before you started using DormBook.</div></div>` : ''}
      <div id="rc-error" class="error-msg hidden"></div>
      <button class="btn btn-primary mt-12" onclick="submitReconcile()">Submit Cash Close</button>
    </div>
  `;
}

async function submitReconcile() {
  const err = document.getElementById('rc-error');
  err.classList.add('hidden');
  const amt = document.getElementById('rc-amount').value;
  if (amt === '') { err.textContent = 'Enter the cash you counted'; err.classList.remove('hidden'); return; }
  const openingEl = document.getElementById('rc-opening');
  if (!confirm('Close the cash drawer? After closing, entries cannot be added to this day.')) return;
  try {
    const res = await api('POST', '/reconciliation/cash', {
      date: document.getElementById('rc-date').value,
      drawer_amount_paise: Math.round((parseFloat(amt) || 0) * 100),
      ...(openingEl ? { opening_cash_paise: Math.round((parseFloat(openingEl.value) || 0) * 100) } : {}),
    });
    const msg = res.is_discrepancy
      ? `⚠️ Cash ${res.delta_paise < 0 ? 'short' : 'over'} by ${rupees(Math.abs(res.delta_paise))} (expected ${rupees(res.system_amount_paise)}). Owner notified.`
      : `Cash balanced ✅ (${rupees(res.drawer_amount_paise)})`;
    toast(msg, res.is_discrepancy ? 'warning' : 'success', 7000);
    renderPage('reconcile');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

// ── Expenses ─────────────────────────────────────────────────
async function renderExpenses(el) {
  const expenses = await api('GET', `/expenses?from=${todayIST().slice(0,7)}-01`);
  const total    = expenses.reduce((s, e) => s + e.amount_paise, 0);
  el.innerHTML = `
    <div class="card mb-20">
      <strong>Add Expense</strong>
      <div class="field-row mt-12">
        <div class="field"><label>Category *</label>
          <select id="ex-cat">
            <option value="utilities">Utilities</option><option value="maintenance">Maintenance</option>
            <option value="salary">Salary</option><option value="cleaning">Cleaning</option>
            <option value="grocery">Grocery</option><option value="other">Other</option>
          </select>
        </div>
        <div class="field"><label>Amount (₹) *</label><input id="ex-amount" type="number" min="0.01" step="0.01" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Date *</label><input id="ex-date" type="date" value="${todayIST()}" /></div>
        <div class="field"><label>Payment Mode</label>
          <select id="ex-mode"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></select>
        </div>
      </div>
      <div class="field"><label>Description</label><input id="ex-desc" /></div>
      <div id="ex-error" class="error-msg hidden"></div>
      <button class="btn btn-primary mt-12" onclick="submitExpense()">Add Expense</button>
    </div>
    <div class="card">
      <div class="flex-between mb-12">
        <strong>This Month's Expenses</strong>
        <span class="fw-bold text-danger">${rupees(total)} total</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th><th>Mode</th>${can('expenses')?'<th>Actions</th>':''}</tr></thead>
          <tbody>
            ${expenses.map(e => `
              <tr>
                <td>${fmtDate(e.expense_date)}</td><td>${h(e.category)}</td>
                <td>${h(e.description||'—')}</td><td class="text-danger">${rupees(e.amount_paise)}</td>
                <td>${e.payment_mode}</td>
                ${can('expenses')?`<td><button class="btn btn-danger btn-sm" onclick="deleteExpense('${e.id}')">Delete</button></td>`:''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function submitExpense() {
  const err = document.getElementById('ex-error');
  err.classList.add('hidden');
  try {
    await api('POST', '/expenses', {
      category:     document.getElementById('ex-cat').value,
      amount_paise: Math.round((parseFloat(document.getElementById('ex-amount').value) || 0) * 100),
      expense_date: document.getElementById('ex-date').value,
      payment_mode: document.getElementById('ex-mode').value,
      description:  document.getElementById('ex-desc').value.trim(),
    });
    toast('Expense recorded', 'success'); renderPage('expenses');
  } catch(ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense? This cannot be undone.')) return;
  try {
    await api('DELETE', `/expenses/${id}`);
    toast('Expense deleted', 'warning');
    renderPage('expenses');
  } catch(ex) { toast(ex.message, 'error'); }
}

// ── Reports ───────────────────────────────────────────────────
// Registers (and the GST tab, which is the GST register on its own).
async function renderReports(el, forced) {
  const page = forced || 'reports';
  const all = await api('GET', '/reports/registers');
  const list = forced ? all.filter(r => r.id === forced) : all.filter(r => r.id !== 'gst');
  if (!list.length) { el.innerHTML = '<div class="empty-state"><p>You don\'t have access to this report.</p></div>'; return; }
  STATE.reps = STATE.reps || {};
  const st = STATE.reps[page] || (STATE.reps[page] = { id: list[0].id, from: todayIST().slice(0, 8) + '01', to: todayIST() });
  if (!list.find(r => r.id === st.id)) st.id = list[0].id;
  const cur = list.find(r => r.id === st.id);
  el.innerHTML = `
    <div class="report-bar no-print">
      ${forced ? '' : `<div class="field"><label for="rp-type">Report</label>
        <select id="rp-type">${list.map(r => `<option value="${r.id}" ${r.id === st.id ? 'selected' : ''}>${h(r.title)}</option>`).join('')}</select></div>`}
      <div class="field" ${cur.as_of ? 'hidden' : ''}><label for="rp-from">From</label><input id="rp-from" type="date" value="${st.from}" max="${todayIST()}" /></div>
      <div class="field"><label for="rp-to">${cur.as_of ? 'As on' : 'To'}</label><input id="rp-to" type="date" value="${st.to}" max="${todayIST()}" /></div>
      <div class="btn-group">
        ${cur.as_of ? '' : `<button class="btn btn-outline btn-sm" onclick="setReportRange('${page}','today')">Today</button>`}
        <button class="btn btn-outline btn-sm" onclick="setReportRange('${page}','month')">This month</button>
        <button class="btn btn-outline btn-sm" onclick="setReportRange('${page}','last')">Last month</button>
      </div>
    </div>
    <div id="rp-doc"><div class="loading-spinner" style="margin:40px auto"></div></div>`;
  const reload = () => {
    if (!forced) st.id = document.getElementById('rp-type').value;
    st.from = document.getElementById('rp-from').value; st.to = document.getElementById('rp-to').value;
    renderPage(page);
  };
  [forced ? null : 'rp-type', 'rp-from', 'rp-to'].filter(Boolean).forEach(id => document.getElementById(id).addEventListener('change', reload));
  try {
    const rep = await api('GET', `/reports/registers/${st.id}?from=${st.from}&to=${st.to}`);
    window._report = rep;
    document.getElementById('rp-doc').innerHTML = reportDocument(rep);
  } catch (ex) { document.getElementById('rp-doc').innerHTML = `<div class="error-msg">${h(ex.message)}</div>`; }
}

function setReportRange(page, which) {
  const t = todayIST();
  const st = STATE.reps[page];
  if (which === 'today') { st.from = t; st.to = t; }
  else if (which === 'month') { st.from = t.slice(0, 8) + '01'; st.to = t; }
  else {
    const d = new Date(Date.parse(t.slice(0, 8) + '01') - 86400000).toISOString().slice(0, 10);
    st.from = d.slice(0, 8) + '01'; st.to = d;
  }
  renderPage(page);
}

/** The same letterhead block used by reports, the monthly summary and bills. */
function letterhead(c, title, sub, opts = {}) {
  // Bills lead with the dormitory name (what the guest knows); reports lead with the company.
  const dorm = opts.dormFirst && c.property_name;
  const main = dorm ? c.property_name : c.business_name;
  const second = dorm ? (c.business_name && c.business_name !== c.property_name ? `A unit of ${c.business_name}` : '')
    : (c.property_name && c.property_name !== c.business_name ? c.property_name : '');
  return `
      <header class="letterhead">
        <div>
          <div class="lh-name">${h(main)}</div>
          ${second ? `<div class="lh-sub">${h(second)}</div>` : ''}
          ${c.address ? `<div class="lh-addr">${h(c.address)}</div>` : '<div class="lh-addr no-print text-muted">Add your address in Business &amp; GST</div>'}
          <div class="lh-addr">${[c.phone && `Ph: ${h(c.phone)}`, c.email && h(c.email), c.gstin && `GSTIN: ${h(c.gstin)}`].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="lh-right">
          <div class="lh-title">${h(title)}</div>
          <div>${sub}</div>
        </div>
      </header>`;
}

// ── Monthly summary ───────────────────────────────────────────
function monthName(m) { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm - 1, 1)).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }); }
function shiftMonth(m, n) { const [y, mm] = m.split('-').map(Number); const t = y * 12 + (mm - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; }

async function renderMonthly(el) {
  const thisMonth = todayIST().slice(0, 7);
  const month = STATE.sumMonth && STATE.sumMonth <= thisMonth ? STATE.sumMonth : thisMonth;
  const d = await api('GET', `/reports/monthly?month=${month}`);
  const k = d.kpis;
  const tile = (label, value, sub, cls = '') => `<div class="kpi ${cls}"><span>${label}</span><strong>${value}</strong>${sub ? `<em>${sub}</em>` : ''}</div>`;
  const table = (title, rows, extra) => `
    <div class="card sum-card"><div class="sum-title">${title}</div>
      ${rows.length ? `<table class="report-table compact"><tbody>${rows.map(r => `<tr><td>${h(r.head)}</td>${extra ? `<td class="num td-small">${r.gst ? `GST ${rupees(r.gst)}` : ''}</td>` : ''}<td class="num">${rupees(r.amount)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td><b>Total</b></td>${extra ? '<td></td>' : ''}<td class="num"><b>${rupees(rows.reduce((a, r) => a + r.amount, 0))}</b></td></tr></tfoot></table>`
      : '<p class="td-small text-muted">Nothing this month.</p>'}
    </div>`;
  el.innerHTML = `
    <div class="report-bar no-print">
      <div class="btn-group month-pick">
        <button class="btn btn-outline btn-sm" onclick="STATE.sumMonth='${shiftMonth(month, -1)}';renderPage('summary')" aria-label="Previous month">‹</button>
        <strong class="month-label">${monthName(month)}</strong>
        <button class="btn btn-outline btn-sm" ${month >= thisMonth ? 'disabled' : ''} onclick="STATE.sumMonth='${shiftMonth(month, 1)}';renderPage('summary')" aria-label="Next month">›</button>
      </div>
      <button class="btn btn-primary btn-sm" onclick="window.print()">🖨 Print / Save PDF</button>
    </div>
    <article class="report-doc">
      ${letterhead(d.company, 'Monthly Summary', monthName(month))}
      <div class="kpis kpis-4 mb-20">
        ${tile('Money received', rupees(k.received), 'cash, UPI, card, bank')}
        ${tile('Expenses', rupees(k.expenses), '')}
        ${tile(k.profit >= 0 ? 'Profit' : 'Loss', rupees(Math.abs(k.profit)), 'received − expenses', k.profit >= 0 ? 'good' : 'bad')}
        ${tile('Occupancy', `${k.occupancy_pct}%`, `month average · ${k.beds} beds · ${k.check_ins} in, ${k.check_outs} out`)}
        ${tile('Billed', rupees(k.billed), k.gst_billed ? `incl. GST ${rupees(k.gst_billed)}` : 'rent + items')}
        ${tile('Dues pending', rupees(k.dues_outstanding), 'at month end', k.dues_outstanding ? 'bad' : '')}
        ${tile('Deposits', rupees(k.deposits_received), `refunded ${rupees(k.deposits_refunded)}`)}
        ${tile('Discounts', rupees(k.discount), '')}
        ${k.cash_in !== undefined ? tile('Received in cash', rupees(k.cash_in), 'rent, items and deposits') : ''}
        ${k.online_in !== undefined ? tile('Received online', rupees(k.online_in), 'UPI, card and bank') : ''}
      </div>
      <div class="card sum-card mb-20">
        <div class="sum-title">Last 6 months</div>
        ${trendChart(d.trend)}
      </div>
      <div class="sum-grid">
        ${table('Money received', d.income)}
        ${table('Expenses', d.expenses)}
        ${table('Billed to guests', d.billed, true)}
      </div>
      <p class="rep-note">${h(d.notes)}</p>
    </article>`;
}

/** Grouped bars: money received vs expenses per month. One y-axis, legend, hover titles, table fallback. */
function trendChart(trend) {
  const W = 640, H = 220, pad = { l: 56, r: 12, t: 12, b: 28 };
  const max = Math.max(1, ...trend.map(t => Math.max(t.income, t.expenses)));
  const step = (() => { const raw = max / 4; const p = Math.pow(10, Math.floor(Math.log10(raw))); return Math.ceil(raw / p) * p; })();
  const top = step * 4;
  const x0 = pad.l, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const gw = iw / trend.length, bw = Math.min(28, (gw - 14) / 2);
  const y = (v) => pad.t + ih - (v / top) * ih;
  const short = (p) => { const r = p / 100; return r >= 100000 ? `₹${(r / 100000).toFixed(r >= 1000000 ? 0 : 1)}L` : r >= 1000 ? `₹${Math.round(r / 1000)}k` : `₹${Math.round(r)}`; };
  const bar = (x, v, cls, label) => { const hgt = Math.max(0, pad.t + ih - y(v)); const r = Math.min(4, bw / 2, hgt);
    return `<path class="${cls}" d="M${x},${pad.t + ih} v${-(hgt - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${hgt - r} z"><title>${label}</title></path>`; };
  const grid = [0, 1, 2, 3, 4].map(i => `<line class="grid" x1="${x0}" x2="${W - pad.r}" y1="${y(step * i)}" y2="${y(step * i)}"/><text class="tick" x="${x0 - 8}" y="${y(step * i) + 4}" text-anchor="end">${short(step * i)}</text>`).join('');
  const bars = trend.map((t, i) => {
    const gx = x0 + i * gw + (gw - (2 * bw + 2)) / 2;
    const name = monthName(t.month);
    return `<g class="bar-grp">${bar(gx, t.income, 'b-in', `${name} — received ${rupees(t.income)}`)}${bar(gx + bw + 2, t.expenses, 'b-ex', `${name} — expenses ${rupees(t.expenses)}`)}
      <rect class="hit" x="${x0 + i * gw}" y="${pad.t}" width="${gw}" height="${ih}"><title>${name}\nReceived ${rupees(t.income)}\nExpenses ${rupees(t.expenses)}\n${t.profit >= 0 ? 'Profit' : 'Loss'} ${rupees(Math.abs(t.profit))}</title></rect>
      <text class="tick" x="${x0 + i * gw + gw / 2}" y="${H - 8}" text-anchor="middle">${name.split(' ')[0].slice(0, 3)}</text></g>`;
  }).join('');
  return `
    <div class="chart-legend"><span><i class="sw b-in"></i>Money received</span><span><i class="sw b-ex"></i>Expenses</span></div>
    <svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Money received and expenses, last 6 months">${grid}${bars}</svg>
    <details class="no-print mt-4"><summary class="td-small">Show as table</summary>
      <table class="report-table compact"><thead><tr><th>Month</th><th class="num">Received</th><th class="num">Expenses</th><th class="num">Profit</th></tr></thead>
      <tbody>${trend.map(t => `<tr><td>${monthName(t.month)}</td><td class="num">${rupees(t.income)}</td><td class="num">${rupees(t.expenses)}</td><td class="num">${rupees(t.profit)}</td></tr>`).join('')}</tbody></table>
    </details>`;
}

// ── Guest bill / tax invoice ─────────────────────────────────
async function showBill(residentId, opts = {}) {
  let b;
  try { b = await api('GET', `/residents/${residentId}/bill`); } catch (ex) { toast(ex.message, 'error'); return; }
  const hasGst = b.totals.gst > 0;
  const lines = b.lines.length ? b.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${h(l.description)}</td>
      ${hasGst ? `<td class="num">${l.rate ? l.rate + '%' : '—'}</td><td class="num">${rupees(l.taxable)}</td><td class="num">${rupees(l.gst)}</td>` : ''}
      <td class="num">${rupees(l.amount)}</td></tr>`).join('')
    : `<tr><td colspan="${hasGst ? 6 : 3}" class="empty-row">Nothing billed yet</td></tr>`;
  const g = b.guest;
  const owes = b.balance > 0, adv = b.balance < 0;
  openModal(`${b.title} · ${b.bill_no}`, `
    ${opts.justCheckedOut ? `<div class="done-banner no-print">✅ ${h(g.name)} is checked out. Print the bill or send it on WhatsApp. You can open it again any time from Guests → Left.</div>` : ''}
    ${(b.company.missing || []).length && can('settings') ? `<div class="warn-banner no-print">Your ${b.company.missing.join(', ')} ${b.company.missing.length > 1 ? 'are' : 'is'} missing on bills.
      <a href="#" onclick="event.preventDefault();closeModal();navigate('settings')">Add in Business &amp; GST</a></div>` : ''}
    <div class="btn-group no-print mb-12">
      <button class="btn btn-primary" onclick="printBill()">🖨 Print / Save PDF</button>
      <button class="btn btn-whatsapp" id="bill-wa" onclick="sendBillWhatsApp('${h(residentId)}')">🟢 Send on WhatsApp</button>
    </div>
    <article class="report-doc bill-doc" id="bill-doc">
      ${letterhead(b.company, b.title, `No. ${h(b.bill_no)} · ${fmtDate(b.date)}`, { dormFirst: true })}
      <div class="bill-to">
        <div><div class="td-small">Bill to</div><b>${h(g.name)}</b><div>${h(g.mobile)}</div>${g.address ? `<div class="td-small">${h(g.address)}</div>` : ''}</div>
        <div><div class="td-small">Stay</div><b>Bed ${h(g.bed)}</b><div>${fmtDate(g.check_in)} → ${fmtDate(g.check_out)}</div>
          <div class="td-small">${rupees(g.rate)} / ${g.rate_per} · ${h(g.status)}</div></div>
      </div>
      <div class="table-wrap"><table class="report-table">
        <thead><tr><th>#</th><th>Description</th>${hasGst ? '<th class="num">GST</th><th class="num">Taxable</th><th class="num">GST amt</th>' : ''}<th class="num">Amount</th></tr></thead>
        <tbody>${lines}</tbody>
        ${hasGst ? `<tfoot>
          <tr><td></td><td>Taxable value</td><td></td><td class="num">${rupees(b.totals.taxable)}</td><td></td><td></td></tr>
          <tr><td></td><td>CGST ${rupees(b.totals.cgst)} + SGST ${rupees(b.totals.sgst)}</td><td></td><td></td><td class="num">${rupees(b.totals.gst)}</td><td></td></tr>
        </tfoot>` : ''}
      </table></div>
      <div class="bill-sum">
        <div><span>Total billed</span><b>${rupees(b.totals.amount)}</b></div>
        ${b.discount ? `<div><span>Discount</span><b>− ${rupees(b.discount)}</b></div>` : ''}
        <div><span>Paid</span><b>− ${rupees(b.paid)}</b></div>
        ${b.deposit.adjusted ? `<div><span>Adjusted from deposit</span><b>− ${rupees(b.deposit.adjusted)}</b></div>` : ''}
        <div class="bill-bal ${owes ? 'owes' : ''}"><span>${owes ? 'Balance due' : adv ? 'Advance with us' : 'Balance'}</span><b>${rupees(Math.abs(b.balance))}</b></div>
        ${b.deposit.received ? `<div class="td-small"><span>Security deposit: received ${rupees(b.deposit.received)}${b.deposit.refunded ? `, refunded ${rupees(b.deposit.refunded)}` : ''} · held ${rupees(b.deposit.held)}</span></div>` : ''}
      </div>
      ${b.payments.length ? `<div class="section-title">Payments</div>
        <table class="report-table compact"><tbody>${b.payments.map(p => `<tr><td>${fmtDate(p.date)}</td><td>${h(p.what)}</td><td>${h(p.mode)}</td><td class="num">${rupees(p.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${payBlock(b.pay, b.balance, b.company)}
      <footer class="rep-foot">This is a computer-generated ${b.title.toLowerCase()} · DormBook</footer>
    </article>`, { wide: true });
}

function printBill() {
  document.body.classList.add('printing-bill');
  const done = () => { document.body.classList.remove('printing-bill'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 2000);
}

function fmtCell(v, type) {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'money') return rupees(v);
  if (type === 'date') return fmtDate(v);
  if (type === 'pct') return `${v}%`;
  if (type === 'number') return Number(v).toLocaleString('en-IN');
  return h(v);
}

/** Letterhead + table: the same layout for every report, on screen and on paper. */
function reportDocument(rep) {
  const c = rep.company;
  const period = rep.period.as_of ? `As on ${fmtDate(rep.period.as_of)}` : `${fmtDate(rep.period.from)} to ${fmtDate(rep.period.to)}`;
  const cols = rep.columns;
  const body = rep.rows.length ? rep.rows.map(r => `<tr class="${r.bold ? 'row-bold' : ''}">${cols.map(col =>
    `<td class="${['money', 'number', 'pct'].includes(col.type) ? 'num' : ''}">${fmtCell(r[col.key], col.type)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${cols.length}" class="empty-row">No records for this period</td></tr>`;
  const totals = rep.totals ? `<tfoot><tr>${cols.map((col, i) =>
    `<td class="${['money', 'number', 'pct'].includes(col.type) ? 'num' : ''}">${i === 0 ? '<b>Total</b>' : rep.totals[col.key] !== undefined ? `<b>${fmtCell(rep.totals[col.key], col.type)}</b>` : ''}</td>`).join('')}</tr></tfoot>` : '';
  return `
    <div class="report-actions no-print btn-group mb-12">
      <button class="btn btn-primary btn-sm" onclick="window.print()">🖨 Print / Save PDF</button>
      <button class="btn btn-outline btn-sm" onclick="downloadReportCsv()">⬇ Excel (CSV)</button>
    </div>
    <article class="report-doc">
      ${letterhead(c, rep.title, period)}
      ${rep.summary && rep.summary.length ? `<div class="rep-summary">${rep.summary.map(x => `<div><span>${h(x.label)}</span><b>${fmtCell(x.value, x.type)}</b></div>`).join('')}</div>` : ''}
      <div class="table-wrap"><table class="report-table">
        <thead><tr>${cols.map(col => `<th class="${['money', 'number', 'pct'].includes(col.type) ? 'num' : ''}">${h(col.label)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>${totals}
      </table></div>
      ${rep.notes ? `<p class="rep-note">${h(rep.notes)}</p>` : ''}
      <footer class="rep-foot">Generated on ${new Date(rep.generated_at).toLocaleString('en-IN')} by ${h(rep.generated_by || '')} · DormBook</footer>
    </article>`;
}

function downloadReportCsv() {
  const rep = window._report;
  if (!rep) return;
  // Text starting with = + - @ would run as a formula in Excel: put a ' in front (numbers are safe).
  const q = (v) => { let t = String(v ?? ''); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
  const plain = (v, t) => v === null || v === undefined ? '' : t === 'money' ? (v / 100).toFixed(2) : v;
  const c = rep.company;
  const lines = [
    [c.business_name], [c.address], [rep.title, rep.period.as_of ? `As on ${rep.period.as_of}` : `${rep.period.from} to ${rep.period.to}`], [],
    rep.columns.map(x => x.label + (x.type === 'money' ? ' (₹)' : '')),
    ...rep.rows.map(r => rep.columns.map(x => plain(r[x.key], x.type))),
  ];
  if (rep.totals) lines.push(rep.columns.map((x, i) => i === 0 ? 'Total' : plain(rep.totals[x.key], x.type)));
  const csv = '﻿' + lines.map(l => l.map(q).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${rep.title.replace(/[^a-z0-9]+/gi, '-')}-${rep.period.as_of || rep.period.from + '-to-' + rep.period.to}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}



// ── Daily Reports ─────────────────────────────────────────────
const DAILY_TABS = [
  { id: 'snapshot',  label: "Today",       roles: ['reception','manager','owner'] },
  { id: 'dues',      label: 'Dues',        roles: ['manager','owner'] },
  { id: 'cash',      label: 'Cash Book',   roles: ['reception','manager','owner'] },
  { id: 'beds',      label: 'Bed Map',     roles: ['reception','manager','owner'] },
  { id: 'movements', label: 'Check-ins / outs', roles: ['reception','manager','owner'] },
];

async function renderDaily(el) {
  const role = STATE.user.role;
  const tabs = DAILY_TABS.filter(t => t.roles.includes(role));
  if (!tabs.find(t => t.id === STATE.dailyTab)) STATE.dailyTab = tabs[0].id;
  const date = STATE.dailyDate || todayIST();
  document.getElementById('header-actions').innerHTML =
    `<input id="daily-date" type="date" max="${todayIST()}" value="${date}" style="padding:6px 10px;border:1px solid var(--gray-200);border-radius:var(--radius);font-size:13px" />`;
  document.getElementById('daily-date').addEventListener('change', e => { STATE.dailyDate = e.target.value; renderPage('daily'); });
  const tabBar = `<div class="btn-group mb-20">${tabs.map(t =>
    `<button class="btn btn-sm ${t.id === STATE.dailyTab ? 'btn-primary' : 'btn-outline'}" onclick="STATE.dailyTab='${t.id}';renderPage('daily')">${h(t.label)}</button>`).join('')}</div>`;
  const body = await ({ snapshot: dailySnapshot, dues: dailyDues, cash: dailyCash, beds: dailyBeds, movements: dailyMovements }[STATE.dailyTab])(date);
  el.innerHTML = tabBar + body;
}

function dailyTable(head, rows, empty) {
  if (!rows.length) return `<p class="text-muted mt-12">${empty}</p>`;
  return `<div class="table-wrap mt-12"><table><thead><tr>${head.map(x => `<th>${x}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

async function dailySnapshot(date) {
  const d = await api('GET', `/reports/daily/snapshot?date=${date}`);
  const b = d.beds;
  return `
    <div class="stat-grid mb-20">
      <div class="stat-card accent"><div class="stat-label">Occupancy</div><div class="stat-value">${b.occupancy_pct}%</div><div class="stat-sub">${b.occupied} of ${b.total} beds</div></div>
      <div class="stat-card success"><div class="stat-label">Vacant</div><div class="stat-value">${b.available}</div><div class="stat-sub">${b.reserved} reserved · ${b.cleaning} cleaning</div></div>
      <div class="stat-card"><div class="stat-label">Check-ins</div><div class="stat-value">${d.today.check_ins}</div></div>
      <div class="stat-card"><div class="stat-label">Check-outs</div><div class="stat-value">${d.today.check_outs}</div><div class="stat-sub">${d.today.due_to_leave} due to leave</div></div>
      ${d.collected ? `<div class="stat-card success"><div class="stat-label">Collected</div><div class="stat-value" style="font-size:18px">${rupees(d.collected.total_paise)}</div>
        <div class="stat-sub">${d.collected.by_mode.map(m => `${h(m.mode)}: ${rupees(m.payments_paise + m.deposits_paise)}`).join(' · ') || '—'}</div></div>` : ''}
      ${d.outstanding ? `<div class="stat-card ${d.outstanding.total_dues_paise > 0 ? 'danger' : 'gray'}"><div class="stat-label">Dues Outstanding</div><div class="stat-value" style="font-size:18px">${rupees(d.outstanding.total_dues_paise)}</div><div class="stat-sub">${d.outstanding.residents_with_dues} residents</div></div>
      <div class="stat-card gray"><div class="stat-label">Deposits Held</div><div class="stat-value" style="font-size:18px">${rupees(d.outstanding.deposits_held_paise)}</div><div class="stat-sub">Advance credit ${rupees(d.outstanding.advance_credit_paise)}</div></div>` : ''}
      <div class="stat-card ${d.cash_drawer.is_closed ? 'success' : 'warning'}"><div class="stat-label">Cash Drawer</div>
        <div class="stat-value" style="font-size:16px">${d.cash_drawer.is_closed ? 'Closed ✅' : 'Open'}</div>
        <div class="stat-sub">${d.cash_drawer.is_closed ? `through ${fmtDate(d.cash_drawer.closed_through)}` : `expected ${rupees(d.cash_drawer.expected_cash_paise)}`}</div></div>
    </div>`;
}

async function dailyDues(date) {
  const d = await api('GET', `/reports/daily/dues?date=${date}`);
  const t = d.totals;
  const riskBadge = r => r === 'LEFT_WITH_DUES' ? '<span class="badge badge-danger">left with dues</span>'
    : r === 'DUES_EXCEED_DEPOSIT' ? '<span class="badge badge-warning">dues > deposit</span>' : '';
  return `
    <div class="stat-grid mb-20">
      <div class="stat-card danger"><div class="stat-label">Total Dues</div><div class="stat-value" style="font-size:18px">${rupees(t.dues_paise)}</div><div class="stat-sub">${d.count} residents</div></div>
      <div class="stat-card"><div class="stat-label">0–7 days</div><div class="stat-value" style="font-size:16px">${rupees(t.d0_7)}</div></div>
      <div class="stat-card warning"><div class="stat-label">8–30 days</div><div class="stat-value" style="font-size:16px">${rupees(t.d8_30)}</div></div>
      <div class="stat-card danger"><div class="stat-label">31–60 days</div><div class="stat-value" style="font-size:16px">${rupees(t.d31_60)}</div></div>
      <div class="stat-card danger"><div class="stat-label">60+ days</div><div class="stat-value" style="font-size:16px">${rupees(t.d60_plus)}</div></div>
    </div>
    <div class="card">${dailyTable(['Resident','Bed','Dues','Overdue','Last paid','Deposit',''], d.rows.map(r => `
      <tr><td><div class="td-name">${h(r.resident)}</div><div class="td-small">${h(r.mobile)} ${riskBadge(r.risk)}</div></td>
        <td>${h(r.bed || '—')}</td><td class="text-danger fw-bold">${rupees(r.dues_paise)}</td>
        <td>${r.days_overdue} days<div class="td-small">since ${fmtDate(r.oldest_unpaid_date)}</div></td>
        <td>${fmtDate(r.last_payment_date)}</td><td>${rupees(r.deposit_held_paise)}</td>
        <td><button class="btn btn-outline btn-sm" onclick="showStatement('${h(r.resident_id)}')">Statement</button>
            <button class="btn btn-primary btn-sm" onclick="showPaymentModal('${h(r.resident_id)}','${esc(r.resident)}')">Collect</button></td></tr>`),
      'No dues — everyone is paid up 🎉')}</div>`;
}

async function dailyCash(date) {
  const d = await api('GET', `/reports/daily/cash-book?date=${date}`);
  const label = { PAYMENT: 'Payment', DEPOSIT_IN: 'Deposit in', DEPOSIT_REFUND: 'Deposit refund', EXPENSE: 'Expense', BANK_DEPOSIT: 'To bank' };
  const isIn = k => k === 'PAYMENT' || k === 'DEPOSIT_IN';
  const modes = Object.entries(d.by_mode);
  return `
    <div class="stat-grid mb-20">
      ${modes.map(([m, v]) => `<div class="stat-card"><div class="stat-label">${h(m)}</div><div class="stat-value" style="font-size:16px">${rupees(v.in_paise - v.out_paise)}</div><div class="stat-sub">in ${rupees(v.in_paise)} · out ${rupees(v.out_paise)}</div></div>`).join('')}
      <div class="stat-card ${d.close ? (d.close.variance_paise ? 'warning' : 'success') : 'gray'}"><div class="stat-label">Drawer</div>
        <div class="stat-value" style="font-size:16px">${d.close ? rupees(d.close.counted_cash_paise) : (d.drawer.is_closed ? 'closed' : 'open')}</div>
        <div class="stat-sub">${d.close ? `expected ${rupees(d.close.expected_cash_paise)} · ${d.close.variance_paise ? `variance ${rupees(d.close.variance_paise)}` : 'balanced'}` : `expected so far ${rupees(d.drawer.expected_cash_paise)}`}</div></div>
    </div>
    <div class="card">${dailyTable(['Time','Type','Resident / Note','Mode','Amount','By'], d.entries.map(e => `
      <tr style="${e.is_reversed || e.reversal_of ? 'opacity:.55' : ''}">
        <td>${new Date(e.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</td>
        <td>${label[e.kind] || e.kind}${e.reversal_of ? ' (reversal)' : ''}${e.is_reversed ? ' (reversed)' : ''}</td>
        <td>${h(e.resident || e.category || '')}<div class="td-small">${h(e.reason || '')}</div></td>
        <td>${h(e.mode || '')}</td>
        <td class="${isIn(e.kind) === (e.amount_paise > 0) ? 'ledger-credit' : 'ledger-debit'}">${isIn(e.kind) ? '+' : '−'}${rupees(Math.abs(e.amount_paise))}</td>
        <td>${h(e.recorded_by || '')}</td></tr>`), 'No money moved on this day.')}
      ${d.by_staff.length ? `<div class="mt-12 td-small">Collected by: ${d.by_staff.map(x => `${h(x.staff)} (${h(x.mode)}) ${rupees(x.collected_paise)}`).join(' · ')}</div>` : ''}
    </div>`;
}

async function dailyBeds() {
  const d = await api('GET', '/reports/daily/bed-map');
  const color = { occupied: 'accent', available: 'success', reserved: 'info', cleaning: 'warning', pending: 'gray' };
  return d.floors.map(f => `
    <div class="card mb-20"><strong>${h(f.floor)}</strong>
      ${f.rooms.map(r => `<div class="mt-12"><div class="td-small">Room ${h(r.room)}</div><div class="stat-grid">
        ${r.beds.map(b => `<div class="stat-card ${color[b.status] || 'gray'}">
          <div class="stat-label">${h(b.bed)} · ${h(b.status)}${b.overstay ? ' · <span class="text-danger">overstay</span>' : ''}</div>
          <div class="stat-value" style="font-size:14px">${b.resident ? h(b.resident) : '—'}</div>
          <div class="stat-sub">${b.resident ? `since ${fmtDate(b.since)} · out ${fmtDate(b.leaving_on)}${b.dues_paise > 0 ? ` · <span class="text-danger">due ${rupees(b.dues_paise)}</span>` : ''}` : (b.vacant_since ? `vacant since ${fmtDate(b.vacant_since)}` : '')}</div>
        </div>`).join('')}</div></div>`).join('')}
    </div>`).join('') || '<div class="empty-state"><p>No beds set up yet</p></div>';
}

async function dailyMovements(date) {
  const d = await api('GET', `/reports/daily/movements?date=${date}&days=7`);
  const money = r => r.deposit_paise === undefined ? '' :
    `<td>${rupees(r.dues_paise)}</td><td>${r.refund_due_paise >= 0 ? rupees(r.refund_due_paise) : `<span class="text-danger">collect ${rupees(-r.refund_due_paise)}</span>`}</td>`;
  const moneyHead = d.check_ins.concat(d.check_outs, d.due_to_leave).some(r => r.deposit_paise !== undefined) ? ['Dues', 'Refund due'] : [];
  const row = (r, dateField) => `<tr><td><div class="td-name">${h(r.resident)}</div><div class="td-small">${h(r.mobile)}</div></td>
    <td>${h([r.room, r.bed].filter(Boolean).join(' / ') || '—')}</td><td>${fmtDate(r[dateField])}</td>${money(r)}</tr>`;
  return `
    <div class="card mb-20"><strong>Due to leave (next 7 days)</strong>${dailyTable(['Resident','Bed','Leaving', ...moneyHead], d.due_to_leave.map(r => row(r, 'expected_checkout')), 'Nobody is due to leave.')}</div>
    <div class="card mb-20"><strong class="text-danger">Overstaying</strong>${dailyTable(['Resident','Bed','Was due', ...moneyHead], d.overstaying.map(r => row(r, 'expected_checkout')), 'No overstays.')}</div>
    <div class="card mb-20"><strong>Check-ins</strong>${dailyTable(['Resident','Bed','Date', ...moneyHead], d.check_ins.map(r => row(r, 'check_in_date')), 'No check-ins.')}</div>
    <div class="card mb-20"><strong>Check-outs</strong>${dailyTable(['Resident','Bed','Date', ...moneyHead], d.check_outs.map(r => row(r, 'actual_checkout')), 'No check-outs.')}</div>
    <div class="card"><strong>Bookings (beds on hold)</strong>${dailyTable(['Prospect','Bed','Advance','Hold expires'], d.arriving_bookings.map(b =>
      `<tr><td>${h(b.prospect_name)}<div class="td-small">${h(b.prospect_phone)}</div></td><td>${h(b.bed || '—')}</td><td>${rupees(b.advance_deposit_paise)}</td><td>${fmtDate(b.lock_expires_at)}</td></tr>`), 'No active bookings.')}</div>`;
}

async function showStatement(residentId) {
  const d = await api('GET', `/residents/${residentId}/statement`);
  const label = { CHARGE: 'Charge', PAYMENT: 'Payment', WAIVER: 'Discount', DEPOSIT_IN: 'Deposit received',
    DEPOSIT_APPLY: 'Deposit adjusted', DEPOSIT_REFUND: 'Deposit refunded', OPENING_DUES: 'Opening dues', OPENING_DEPOSIT: 'Opening deposit' };
  const canDiscount = ['manager','owner'].includes(STATE.user.role);
  openModal(`Statement: ${d.resident.full_name}`, `
    <div class="stat-grid mb-12">
      <div class="stat-card ${d.balance.dues_paise > 0 ? 'danger' : 'success'}"><div class="stat-label">${d.balance.dues_paise >= 0 ? 'Owes' : 'Advance credit'}</div><div class="stat-value" style="font-size:18px">${rupees(Math.abs(d.balance.dues_paise))}</div></div>
      <div class="stat-card gray"><div class="stat-label">Deposit held</div><div class="stat-value" style="font-size:18px">${rupees(d.balance.deposit_paise)}</div></div>
    </div>
    ${dailyTable(['Date','Entry','Amount','Balance'], d.entries.slice().reverse().map(e => `
      <tr style="${e.reversal_of ? 'opacity:.6' : ''}"><td>${fmtDate(e.biz_date)}</td>
        <td>${label[e.kind] || e.kind}${e.category && e.category !== 'rent' ? ` · ${h(e.category)}` : ''}${e.reversal_of ? ' (reversal)' : ''}
          <div class="td-small">${h(e.reason || '')}${e.mode ? ` · ${h(e.mode)}` : ''}</div></td>
        <td>${rupees(e.amount_paise)}</td><td>${rupees(e.dues_after_paise)}</td></tr>`), 'No entries yet.')}
    ${canDiscount && d.balance.dues_paise > 0 ? `<div class="btn-group mt-12"><button class="btn btn-outline btn-sm" onclick="showDiscountModal('${h(residentId)}', ${d.balance.dues_paise})">Give Discount</button></div>` : ''}
  `, { wide: true });
}

function showDiscountModal(residentId, duesPaise) {
  openModal('Give Discount', `
    <div class="field"><label>Amount (₹) — max ${rupees(duesPaise)}</label><input id="dc-amount" type="number" min="0.01" step="0.01" /></div>
    <div class="field"><label>Reason *</label><input id="dc-reason" placeholder="e.g. AC not working for 5 days" /></div>
    <div id="dc-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-primary" onclick="submitDiscount('${h(residentId)}')">Save Discount</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}

async function submitDiscount(residentId) {
  const err = document.getElementById('dc-error');
  err.classList.add('hidden');
  try {
    await api('POST', `/residents/${residentId}/discount`, {
      amount_paise: Math.round((parseFloat(document.getElementById('dc-amount').value) || 0) * 100),
      reason: document.getElementById('dc-reason').value.trim(),
    });
    toast('Discount saved', 'success');
    closeModal(); showStatement(residentId);
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

// ── Property Settings (owner only) ────────────────────────────
// ── Settings → Business (details, GST, advanced rules) ─────────
async function renderSettings(el) {
  const st = await api('GET', '/properties/settings');
  const rs = (p) => ((p || 0) / 100);
  const rateOpts = (sel) => GST_RATES.map(r => `<option value="${r * 100}" ${r * 100 === sel ? 'selected' : ''}>${r}%</option>`).join('');
  el.innerHTML = `
    <div class="card mb-20">
      <strong>Your business</strong>
      <p class="td-small mt-4">Printed at the top of reports and bills.</p>
      <div class="field-row mt-12">
        <div class="field"><label for="ps-company">Company name *</label><input id="ps-company" maxlength="120" value="${h(st.business_name || '')}" placeholder="e.g. A&P Infotech Solutions Pvt Ltd" /></div>
        <div class="field"><label for="ps-name">Dormitory name *</label><input id="ps-name" maxlength="120" value="${h(st.name || '')}" /></div>
      </div>
      <div class="field"><label for="ps-address">Address</label><input id="ps-address" maxlength="250" value="${h(st.address || '')}" placeholder="Building, street, area" /></div>
      <div class="field-row three">
        <div class="field"><label for="ps-city">City</label><input id="ps-city" maxlength="60" value="${h(st.city || '')}" /></div>
        <div class="field"><label for="ps-state">State</label><input id="ps-state" maxlength="60" value="${h(st.state || '')}" /></div>
        <div class="field"><label for="ps-pin">PIN code</label><input id="ps-pin" value="${h(st.pincode || '')}" inputmode="numeric" maxlength="6" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="ps-phone">Phone</label><input id="ps-phone" value="${h(st.contact_phone || '')}" type="tel" maxlength="20" /></div>
        <div class="field"><label for="ps-email">Email</label><input id="ps-email" value="${h(st.contact_email || '')}" type="email" maxlength="120" /></div>
      </div>
    </div>

    <div class="card mb-20">
      <label class="switch-row"><input type="checkbox" id="ps-gst-on" ${st.gst_enabled ? 'checked' : ''} onchange="document.getElementById('ps-gst-box').hidden=!this.checked" />
        <span><strong>We charge GST</strong><br/><span class="td-small">Turn on after you get your GSTIN. Bills then show GST and the GST report fills up.</span></span></label>
      <div id="ps-gst-box" ${st.gst_enabled ? '' : 'hidden'}>
        <div class="field-row mt-12">
          <div class="field"><label for="ps-gstin">GSTIN *</label><input id="ps-gstin" value="${h(st.gstin || '')}" maxlength="15" style="text-transform:uppercase" placeholder="07ABCDE1234F1Z5" /></div>
          <div class="field"><label for="ps-rent-gst">GST on bed rent</label><select id="ps-rent-gst">${rateOpts(st.rent_gst_rate_bp || 0)}</select></div>
        </div>
        <div class="field"><label>Your bed rates…</label>
          <div class="choice-row">
            <label class="choice"><input type="radio" name="ps-rent-incl" value="1" ${st.rent_gst_inclusive !== 0 ? 'checked' : ''} /> already include GST</label>
            <label class="choice"><input type="radio" name="ps-rent-incl" value="0" ${st.rent_gst_inclusive === 0 ? 'checked' : ''} /> GST is added on top</label>
          </div>
          <div class="field-note">Applies to guests who check in from now on. GST for tea, laundry etc. is set per item in Items &amp; Prices.
            Room rent up to ₹7,500/day is usually 5%; long-stay hostel rent up to ₹20,000/month can be exempt (0%). Confirm with your CA.</div>
        </div>
      </div>
    </div>

    <details class="card mb-20 adv">
      <summary><strong>More settings</strong> <span class="td-small">— you can leave these as they are</span></summary>
      <div class="rule mt-12">
        <label for="ps-clean">After a guest leaves, the bed is ready again in</label>
        <div class="rule-in"><input id="ps-clean" type="number" min="5" max="1440" value="${st.cleaning_timeout_minutes || 120}" /><span>minutes</span></div>
        <div class="field-note">Time for cleaning. You can also press "Ready" on the Today page sooner.</div>
      </div>
      <div class="rule">
        <label for="ps-lock">Keep a booked bed for the guest for</label>
        <div class="rule-in"><input id="ps-lock" type="number" min="1" max="720" value="${st.booking_lock_hours || 24}" /><span>hours</span></div>
        <div class="field-note">If the guest doesn't come by then, the bed becomes free again.</div>
      </div>
      <div class="rule">
        <label for="ps-refund">Staff can give money back up to</label>
        <div class="rule-in"><span>₹</span><input id="ps-refund" type="number" min="0" step="1" value="${rs(st.refund_approval_threshold_paise)}" /></div>
        <div class="field-note">More than this needs your OK. Keep 0 if you want to OK every refund.</div>
      </div>
      <div class="rule">
        <label for="ps-cash">When counting cash at night, a difference up to this is fine</label>
        <div class="rule-in"><span>₹</span><input id="ps-cash" type="number" min="0" step="1" value="${rs(st.cash_reconciliation_tolerance_paise)}" /></div>
        <div class="field-note">If cash is short or extra by more than this, staff must write why.</div>
      </div>
    </details>
    <div id="ps-error" class="error-msg hidden"></div>
    <button class="btn btn-primary" id="ps-save" onclick="submitSettings()">Save settings</button>`;
}

async function submitSettings() {
  const err = document.getElementById('ps-error'); err.classList.add('hidden');
  const v = (id) => document.getElementById(id).value.trim();
  const int = (id) => { const n = Number(v(id)); return Number.isFinite(n) ? Math.round(n) : NaN; };
  const btn = document.getElementById('ps-save'); btn.disabled = true;
  try {
    if (!v('ps-company')) throw new Error('Company name cannot be empty');
    if (!v('ps-name')) throw new Error('Dormitory name cannot be empty');
    const gstOn = document.getElementById('ps-gst-on').checked;
    if (gstOn && !v('ps-gstin')) throw new Error('Type your GSTIN to charge GST');
    for (const [id, label] of [['ps-clean', 'Cleaning time'], ['ps-lock', 'Booking hold'], ['ps-refund', 'Refund limit'], ['ps-cash', 'Cash difference']]) {
      if (v(id) === '' || Number.isNaN(int(id)) || int(id) < 0) throw new Error(`${label} (in More settings): type a number (0 or more)`);
    }
    await api('PATCH', '/properties/settings', {
      business_name: v('ps-company'), name: v('ps-name'),
      address: v('ps-address'), city: v('ps-city'), state: v('ps-state'), pincode: v('ps-pin'),
      contact_phone: v('ps-phone'), contact_email: v('ps-email'), gstin: v('ps-gstin'),
      gst_enabled: gstOn,
      rent_gst_rate_bp: Number(v('ps-rent-gst')),
      rent_gst_inclusive: document.querySelector('input[name="ps-rent-incl"]:checked')?.value !== '0',
      cleaning_timeout_minutes: int('ps-clean'),
      booking_lock_hours: int('ps-lock'),
      refund_approval_threshold_paise: int('ps-refund') * 100,
      cash_reconciliation_tolerance_paise: int('ps-cash') * 100,
    });
    await getProfile(true).catch(() => {});
    toast('Settings saved', 'success');
    renderPage('settings');
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); btn.disabled = false; }
}

// ── Staff ─────────────────────────────────────────────────────
async function renderStaff(el) {
  const data = await api('GET', '/staff');
  window._perm = data;
  document.getElementById('header-actions').innerHTML = `<button class="btn btn-primary btn-sm" onclick="showUserModal()">+ Add user</button>`;
  const P = data.all_permissions;
  el.innerHTML = `
    <div class="card table-wrap">
      <table>
        <thead><tr><th>User</th><th>Role</th><th>Can do</th><th>Sign-in</th><th></th></tr></thead>
        <tbody>
          ${data.staff.map(u => `
            <tr>
              <td><div class="td-name">${h(u.name)}</div><div class="td-small">${h(u.mobile)} ${h(u.email || '')}</div></td>
              <td><span class="role-chip role-${u.role}">${u.role === 'reception' ? 'Reception' : u.role === 'manager' ? 'Manager' : 'Owner'}</span>
                ${u.custom_permissions ? '<div class="td-small">custom access</div>' : ''}</td>
              <td class="perm-list">${u.role === 'owner' ? '<span class="td-small">Everything</span>' : u.permissions.map(p => `<span class="perm">${h(P[p] || p)}</span>`).join('')}</td>
              <td>${!u.is_active ? '<span class="badge badge-gray">Blocked</span>'
                : u.locked ? '<span class="badge badge-danger">Locked (wrong tries)</span>'
                : u.role === 'owner' ? '<span class="td-small">Password</span>'
                : u.has_mpin ? '<span class="badge badge-success">MPIN set</span>'
                : '<span class="badge badge-warning">Waiting for first sign-in</span>'}</td>
              <td class="actions">${u.role !== 'owner' && u.id !== STATE.user.id ? `
                ${u.is_active ? `<button class="btn btn-primary btn-sm" onclick="newLoginCode('${u.id}')">🔑 Login code</button>` : ''}
                ${u.locked ? `<button class="btn btn-outline btn-sm" onclick="unlockStaff('${u.id}')">Unlock</button>` : ''}
                <button class="btn btn-outline btn-sm" onclick="showUserModal('${u.id}')">Edit</button>
                <button class="btn btn-outline btn-sm" onclick="toggleStaff('${u.id}', ${u.is_active})">${u.is_active ? 'Block' : 'Unblock'}</button>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="td-small mt-12">Staff sign in with their mobile number and their own MPIN. First time, or forgot MPIN? Press <b>🔑 Login code</b> and give them the code.
      Blocked users cannot sign in. Their past entries stay in the records.</p>`;
}

async function toggleStaff(id, isActive) {
  try {
    if (isActive) { await api('DELETE', `/staff/${id}`); toast('User blocked', 'warning'); }
    else { await api('PATCH', `/staff/${id}`, { is_active: true }); toast('User unblocked', 'success'); }
    renderPage('staff');
  } catch (ex) { toast(ex.message, 'error'); }
}

function showUserModal(userId) {
  const data = window._perm;
  const u = userId ? data.staff.find(x => x.id === userId) : null;
  const P = data.all_permissions;
  const role = u ? u.role : 'reception';
  const checked = new Set(u ? u.permissions : data.role_defaults[role]);
  const mine = STATE.user.permissions || Object.keys(P);
  openModal(u ? `Edit ${u.name}` : 'Add user', `
    ${u ? '' : `
    <div class="field-row">
      <div class="field"><label for="sf-name">Name *</label><input id="sf-name" maxlength="120" autocomplete="off" /></div>
      <div class="field"><label for="sf-mobile">Mobile * (used to sign in)</label><input id="sf-mobile" type="tel" inputmode="numeric" maxlength="14" placeholder="10-digit mobile" /></div>
    </div>
    <div class="field"><label for="sf-email">Email (optional)</label><input id="sf-email" type="email" maxlength="120" /></div>
    <div class="field-note mb-12">No password needed. After you add them you get a 6-digit login code. They enter it once and set their own MPIN.</div>`}
    <div class="field"><label for="sf-role">Role</label>
      <select id="sf-role"><option value="reception" ${role === 'reception' ? 'selected' : ''}>Reception</option><option value="manager" ${role === 'manager' ? 'selected' : ''}>Manager</option></select>
      <div class="field-note">Choosing a role ticks its usual permissions. You can change any tick below.</div></div>
    <div class="section-title">This user can</div>
    <div class="perm-grid">
      ${Object.entries(P).map(([k, label]) => `
        <label class="perm-check ${mine.includes(k) ? '' : 'disabled'}"><input type="checkbox" value="${k}" ${checked.has(k) ? 'checked' : ''} ${mine.includes(k) ? '' : 'disabled'} /> ${h(label)}</label>`).join('')}
    </div>
    ${u ? `<div class="field-note mt-12">Forgot MPIN? Close this and press <b>🔑 Login code</b> for ${h(u.name)}.</div>` : ''}
    <div id="sf-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12">
      <button class="btn btn-primary" onclick="saveUser(${u ? `'${u.id}'` : 'null'})">${u ? 'Save' : 'Add user'}</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
    </div>`, { wide: true });
  document.getElementById('sf-role').addEventListener('change', (e) => {
    const def = new Set(data.role_defaults[e.target.value]);
    document.querySelectorAll('.perm-grid input').forEach(cb => { if (!cb.disabled) cb.checked = def.has(cb.value); });
  });
}

async function saveUser(userId) {
  const err = document.getElementById('sf-error');
  err.classList.add('hidden');
  const permissions = [...document.querySelectorAll('.perm-grid input:checked')].map(cb => cb.value);
  const role = document.getElementById('sf-role').value;
  try {
    if (userId) {
      await api('PATCH', `/staff/${userId}`, { role, permissions });
      toast('Saved', 'success');
      closeModal(); renderPage('staff');
    } else {
      const name = document.getElementById('sf-name').value.trim();
      const mobile = document.getElementById('sf-mobile').value.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
      if (!name) throw new Error('Type the name');
      if (!/^\d{10}$/.test(mobile)) throw new Error('Type a 10-digit mobile number');
      const u = await api('POST', '/staff', {
        name, mobile, email: document.getElementById('sf-email').value.trim() || undefined, role, permissions,
      });
      renderPage('staff');
      showLoginCode({ ...u.login_code, name: u.name, mobile: u.mobile }, true);
    }
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

// ── Feedback ──────────────────────────────────────────────────
async function renderFeedback(el) {
  const data = await api('GET', '/feedback');
  el.innerHTML = `
    <div class="stat-grid mb-20">
      <div class="stat-card success"><div class="stat-label">Good</div><div class="stat-value">${data.summary?.good||0}</div></div>
      <div class="stat-card warning"><div class="stat-label">Average</div><div class="stat-value">${data.summary?.average||0}</div></div>
      <div class="stat-card danger"><div class="stat-label">Needs Help</div><div class="stat-value">${data.summary?.needs_help||0}</div></div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Resident</th><th>Rating</th><th>Flagged</th><th>Date</th><th>Actions</th></tr></thead>
        <tbody>
          ${(data.feedback||[]).map(f => `
            <tr>
              <td><div class="td-name">${h(f.resident_name)}</div></td>
              <td><span class="badge ${f.rating==='good'?'badge-success':f.rating==='average'?'badge-warning':'badge-danger'}">${f.rating}</span></td>
              <td>${f.is_flagged?'⚠️ Flagged':'—'}</td>
              <td>${fmtDate(f.created_at)}</td>
              <td>${f.is_flagged&&!f.resolved_at?`<button class="btn btn-outline btn-sm" onclick="resolveFeedback('${f.id}')">Resolve</button>`:'—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function resolveFeedback(id) {
  try { await api('PATCH', `/feedback/${id}/resolve`, { notes: 'Resolved via dashboard' }); toast('Feedback resolved', 'success'); renderPage('feedback'); }
  catch(ex) { toast(ex.message, 'error'); }
}

// ── Add-on Catalog ────────────────────────────────────────────
// ── Settings → Items & Prices (tea, coffee, laundry… for guests' bills) ──
const ITEM_CATEGORIES = ['Food & drinks', 'Laundry', 'Services', 'Items', 'Other'];

async function renderCatalog(el) {
  const [items, prof] = await Promise.all([api('GET', '/addons/catalog?all=1'), getProfile(true).catch(() => ({}))]);
  const gstOn = !!prof.gst_enabled;
  const active = items.filter(i => i.is_active), hidden = items.filter(i => !i.is_active);
  const catOpts = (sel) => ITEM_CATEGORIES.map(c => `<option ${c === sel ? 'selected' : ''}>${h(c)}</option>`).join('');
  const rateOpts = (sel) => GST_RATES.map(r => `<option value="${r * 100}" ${r * 100 === (sel || 0) ? 'selected' : ''}>${r}%</option>`).join('');
  const inclOpts = (incl) => `<option value="1" ${incl ? 'selected' : ''}>Price includes GST</option><option value="0" ${incl ? '' : 'selected'}>Add GST on top</option>`;
  el.innerHTML = `
    <div class="card mb-20">
      <strong>Items guests can buy</strong>
      <p class="td-small mt-4">These show as quick buttons when you press <b>☕ Add item</b> on Today, Guests or a bed.
        The amount goes on the guest's bill and is collected with rent or at checkout.</p>
      <div class="field-row three mt-12">
        <div class="field"><label for="cat-name">Item name *</label><input id="cat-name" maxlength="60" placeholder="e.g. Tea" /></div>
        <div class="field"><label for="cat-price">Price (₹) *</label><input id="cat-price" type="number" min="0" step="1" inputmode="numeric" placeholder="e.g. 10" /></div>
        <div class="field"><label for="cat-cat">Type</label><select id="cat-cat">${catOpts('Food & drinks')}</select></div>
      </div>
      ${gstOn ? `<div class="field-row">
        <div class="field"><label for="cat-gst">GST</label><select id="cat-gst">${rateOpts(500)}</select></div>
        <div class="field"><label for="cat-incl">Price</label><select id="cat-incl">${inclOpts(true)}</select></div>
      </div>` : `<p class="td-small">GST is off. To add GST to items, turn it on in Settings → Business.</p>`}
      <div id="cat-error" class="error-msg hidden"></div>
      <div class="btn-group mt-12">
        <button class="btn btn-primary" onclick="submitCatalogItem()">+ Add item</button>
        ${active.length < 3 ? `<button class="btn btn-outline" onclick="addSampleItems()">Add common items (Tea, Coffee, Laundry…)</button>` : ''}
      </div>
    </div>
    ${active.length ? `
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Item</th><th>Type</th><th>Price (₹)</th>${gstOn ? '<th>GST</th><th>Guest pays</th>' : ''}<th></th></tr></thead>
        <tbody>${active.map(i => `
          <tr>
            <td><input class="cell-input" id="ci-n-${i.id}" value="${h(i.name)}" maxlength="60" aria-label="Item name" /></td>
            <td><select class="cell-input" id="ci-c-${i.id}" aria-label="Type">${catOpts(i.category)}${ITEM_CATEGORIES.includes(i.category) ? '' : `<option selected>${h(i.category)}</option>`}</select></td>
            <td><input class="cell-input num" id="ci-p-${i.id}" type="number" min="0" step="1" value="${(i.default_price_paise / 100)}" aria-label="Price" /></td>
            ${gstOn ? `<td class="nowrap"><select class="cell-input sm" id="ci-g-${i.id}" aria-label="GST rate">${rateOpts(i.gst_rate_bp)}</select>
              <select class="cell-input" id="ci-i-${i.id}" aria-label="GST included?">${inclOpts(i.gst_inclusive !== 0)}</select></td>
              <td class="num fw-bold">${rupees(gstSplit(i.default_price_paise, i.gst_rate_bp, i.gst_inclusive !== 0).gross)}</td>` : ''}
            <td class="actions">
              <button class="btn btn-outline btn-sm" onclick="saveCatalogItem('${i.id}')">Save</button>
              <button class="btn btn-outline btn-sm" onclick="setCatalogActive('${i.id}', false)">Remove</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `<div class="empty-state"><div class="empty-icon">☕</div><p>No items yet. Add Tea, Coffee etc. above.</p></div>`}
    ${hidden.length ? `
    <details class="mt-12"><summary class="td-small">Removed items (${hidden.length})</summary>
      <div class="card mt-12">${hidden.map(i => `
        <div class="task-row"><div>${h(i.name)} · ${rupees(i.default_price_paise)}</div>
          <button class="btn btn-outline btn-sm" onclick="setCatalogActive('${i.id}', true)">Bring back</button></div>`).join('')}
      </div></details>` : ''}`;
}

async function submitCatalogItem() {
  const err = document.getElementById('cat-error'); err.classList.add('hidden');
  const priceTxt = document.getElementById('cat-price').value;
  try {
    if (priceTxt === '' || !(parseFloat(priceTxt) >= 0)) throw new Error('Type a price (0 or more)');
    const g = document.getElementById('cat-gst'), inc = document.getElementById('cat-incl');
    await api('POST', '/addons/catalog', {
      name:                document.getElementById('cat-name').value.trim(),
      category:            document.getElementById('cat-cat').value,
      default_price_paise: Math.round(parseFloat(priceTxt) * 100),
      ...(g ? { gst_rate_bp: Number(g.value), gst_inclusive: inc.value === '1' } : {}),
    });
    toast('Item added', 'success'); renderPage('catalog');
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

async function saveCatalogItem(id) {
  const priceTxt = document.getElementById(`ci-p-${id}`).value;
  try {
    if (priceTxt === '' || !(parseFloat(priceTxt) >= 0)) throw new Error('Type a price (0 or more)');
    const g = document.getElementById(`ci-g-${id}`), inc = document.getElementById(`ci-i-${id}`);
    await api('PATCH', `/addons/catalog/${id}`, {
      name: document.getElementById(`ci-n-${id}`).value.trim(),
      category: document.getElementById(`ci-c-${id}`).value,
      default_price_paise: Math.round(parseFloat(priceTxt) * 100),
      ...(g ? { gst_rate_bp: Number(g.value), gst_inclusive: inc.value === '1' } : {}),
    });
    toast('Saved', 'success'); renderPage('catalog');
  } catch (ex) { toast(ex.message, 'error'); }
}

async function setCatalogActive(id, on) {
  try { await api('PATCH', `/addons/catalog/${id}`, { is_active: on }); toast(on ? 'Item is back in the list' : 'Item removed from the list', 'success'); renderPage('catalog'); }
  catch (ex) { toast(ex.message, 'error'); }
}

async function addSampleItems() {
  try { const r = await api('POST', '/addons/catalog/samples', {}); toast(r.added ? `${r.added} items added — change prices if needed` : 'These items are already in your list', 'success'); renderPage('catalog'); }
  catch (ex) { toast(ex.message, 'error'); }
}

// ── Audit Log ─────────────────────────────────────────────────
async function renderAudit(el) {
  const rows = await api('GET', '/audit');
  el.innerHTML = `
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Amount</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><div class="td-small">${new Date(r.created_at).toLocaleString('en-IN')}</div></td>
              <td>${h(r.actor_name)}</td>
              <td><code style="font-size:11px;background:var(--gray-100);padding:2px 6px;border-radius:4px">${h(r.action)}</code></td>
              <td>${h(r.entity_type)}<div class="td-small">${r.entity_id.substring(0,8)}…</div></td>
              <td>${r.amount_paise ? rupees(r.amount_paise) : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ── Admin Panel (superadmin only) ────────────────────────────
async function renderAdminPanel(el) {
  const [stats, accounts] = await Promise.all([
    api('GET', '/admin/stats'),
    api('GET', '/admin/accounts'),
  ]);

  el.innerHTML = `
    <div class="stat-grid mb-20">
      <div class="stat-card"><div class="stat-label">Total Accounts</div><div class="stat-value">${stats.total}</div></div>
      <div class="stat-card warning"><div class="stat-label">On Trial</div><div class="stat-value">${stats.trial}</div></div>
      <div class="stat-card success"><div class="stat-label">Active (Paid)</div><div class="stat-value">${stats.active}</div></div>
      <div class="stat-card danger"><div class="stat-label">Suspended</div><div class="stat-value">${stats.suspended}</div></div>
      <div class="stat-card"><div class="stat-label">Expired Trials</div><div class="stat-value">${stats.expired}</div></div>
      <div class="stat-card accent"><div class="stat-label">Live Residents</div><div class="stat-value">${stats.residents}</div></div>
    </div>
    <div class="card table-wrap">
      <strong>All Accounts</strong>
      <div class="table-wrap mt-12">
        <table>
          <thead><tr>
            <th>Business</th><th>Owner</th><th>Mobile</th><th>Plan</th>
            <th>Trial Ends</th><th>Properties</th><th>Residents</th><th>Actions</th>
          </tr></thead>
          <tbody>
            ${accounts.map(a => `
              <tr>
                <td><div class="td-name">${h(a.business_name)}</div></td>
                <td>${h(a.owner_name || '—')}</td>
                <td>${h(a.owner_mobile || '—')}</td>
                <td>
                  <span class="badge ${a.plan==='active'?'badge-success':a.plan==='trial'?'badge-warning':'badge-danger'}">
                    ${a.plan}
                  </span>
                </td>
                <td>${fmtDate(a.trial_ends_at)}</td>
                <td>${a.properties}</td>
                <td>${a.residents}</td>
                <td>
                  ${a.plan !== 'active' ? `<button class="btn btn-success btn-sm" onclick="adminActivate('${a.id}')">Activate</button>` : ''}
                  ${a.plan !== 'suspended' ? `<button class="btn btn-danger btn-sm" onclick="adminSuspend('${a.id}')">Suspend</button>` : ''}
                  <button class="btn btn-outline btn-sm" onclick="adminResetPassword('${a.id}','${esc(a.owner_name || '')}')">Reset password</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function adminActivate(id) {
  if (!confirm('Activate this account? Trial will be extended 30 days from today.')) return;
  try {
    await api('PATCH', `/admin/accounts/${id}/activate`);
    toast('Account activated', 'success');
    renderPage('admin');
  } catch(ex) { toast(ex.message, 'error'); }
}

function adminResetPassword(id, name) {
  openModal(`Reset password: ${name}`, `
    <div class="field"><label for="arp-pass">New password for the owner</label><input id="arp-pass" type="text" placeholder="Min 8 characters" /></div>
    <div id="arp-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-primary" onclick="submitAdminReset('${id}')">Set password</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}

async function submitAdminReset(id) {
  const err = document.getElementById('arp-error'); err.classList.add('hidden');
  try {
    const r = await api('POST', `/admin/accounts/${id}/reset-password`, { new_password: document.getElementById('arp-pass').value });
    toast(r.message + '. Tell the owner the new password.', 'success', 6000); closeModal();
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

async function adminSuspend(id) {
  const reason = prompt('Reason for suspension (optional):') ?? '';
  try {
    await api('PATCH', `/admin/accounts/${id}/suspend`, { reason });
    toast('Account suspended', 'warning');
    renderPage('admin');
  } catch(ex) { toast(ex.message, 'error'); }
}

// ── Staff login code (first sign-in / forgot MPIN) ─────────────
function showLoginCode(c, justAdded) {
  const site = location.origin;
  const msg = `Hello ${c.name}, your DormBook login code is ${c.code}.\nOpen ${site} → "Staff: first time / forgot MPIN" → type your mobile and this code, then set your own MPIN.\nThe code works once and ends in 24 hours. Do not share it.`;
  const wa = `https://wa.me/91${String(c.mobile || '').slice(-10)}?text=${encodeURIComponent(msg)}`;
  openModal(justAdded ? `${c.name} added` : `Login code for ${c.name}`, `
    <p>Give this code to <b>${h(c.name)}</b>. They open DormBook, tap <b>Staff: first time / forgot MPIN</b>, type their mobile and this code, and set their own MPIN.</p>
    <div class="code-big" aria-label="Login code">${h(String(c.code).replace(/(\d{3})(\d{3})/, '$1 $2'))}</div>
    <p class="td-small text-center">Works once · ends ${fmtDateTime(c.expires_at)}${c.sms_sent ? ' · also sent by SMS ✓' : ''}</p>
    <div class="btn-group mt-12 center">
      <a class="btn btn-whatsapp" href="${h(wa)}" target="_blank" rel="noopener">🟢 Send code on WhatsApp</a>
      <button class="btn btn-outline" onclick="copyText('${h(c.code)}')">Copy code</button>
      <button class="btn btn-outline" onclick="closeModal()">Done</button>
    </div>`);
}
function fmtDateTime(d) { return d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; }
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copied', 'success'); } catch { toast('Could not copy — please write it down', 'warning'); }
}
async function newLoginCode(userId) {
  try { const c = await api('POST', `/staff/${userId}/login-code`); showLoginCode(c, false); }
  catch (ex) { toast(ex.message, 'error'); }
}
async function unlockStaff(userId) {
  try { await api('PATCH', `/staff/${userId}`, { unlock: true }); toast('Unlocked. They can sign in again.', 'success'); renderPage('staff'); }
  catch (ex) { toast(ex.message, 'error'); }
}

// ── Staff sign-in screen: mobile + code → set MPIN ──────────────
function showMpinScreen() {
  const m = document.getElementById('login-email').value.replace(/\D/g, '');
  if (m.length >= 10) document.getElementById('mp-mobile').value = m.slice(-10);
  document.getElementById('mp-error').classList.add('hidden');
  document.getElementById('mp-info').classList.add('hidden');
  showScreen('mpin-screen');
}
async function requestMpinCode() {
  const info = document.getElementById('mp-info'), err = document.getElementById('mp-error');
  err.classList.add('hidden');
  const mobile = document.getElementById('mp-mobile').value.replace(/\D/g, '').slice(-10);
  if (mobile.length !== 10) { err.textContent = 'Type your 10-digit mobile number first'; err.classList.remove('hidden'); return; }
  try {
    const r = await api('POST', '/auth/staff/request-code', { mobile });
    info.textContent = r.message; info.classList.remove('hidden');
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}
async function submitMpinSetup() {
  const err = document.getElementById('mp-error'); err.classList.add('hidden');
  const btn = document.getElementById('mp-save');
  const mobile = document.getElementById('mp-mobile').value.replace(/\D/g, '').slice(-10);
  const code = document.getElementById('mp-code').value.replace(/\D/g, '');
  const pin = document.getElementById('mp-pin').value, pin2 = document.getElementById('mp-pin2').value;
  try {
    if (mobile.length !== 10) throw new Error('Type your 10-digit mobile number');
    if (code.length !== 6) throw new Error('The login code has 6 digits');
    if (!/^(\d{4}|\d{6})$/.test(pin)) throw new Error('MPIN must be 4 or 6 digits');
    if (pin !== pin2) throw new Error('The two MPINs are not the same');
    btn.disabled = true;
    const data = await api('POST', '/auth/staff/set-mpin', { mobile, code, mpin: pin });
    ['mp-code', 'mp-pin', 'mp-pin2'].forEach(id => { document.getElementById(id).value = ''; });
    startSession(data);
    toast('MPIN saved. Next time sign in with your mobile and MPIN.', 'success', 6000);
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
  btn.disabled = false;
}
function startSession(data) {
  STATE.token = data.token;
  STATE.user = data.user;
  sessionStorage.setItem('db_token', data.token);
  sessionStorage.setItem('db_user', JSON.stringify(data.user));
  showApp();
}
function setToken(token) {
  STATE.token = token;
  sessionStorage.setItem('db_token', token);
}

// ── Bill: send on WhatsApp + pay block (UPI QR, bank) ───────────
async function sendBillWhatsApp(residentId) {
  const btn = document.getElementById('bill-wa');
  if (btn) btn.disabled = true;
  // Open the tab first (phones block pop-ups opened after a wait), then point it to WhatsApp.
  const win = window.open('', '_blank');
  try {
    const r = await api('POST', `/residents/${residentId}/bill-link`);
    if (win) { win.opener = null; win.location.href = r.whatsapp_url; } else location.href = r.whatsapp_url;
    if (!r.mobile) toast('This guest has no valid mobile number — pick the chat in WhatsApp', 'warning', 6000);
  } catch (ex) { if (win) win.close(); toast(ex.message, 'error'); }
  if (btn) btn.disabled = false;
}
function payBlock(pay, balance, c = {}) {
  const payee = c.property_name || c.business_name || '';
  if (!pay) {
    return can('settings') ? `<div class="pay-empty no-print">Add your UPI QR and bank details in <a href="#" onclick="event.preventDefault();closeModal();navigate('account')">My Account</a> — guests can then scan and pay from the bill.</div>` : '';
  }
  const due = balance > 0 && pay.upi && pay.upi.amount_paise > 0;
  return `
    <div class="pay-box">
      ${pay.upi ? `<div class="pay-qr">${pay.upi.qr_svg}</div>` : ''}
      <div class="pay-text">
        <div class="pay-title">${due ? `Scan to pay ${rupees(balance)}` : 'Pay by UPI or bank'}${payee ? ` · to ${h(payee)}` : ''}</div>
        ${payee ? `<div class="pay-to">${h(payee)}${c.address ? ` · ${h(c.address)}` : ''}${c.phone ? ` · Ph: ${h(c.phone)}` : ''}</div>` : ''}
        ${pay.upi ? `<div>Any UPI app: GPay, PhonePe, Paytm, BHIM</div><div><b>UPI ID:</b> ${h(pay.upi.id)}${pay.upi.name ? ` (${h(pay.upi.name)})` : ''}</div>` : ''}
        ${pay.bank ? `<div class="pay-bank"><b>Bank transfer:</b> ${h(pay.bank.holder)}${pay.bank.name ? ` · ${h(pay.bank.name)}` : ''}<br>
          A/c ${h(pay.bank.account)} · IFSC ${h(pay.bank.ifsc)}${pay.bank.branch ? ` · ${h(pay.bank.branch)}` : ''}</div>` : ''}
      </div>
    </div>`;
}

// ── My Account ─────────────────────────────────────────────────
async function renderAccount(el) {
  const u = STATE.user;
  const isStaff = u.role === 'manager' || u.role === 'reception';
  const pay = can('settings') ? await api('GET', '/account/payment') : null;
  el.innerHTML = `
    <div class="card mb-20">
      <strong>You</strong>
      <dl class="facts mt-12">
        <div><dt>Name</dt><dd>${h(u.name)}</dd></div>
        <div><dt>Mobile</dt><dd>${h(u.mobile || '—')}</dd></div>
        <div><dt>Role</dt><dd>${h(u.role === 'reception' ? 'Reception' : u.role === 'manager' ? 'Manager' : 'Owner')}</dd></div>
        <div><dt>Sign-in</dt><dd>${u.has_mpin ? 'Mobile + MPIN' : 'Password'}</dd></div>
      </dl>
      <div class="btn-group mt-12">
        ${u.has_mpin ? `<button class="btn btn-outline" onclick="showChangeMpin()">Change MPIN</button>` : ''}
        ${!isStaff || !u.has_mpin ? `<button class="btn btn-outline" onclick="showChangePassword()">Change password</button>` : ''}
      </div>
    </div>
    ${pay ? `
    <div class="card mb-20">
      <strong>How guests pay you</strong>
      <p class="td-small mt-4">Printed at the end of every bill. The QR has the amount due filled in, so the guest just scans and pays.</p>
      <div class="acc-grid mt-12">
        <div>
          <div class="section-title">UPI QR</div>
          <div class="qr-preview" id="acc-qr">${pay.qr_svg || '<div class="text-muted td-small">No QR yet</div>'}</div>
          <label class="btn btn-primary mt-12">📷 Scan / upload your QR
            <input type="file" accept="image/*" capture="environment" hidden onchange="readQrImage(this)" /></label>
          <div class="field-note">Take a photo of your shop QR (PhonePe, GPay, Paytm, bank QR) or pick a screenshot. We read the UPI ID from it.</div>
          <div class="field mt-12"><label for="acc-upi">UPI ID</label><input id="acc-upi" value="${h(pay.upi_id)}" placeholder="name@okhdfcbank" autocomplete="off" /></div>
          <div class="field"><label for="acc-upiname">Name shown to the guest</label><input id="acc-upiname" value="${h(pay.upi_name)}" maxlength="100" /></div>
          <input type="hidden" id="acc-upiuri" value="" />
          ${pay.upi_signed ? '<div class="field-note">This is a shop QR with a security signature: guests type the amount themselves.</div>' : ''}
        </div>
        <div>
          <div class="section-title">Bank account (for bank transfer)</div>
          <div class="field"><label for="acc-holder">Account holder name</label><input id="acc-holder" value="${h(pay.bank_holder)}" maxlength="100" /></div>
          <div class="field"><label for="acc-bank">Bank name</label><input id="acc-bank" value="${h(pay.bank_name)}" maxlength="100" placeholder="e.g. State Bank of India" /></div>
          <div class="field"><label for="acc-acno">Account number</label><input id="acc-acno" value="${h(pay.bank_account)}" inputmode="numeric" maxlength="22" autocomplete="off" /></div>
          <div class="field-row">
            <div class="field"><label for="acc-ifsc">IFSC</label><input id="acc-ifsc" value="${h(pay.bank_ifsc)}" maxlength="11" style="text-transform:uppercase" placeholder="SBIN0001234" /></div>
            <div class="field"><label for="acc-branch">Branch</label><input id="acc-branch" value="${h(pay.bank_branch)}" maxlength="100" /></div>
          </div>
        </div>
      </div>
      <label class="switch-row mt-12"><input type="checkbox" id="acc-show" ${pay.show_pay_on_bill ? 'checked' : ''} />
        <span><strong>Show on bills</strong><br/><span class="td-small">Turn off to hide QR and bank details from bills.</span></span></label>
      <div id="acc-error" class="error-msg hidden"></div>
      <button class="btn btn-primary mt-12" id="acc-save" onclick="savePayment()">Save payment details</button>
    </div>` : ''}`;
}

async function savePayment() {
  const err = document.getElementById('acc-error'); err.classList.add('hidden');
  const v = (id) => document.getElementById(id).value.trim();
  const btn = document.getElementById('acc-save'); btn.disabled = true;
  try {
    const body = {
      upi_name: v('acc-upiname'), bank_holder: v('acc-holder'), bank_name: v('acc-bank'),
      bank_account: v('acc-acno').replace(/[\s-]/g, ''), bank_ifsc: v('acc-ifsc').toUpperCase(), bank_branch: v('acc-branch'),
      show_pay_on_bill: document.getElementById('acc-show').checked,
    };
    if (v('acc-upiuri')) body.upi_uri = v('acc-upiuri'); else body.upi_id = v('acc-upi');
    if (!!body.bank_account !== !!body.bank_ifsc) throw new Error('Type both the account number and the IFSC (or leave both empty)');
    await api('PATCH', '/account/payment', body);
    toast('Payment details saved', 'success');
    renderPage('account');
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); btn.disabled = false; }
}

/** Read the UPI text from a QR photo. Uses the phone's own reader when it has one, else jsQR (loaded only here). */
async function readQrImage(input) {
  const f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  const err = document.getElementById('acc-error'); err.classList.add('hidden');
  try {
    if (!/^image\//.test(f.type) || f.size > 15 * 1024 * 1024) throw new Error('Pick a photo of the QR (JPG or PNG)');
    const bmp = await createImageBitmap(f);
    let text = null;
    if ('BarcodeDetector' in window) {
      try { const found = await new BarcodeDetector({ formats: ['qr_code'] }).detect(bmp); text = found[0] && found[0].rawValue; } catch (_) { /* fall back */ }
    }
    if (!text) {
      await loadScriptOnce('/js/vendor/jsqr.min.js');
      for (const max of [1200, 800, 1800]) {          // try a few sizes: big photos and tiny screenshots both work
        const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
        const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, c.width, c.height);
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const r = window.jsQR(img.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
        if (r && r.data) { text = r.data; break; }
      }
    }
    if (!text) throw new Error('Could not read a QR in this photo. Hold the phone steady, fill the frame with the QR, or type your UPI ID.');
    if (!/^upi:\/\/pay\?/i.test(text)) throw new Error('This QR is not a UPI payment QR. Type your UPI ID instead.');
    const q = new URLSearchParams(text.slice(text.indexOf('?') + 1));
    const pa = q.get('pa') || '';
    if (!pa.includes('@')) throw new Error('No UPI ID found in this QR. Type your UPI ID instead.');
    document.getElementById('acc-upi').value = pa;
    if (q.get('pn') && !document.getElementById('acc-upiname').value) document.getElementById('acc-upiname').value = q.get('pn');
    document.getElementById('acc-upiuri').value = text;
    document.getElementById('acc-qr').innerHTML = `<div class="td-small text-success">✓ Read: <b>${h(pa)}</b>. Press "Save payment details".</div>`;
    toast(`UPI ID found: ${pa}`, 'success');
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}
const _scripts = {};
function loadScriptOnce(src) {
  if (!_scripts[src]) {
    _scripts[src] = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src; el.onload = resolve;
      el.onerror = () => { delete _scripts[src]; reject(new Error('Could not load the QR reader. Check your internet and try again.')); };
      document.head.appendChild(el);
    });
  }
  return _scripts[src];
}

function showChangePassword() {
  openModal('Change password', `
    <div class="field"><label for="cp-old">Current password</label><input id="cp-old" type="password" autocomplete="current-password" /></div>
    <div class="field"><label for="cp-new">New password (8 or more characters)</label><input id="cp-new" type="password" autocomplete="new-password" /></div>
    <div class="field"><label for="cp-new2">New password again</label><input id="cp-new2" type="password" autocomplete="new-password" /></div>
    <p class="td-small">Other phones and computers signed in as you will be signed out.</p>
    <div id="cp-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-primary" id="cp-save" onclick="submitChangePassword()">Change password</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}
async function submitChangePassword() {
  const err = document.getElementById('cp-error'); err.classList.add('hidden');
  const a = document.getElementById('cp-old').value, b = document.getElementById('cp-new').value, c = document.getElementById('cp-new2').value;
  try {
    if (b.length < 8) throw new Error('New password must be at least 8 characters');
    if (b !== c) throw new Error('The two new passwords are not the same');
    const r = await api('POST', '/auth/change-password', { current_password: a, new_password: b });
    if (r.token) setToken(r.token);
    closeModal(); toast('Password changed', 'success');
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}
function showChangeMpin() {
  openModal('Change MPIN', `
    <div class="field"><label for="cm-old">Current MPIN</label><input id="cm-old" type="password" inputmode="numeric" maxlength="6" autocomplete="off" /></div>
    <div class="field"><label for="cm-new">New MPIN (4 or 6 digits)</label><input id="cm-new" type="password" inputmode="numeric" maxlength="6" autocomplete="off" /></div>
    <div class="field"><label for="cm-new2">New MPIN again</label><input id="cm-new2" type="password" inputmode="numeric" maxlength="6" autocomplete="off" /></div>
    <div id="cm-error" class="error-msg hidden"></div>
    <div class="btn-group mt-12"><button class="btn btn-primary" onclick="submitChangeMpin()">Change MPIN</button>
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button></div>`);
}
async function submitChangeMpin() {
  const err = document.getElementById('cm-error'); err.classList.add('hidden');
  const a = document.getElementById('cm-old').value, b = document.getElementById('cm-new').value, c = document.getElementById('cm-new2').value;
  try {
    if (!/^(\d{4}|\d{6})$/.test(b)) throw new Error('New MPIN must be 4 or 6 digits');
    if (b !== c) throw new Error('The two new MPINs are not the same');
    const r = await api('POST', '/auth/change-mpin', { current_mpin: a, new_mpin: b });
    if (r.token) setToken(r.token);
    closeModal(); toast('MPIN changed', 'success');
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); }
}

// ── Boot ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
