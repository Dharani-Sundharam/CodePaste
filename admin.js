/* ═══════════════════════════════════════════════════════
   CTpaste — admin.js  v3
   Admin panel: users, suspend, payment queue approval
   + Session persistence across refresh
   + Real-time Firebase SSE listeners (no more polling)
   ═══════════════════════════════════════════════════════ */

let allUsers = {};
let currentTab = "users";

const LS_AUTO_APPROVE_ROLLS = "ctpaste_admin_auto_approve_rolls";
const LS_AUTO_APPROVE_PAYMENTS = "ctpaste_admin_auto_approve_payments";
const LS_PAYMENT_QUEUE_DISMISSED = "ctpaste_admin_dismissed_payment_queue_keys";

// SSE streams
let usersStream = null;
let paymentsStream = null;
let pendingRollStream = null;

function getAutoApproveRollsOn() {
    return localStorage.getItem(LS_AUTO_APPROVE_ROLLS) === "1";
}
function getAutoApprovePaymentsOn() {
    return localStorage.getItem(LS_AUTO_APPROVE_PAYMENTS) === "1";
}
function onAutoApproveRollsToggle(on) {
    localStorage.setItem(LS_AUTO_APPROVE_ROLLS, on ? "1" : "0");
    loadAdminDashboard();
}
function onAutoApprovePaymentsToggle(on) {
    localStorage.setItem(LS_AUTO_APPROVE_PAYMENTS, on ? "1" : "0");
    loadAdminDashboard();
}
function syncAutoApproveCheckboxes() {
    const r = document.getElementById("autoApproveRolls");
    const p = document.getElementById("autoApprovePayments");
    if (r) r.checked = getAutoApproveRollsOn();
    if (p) p.checked = getAutoApprovePaymentsOn();
}

function getPaymentQueueDismissedKeys() {
    try {
        const s = localStorage.getItem(LS_PAYMENT_QUEUE_DISMISSED);
        const a = s ? JSON.parse(s) : [];
        return new Set(Array.isArray(a) ? a : []);
    } catch {
        return new Set();
    }
}
function savePaymentQueueDismissedKeys(set) {
    localStorage.setItem(LS_PAYMENT_QUEUE_DISMISSED, JSON.stringify([...set]));
}
function pruneStalePaymentDismissals(allPayments) {
    const valid = new Set(Object.keys(allPayments || {}));
    const set = getPaymentQueueDismissedKeys();
    let changed = false;
    for (const k of [...set]) {
        if (!valid.has(k)) {
            set.delete(k);
            changed = true;
        }
    }
    if (changed) savePaymentQueueDismissedKeys(set);
}
function dismissPaymentQueueCard(key) {
    const set = getPaymentQueueDismissedKeys();
    set.add(key);
    savePaymentQueueDismissedKeys(set);
    loadAdminDashboard();
}

// ── Page startup ───────────────────────────────────────
function adminStartup() {
    checkAdminSetup();
}

// ── Check first-time setup ─────────────────────────────
async function checkAdminSetup() {
    const admin = await fbGet("admin");
    if (!admin || (!admin.password && !admin.password_hash)) {
        document.getElementById("adminLoginForm").style.display = "none";
        document.getElementById("adminSetup").style.display = "block";
    }
}

async function setupAdminPassword() {
    const pass = document.getElementById("adminNewPass").value;
    const confirm = document.getElementById("adminNewPassConfirm").value;
    if (pass.length < 4) { showStatus("adminStatus", "Min 4 characters.", "error"); return; }
    if (pass !== confirm) { showStatus("adminStatus", "Passwords don't match.", "error"); return; }

    await fbUpdate("admin", { password: pass });
    showStatus("adminStatus", "Password set! Logging you in...", "success");
    setTimeout(() => {
        document.getElementById("adminSetup").style.display = "none";
        document.getElementById("adminLoginForm").style.display = "block";
        clearStatus("adminStatus");
    }, 1200);
}

async function adminLogin() {
    const pass = document.getElementById("adminPass").value;
    if (!pass) { showStatus("adminStatus", "Enter password.", "error"); return; }
    showStatus("adminStatus", "Verifying...", "info");
    const admin = await fbGet("admin");

    // Support legacy admin hash upgrade
    const expectedHash = await (async function () {
        const data = new TextEncoder().encode(pass + "__CTpaste_salt__");
        const buf = await crypto.subtle.digest("SHA-256", data);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    })();

    if (!admin || (admin.password !== pass && admin.password_hash !== expectedHash)) {
        showStatus("adminStatus", "Incorrect password.", "error"); return;
    }

    // Upgrade seamlessly
    if (!admin.password && admin.password_hash === expectedHash) {
        await fbUpdate("admin", { password: pass });
    }

    document.getElementById("adminLogin").style.display = "none";
    document.getElementById("adminDashboard").style.display = "block";
    loadAdminDashboard();
    startRealTimeListeners();
}

function adminLogout() {
    stopRealTimeListeners();
    window.location.reload();
}

// ── Real-time Firebase SSE Listeners ──────────────────
function startRealTimeListeners() {
    const base = DB_URL;

    // --- Users stream ---
    if (usersStream) usersStream.close();
    usersStream = new EventSource(`${base}/users.json?stream=true`);
    usersStream.addEventListener("put", () => {
        loadAdminDashboard();
    });
    usersStream.addEventListener("patch", () => {
        loadAdminDashboard();
    });
    usersStream.onerror = () => {
        // Silently ignore — browser will auto-reconnect
    };

    // --- Payments stream ---
    if (paymentsStream) paymentsStream.close();
    paymentsStream = new EventSource(`${base}/payment_requests.json?stream=true`);
    paymentsStream.addEventListener("put", (e) => {
        _handlePaymentStreamEvent(e);
    });
    paymentsStream.addEventListener("patch", (e) => {
        _handlePaymentStreamEvent(e);
    });
    paymentsStream.onerror = () => {
        // Silently ignore — browser will auto-reconnect
    };

    if (pendingRollStream) pendingRollStream.close();
    pendingRollStream = new EventSource(`${base}/pending_roll_requests.json?stream=true`);
    pendingRollStream.addEventListener("put", _handlePendingRollStreamEvent);
    pendingRollStream.addEventListener("patch", _handlePendingRollStreamEvent);
    pendingRollStream.onerror = () => {};

    // Show live indicator
    const liveEl = document.getElementById("liveIndicator");
    if (liveEl) liveEl.style.display = "inline-block";
}

function _handlePaymentStreamEvent(e) {
    try {
        const payload = JSON.parse(e.data);
        // Only react to actual new data (not null/keepalive)
        if (payload && payload.data !== null) {
            // Reload the full dashboard to keep stats + table in sync
            loadAdminDashboard();
        }
    } catch (_) { /* ignore parse errors */ }
}

function _handlePendingRollStreamEvent(e) {
    try {
        const payload = JSON.parse(e.data);
        if (payload && payload.data !== null) {
            loadAdminDashboard();
        }
    } catch (_) { /* ignore */ }
}

function stopRealTimeListeners() {
    if (usersStream) { usersStream.close(); usersStream = null; }
    if (paymentsStream) { paymentsStream.close(); paymentsStream = null; }
    if (pendingRollStream) { pendingRollStream.close(); pendingRollStream = null; }
    // Hide live indicator
    const liveEl = document.getElementById("liveIndicator");
    if (liveEl) liveEl.style.display = "none";
}

// ── Tab switching ──────────────────────────────────────
function switchTab(tab) {
    currentTab = tab;
    document.getElementById("tabUsers").style.display = tab === "users" ? "block" : "none";
    document.getElementById("tabPendingRolls").style.display = tab === "pendingRolls" ? "block" : "none";
    document.getElementById("tabPayments").style.display = tab === "payments" ? "block" : "none";
    document.getElementById("tabPaylog").style.display = tab === "paylog" ? "block" : "none";
    document.querySelectorAll(".admin-tab").forEach(t => t.classList.remove("active"));
    document.getElementById("tab-" + tab).classList.add("active");
}

// ── Load Dashboard ─────────────────────────────────────
async function loadAdminDashboard() {
    syncAutoApproveCheckboxes();

    let [usersRaw, payments, rollReqRaw] = await Promise.all([
        fbGet("users"),
        fbGet("payment_requests"),
        fbGet("pending_roll_requests")
    ]);

    let pendingPayments = payments
        ? Object.entries(payments).filter(([, p]) => p && p.status === "pending")
        : [];

    let pendingRollEntries = rollReqRaw && typeof rollReqRaw === "object"
        ? Object.entries(rollReqRaw).filter(([, r]) => r && (!r.status || r.status === "pending"))
        : [];

    let didAuto = false;
    if (getAutoApproveRollsOn() && pendingRollEntries.length) {
        for (const [roll] of pendingRollEntries) {
            try {
                await _approvePendingRollCore(roll, { auto: true });
                didAuto = true;
            } catch (e) {
                console.warn("Auto-approve roll failed", roll, e);
            }
        }
    }
    if (getAutoApprovePaymentsOn() && pendingPayments.length) {
        for (const [key, p] of pendingPayments) {
            try {
                await _approvePaymentCore(key, p.roll_number, p.requested_plan, { auto: true });
                didAuto = true;
            } catch (e) {
                console.warn("Auto-approve payment failed", key, e);
            }
        }
    }
    if (didAuto) {
        [usersRaw, payments, rollReqRaw] = await Promise.all([
            fbGet("users"),
            fbGet("payment_requests"),
            fbGet("pending_roll_requests")
        ]);
    }

    const usersAfter = usersRaw && typeof usersRaw === "object" ? usersRaw : {};
    allUsers = usersAfter;
    const entries = Object.entries(usersAfter);
    const signedUp = entries.filter(([, u]) => (u.password || u.password_hash)).length;
    const superCount = entries.filter(([, u]) => u.active_addons && u.active_addons.super_pass).length;
    const proCount = entries.filter(([, u]) => {
        const a = u.active_addons || {};
        return !a.super_pass && ((a.ai_addon_expiry && Date.now() < a.ai_addon_expiry) || (a.sync_app_expiry && Date.now() < a.sync_app_expiry));
    }).length;
    const goCount = entries.filter(([, u]) => !u.active_addons || (!u.active_addons.speed_boost && !u.active_addons.extra_hours_added && !u.active_addons.super_pass)).length;
    const suspended = entries.filter(([, u]) => u.suspended).length;

    pendingPayments = payments
        ? Object.entries(payments).filter(([, p]) => p && p.status === "pending")
        : [];

    pendingRollEntries = rollReqRaw && typeof rollReqRaw === "object"
        ? Object.entries(rollReqRaw).filter(([, r]) => r && (!r.status || r.status === "pending"))
        : [];

    const rollQueueEntries = rollReqRaw && typeof rollReqRaw === "object"
        ? Object.entries(rollReqRaw).filter(([, r]) => r && (!r.status || r.status === "pending" || r.status === "approved"))
        : [];

    pruneStalePaymentDismissals(payments || {});
    const dismissedPay = getPaymentQueueDismissedKeys();

    document.getElementById("statTotal").textContent = entries.length;
    document.getElementById("statSignedUp").textContent = signedUp;
    document.getElementById("statGo").textContent = goCount;
    document.getElementById("statPro").textContent = proCount;
    document.getElementById("statSuper").textContent = superCount;
    document.getElementById("statSuspended").textContent = suspended;
    document.getElementById("statPending").textContent = pendingPayments.length;
    document.getElementById("statRollPending").textContent = pendingRollEntries.length;

    const rollBadge = document.getElementById("rollRequestNotifBadge");
    if (pendingRollEntries.length > 0) {
        rollBadge.style.display = "inline-flex";
        rollBadge.textContent = pendingRollEntries.length;
    } else {
        rollBadge.style.display = "none";
    }

    // Payment badge
    const badge = document.getElementById("paymentNotifBadge");
    if (pendingPayments.length > 0) {
        badge.style.display = "inline-flex";
        badge.textContent = pendingPayments.length;
    } else {
        badge.style.display = "none";
    }

    renderUsersTable(entries);
    renderPendingRollQueue(rollQueueEntries);
    renderPaymentQueue(pendingPayments, payments ? payments : {}, dismissedPay);

    // Revenue = sum of approved payment amounts
    const allPaymentEntries = payments ? Object.values(payments) : [];
    const revenue = allPaymentEntries
        .filter(p => p.status === "approved")
        .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    document.getElementById("statRevenue").textContent = "\u20b9" + revenue.toLocaleString("en-IN");

    renderPaymentLog(payments ? Object.entries(payments) : []);
}

// ── Pending roll requests (edge-case registrations) ─────
function renderPendingRollQueue(entries) {
    const tbody = document.getElementById("pendingRollsBody");
    const empty = document.getElementById("pendingRollsEmpty");
    if (!tbody || !empty) return;

    if (!entries.length) {
        tbody.innerHTML = "";
        empty.style.display = "block";
        empty.textContent = "No roll requests in the queue";
        return;
    }
    empty.style.display = "none";

    const sorted = [...entries].sort((a, b) => (b[1].submitted_at || 0) - (a[1].submitted_at || 0));
    tbody.innerHTML = sorted.map(([roll, r]) => {
        const ts = r.submitted_at
            ? new Date(r.submitted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
            : "—";
        const isApproved = r.status === "approved";
        const approvedTs = r.approved_at
            ? new Date(r.approved_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
            : "—";
        const statusCell = isApproved
            ? `<span style="color:var(--green);font-size:.83rem;font-weight:600;">Approved</span>${r.auto_approved ? ' <span style="font-size:.72rem;color:var(--text3);">(auto)</span>' : ""}<div style="font-size:.75rem;color:var(--text3);margin-top:4px;">${approvedTs}</div>`
            : `<span style="color:var(--yellow);font-size:.83rem;">Pending review</span>`;
        const actions = isApproved
            ? `<button type="button" class="btn btn-xs btn-outline" onclick='dismissApprovedRollRequest(${JSON.stringify(roll)})'>Dismiss</button>`
            : `<div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button type="button" class="btn btn-xs btn-green" onclick='approvePendingRoll(${JSON.stringify(roll)})'>Approve</button>
                    <button type="button" class="btn btn-xs btn-red" onclick='rejectPendingRoll(${JSON.stringify(roll)})'>Reject</button>
                </div>`;
        return `<tr id="pendingRollRow_${roll}">
            <td style="font-weight:600;font-variant-numeric:tabular-nums;">${r.roll_number || roll}</td>
            <td style="font-size:.85rem;color:var(--text2);">${ts}</td>
            <td style="vertical-align:top;">${statusCell}</td>
            <td>${actions}</td>
        </tr>`;
    }).join("");
}

async function _approvePendingRollCore(roll, opts) {
    const auto = opts && opts.auto;
    const existing = await fbGet(`users/${roll}`);
    if (!existing) {
        await fbUpdate(`users/${roll}`, { roll_number: roll, plan: "GO" });
    }
    const patch = {
        status: "approved",
        approved_at: Date.now(),
        roll_number: roll
    };
    if (auto) patch.auto_approved = true;
    await fbUpdate(`pending_roll_requests/${roll}`, patch);
}

async function approvePendingRoll(roll) {
    if (!roll) return;
    if (!confirm(`Approve roll ${roll} and create a GO account stub (if missing)?`)) return;
    try {
        await _approvePendingRollCore(roll, { auto: false });
        await loadAdminDashboard();
    } catch (e) {
        alert("Approve failed: " + (e && e.message ? e.message : String(e)));
    }
}

async function dismissApprovedRollRequest(roll) {
    if (!roll) return;
    try {
        await fbDelete(`pending_roll_requests/${roll}`);
        await loadAdminDashboard();
    } catch (e) {
        alert("Dismiss failed: " + (e && e.message ? e.message : String(e)));
    }
}

async function rejectPendingRoll(roll) {
    if (!roll) return;
    if (!confirm(`Reject and remove the pending request for ${roll}?`)) return;
    try {
        await fbDelete(`pending_roll_requests/${roll}`);
        await loadAdminDashboard();
    } catch (e) {
        alert("Reject failed: " + (e && e.message ? e.message : String(e)));
    }
}

// ── Render users table ─────────────────────────────────
function renderUsersTable(entries) {
    const tbody = document.getElementById("usersTable");
    if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text3);">No users</td></tr>';
        return;
    }
    tbody.innerHTML = entries.map(([roll, u]) => {
        const name = u.name || "—";
        const suspended = u.suspended ? true : false;
        const isOnline = u.last_active && (Date.now() - u.last_active < 45000);
        const lastLogin = u.last_login ? new Date(u.last_login).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }) : "—";
        const statusText = suspended ? "Suspended" : (isOnline ? "Online 🟢" : ((u.password || u.password_hash) ? "Offline ⭕" : "Not Registered"));
        const statusCol = suspended ? "var(--red)" : (isOnline ? "var(--green)" : "var(--text3)");
        const hasPending = u.pending_plan ? true : false;

        // Add-ons Display
        const addons = u.active_addons || {};
        let addonsText = "Base";
        let parts = [];
        if (addons.super_pass) parts.push("Medium Speed + 3 Hrs");

        if (addons.sync_app_expiry && Date.now() < addons.sync_app_expiry) {
            parts.push("Phone Sync");
        }

        if (addons.ai_addon_expiry && Date.now() < addons.ai_addon_expiry) {
            const expTime = new Date(addons.ai_addon_expiry).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
            parts.push(`⚡ AI Addon (til ${expTime})`);
        }

        if (parts.length > 0) addonsText = parts.join(" | ");

        const uiPass = u.password
            ? `<div style="font-family:monospace; font-size: 0.9rem; margin-bottom: 4px; color:var(--text1);">${u.password}</div>`
            : (u.password_hash ? `<div style="font-size: 0.8rem; color:var(--text3);">[Legacy Hash]</div>` : `<div style="font-size: 0.8rem; color:var(--red);">[No Pass]</div>`);

        return `<tr id="userRow_${roll}" ${suspended ? 'style="opacity:.6;"' : ""}>
            <td style="font-weight:600;font-variant-numeric:tabular-nums;">${roll}${hasPending ? ' <span style="color:var(--yellow);font-size:.75rem;">(pending)</span>' : ""}</td>
            <td>${name}</td>
            <td>
                ${uiPass}
                <button class="btn btn-xs btn-outline" onclick="editPassword('${roll}', '${name.replace(/'/g, "\\'")}')" style="font-size: 0.7rem; padding: 2px 5px;">Edit Pass</button>
            </td>
            <td>
                <div style="font-size: .85rem; margin-bottom: 4px; color: var(--text1);">${addonsText}</div>
                <select onchange="applyAddon('${roll}', this.value); this.selectedIndex=0;" style="${suspended ? 'pointer-events:none;opacity:.4;' : ''}; font-size:.8rem; padding: 2px 4px;">
                    <option value="" disabled selected>Give Add-On...</option>
                    <option value="SYNC_APP">Phone Sync (7-Day)</option>
                    <option value="AI_ADDON">AI Addon (Expires EOD)</option>
                    <option value="AI_SYNC">AI + Sync</option>
                    <option value="MEDIUM3H_AI">Medium 3Hr + AI</option>
                    <option value="MEDIUM3H_AI_SYNC">Medium 3Hr + AI + Sync</option>
                    <option value="RESET">Reset to Base</option>
                </select>
            </td>
            <td id="status_${roll}" style="color:${statusCol};font-size:.83rem;">${statusText}</td>
            <td id="lastLogin_${roll}" style="font-size:.8rem;color:var(--text2);">${lastLogin}</td>
            <td>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <button class="btn btn-xs btn-outline" onclick="resetSession('${roll}')">Reset Session</button>
                    ${suspended
            ? `<button class="btn btn-xs btn-green" onclick="unsuspendUser('${roll}')">Unsuspend</button>`
            : `<button class="btn btn-xs btn-red"   onclick="suspendUser('${roll}')">Suspend</button>`
        }
                    <button class="btn btn-xs btn-outline" style="color:var(--red);border-color:var(--red);" onclick='deleteUserAccount(${JSON.stringify(roll)})'>Delete account</button>
                </div>
            </td>
        </tr>`;
    }).join("");
}

// ── Apply Addon ────────────────────────────────────────
async function applyAddon(roll, addonAction) {
    if (!addonAction) return;

    // Fetch fresh user data to safely stack
    const userData = await fbGet(`users/${roll}`);
    if (!userData) return;

    let active_addons = userData.active_addons || { speed_boost: false, extra_hours_added: 0, super_pass: false };

    if (addonAction === "RESET") {
        active_addons = { speed_boost: false, extra_hours_added: 0, super_pass: false };
        active_addons.sync_app_expiry = null;
        active_addons.ai_addon_expiry = null;
    } else if (addonAction === "SYNC_APP") {
        active_addons.super_pass = false;
        active_addons.speed_boost = false;
        active_addons.extra_hours_added = 0;
        active_addons.sync_app_expiry = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 days from now
    } else if (addonAction === "AI_ADDON") {
        active_addons.super_pass = false;
        active_addons.speed_boost = false;
        active_addons.extra_hours_added = 0;
        // Expires at end-of-day (midnight IST = UTC+5:30)
        const now = new Date();
        const istOffsetMs = 5.5 * 60 * 60 * 1000;
        const istNow = new Date(now.getTime() + istOffsetMs);
        const istMidnight = new Date(istNow);
        istMidnight.setUTCHours(23, 59, 59, 999);
        active_addons.ai_addon_expiry = istMidnight.getTime() - istOffsetMs;
    } else if (addonAction === "AI_SYNC") {
        active_addons.super_pass = false;
        active_addons.speed_boost = false;
        active_addons.extra_hours_added = 0;
        active_addons.sync_app_expiry = Date.now() + (7 * 24 * 60 * 60 * 1000);
        const now = new Date();
        const istOffsetMs = 5.5 * 60 * 60 * 1000;
        const istNow = new Date(now.getTime() + istOffsetMs);
        const istMidnight = new Date(istNow);
        istMidnight.setUTCHours(23, 59, 59, 999);
        active_addons.ai_addon_expiry = istMidnight.getTime() - istOffsetMs;
    } else if (addonAction === "MEDIUM3H_AI") {
        active_addons.super_pass = true;
        active_addons.speed_boost = false;
        active_addons.extra_hours_added = 0;
        active_addons.sync_app_expiry = null;
        const now = new Date();
        const istOffsetMs = 5.5 * 60 * 60 * 1000;
        const istNow = new Date(now.getTime() + istOffsetMs);
        const istMidnight = new Date(istNow);
        istMidnight.setUTCHours(23, 59, 59, 999);
        active_addons.ai_addon_expiry = istMidnight.getTime() - istOffsetMs;
    } else if (addonAction === "MEDIUM3H_AI_SYNC") {
        active_addons.super_pass = true;
        active_addons.speed_boost = false;
        active_addons.extra_hours_added = 0;
        active_addons.sync_app_expiry = Date.now() + (7 * 24 * 60 * 60 * 1000);
        const now = new Date();
        const istOffsetMs = 5.5 * 60 * 60 * 1000;
        const istNow = new Date(now.getTime() + istOffsetMs);
        const istMidnight = new Date(istNow);
        istMidnight.setUTCHours(23, 59, 59, 999);
        active_addons.ai_addon_expiry = istMidnight.getTime() - istOffsetMs;
    }

    await fbUpdate(`users/${roll}`, {
        active_addons,
        plan_activated_by: "admin",
        plan_activated_at: Date.now(),
        pending_plan: null,
        pending_submitted_at: null
    });

    allUsers[roll].active_addons = active_addons;
    renderUsersTable(Object.entries(allUsers));
    flashRow(roll, "rgba(88,166,255,.1)");
}

// ── Suspend / Unsuspend ────────────────────────────────
async function suspendUser(roll) {
    if (!confirm(`Suspend account ${roll}? They won't be able to login.`)) return;
    await fbUpdate(`users/${roll}`, { suspended: true });
    allUsers[roll].suspended = true;
    renderUsersTable(Object.entries(allUsers));
}

async function unsuspendUser(roll) {
    await fbUpdate(`users/${roll}`, { suspended: false });
    allUsers[roll].suspended = false;
    renderUsersTable(Object.entries(allUsers));
}

// ── Reset session ──────────────────────────────────────
async function resetSession(roll) {
    await fbSet(`sessions/${roll}`, null);
    flashRow(roll, "rgba(63,185,80,.1)");
}

async function deleteUserAccount(roll) {
    if (!roll) return;
    if (!confirm(`Permanently delete account ${roll}?\n\nThis removes their user row and session. They can be re-added later if their roll matches your rules.`)) return;
    if (!confirm(`Confirm again: delete ${roll} from the database?`)) return;
    try {
        await fbSet(`sessions/${roll}`, null);
        await fbDelete(`users/${roll}`);
        await loadAdminDashboard();
        const q = document.getElementById("searchInput") && document.getElementById("searchInput").value;
        if (q) filterUsers();
    } catch (e) {
        alert("Delete failed: " + (e && e.message ? e.message : String(e)));
    }
}

// ── Search / filter ────────────────────────────────────
function filterUsers() {
    const q = document.getElementById("searchInput").value.toLowerCase();
    const entries = Object.entries(allUsers);
    renderUsersTable(q ? entries.filter(([r, u]) => r.includes(q) || (u.name && u.name.toLowerCase().includes(q))) : entries);
}

// ── Highlight row ──────────────────────────────────────
function flashRow(roll, color) {
    document.querySelectorAll("#usersTable tr").forEach(r => {
        if (r.cells[0] && r.cells[0].textContent.startsWith(roll)) {
            r.style.background = color;
            setTimeout(() => { r.style.background = ""; }, 900);
        }
    });
}

// ── Payment Log ───────────────────────────────────────
let allPaymentLogEntries = [];

function renderPaymentLog(entries) {
    // Sort newest first
    allPaymentLogEntries = [...entries].sort((a, b) => (b[1].submitted_at || 0) - (a[1].submitted_at || 0));
    _drawPaymentLog(allPaymentLogEntries);
}

function filterPaymentLog() {
    const q = document.getElementById("paylogSearch").value.toLowerCase().trim();
    const filtered = q
        ? allPaymentLogEntries.filter(([, p]) =>
            (p.roll_number && p.roll_number.toLowerCase().includes(q)) ||
            (p.name && p.name.toLowerCase().includes(q)) ||
            (p.requested_plan && p.requested_plan.toLowerCase().includes(q))
        )
        : allPaymentLogEntries;
    _drawPaymentLog(filtered);
}

function _drawPaymentLog(entries) {
    const tbody = document.getElementById("paylogBody");
    const empty = document.getElementById("paylogEmpty");
    const revEl = document.getElementById("paylogRevenue");

    const revenue = entries
        .filter(([, p]) => p.status === "approved")
        .reduce((sum, [, p]) => sum + (parseFloat(p.amount) || 0), 0);
    revEl.textContent = "\u20b9" + revenue.toLocaleString("en-IN");

    if (!entries.length) {
        tbody.innerHTML = "";
        empty.style.display = "block";
        return;
    }
    empty.style.display = "none";

    tbody.innerHTML = entries.map(([key, p]) => {
        const ts = p.submitted_at
            ? new Date(p.submitted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })
            : "—";
        const statusColor = p.status === "approved" ? "var(--green)" : p.status === "rejected" ? "var(--red)" : "var(--yellow)";
        const statusLabel = p.status === "approved" ? "✓ Approved" : p.status === "rejected" ? "✗ Rejected" : "⏳ Pending";
        const screenshotBtn = p.screenshot_url
            ? `<a href="${p.screenshot_url}" target="_blank" class="btn btn-xs btn-outline">View</a>`
            : "—";
        return `<tr>
            <td style="font-weight:600;font-variant-numeric:tabular-nums;">${p.roll_number || "—"}</td>
            <td>${p.name || "—"}</td>
            <td>${p.requested_plan || "—"}</td>
            <td style="font-weight:600;">₹${p.amount || "—"}</td>
            <td style="color:${statusColor};font-size:.83rem;font-weight:600;">${statusLabel}</td>
            <td style="font-size:.8rem;color:var(--text2);">${ts}</td>
            <td>${screenshotBtn}</td>
        </tr>`;
    }).join("");
}

// ── Payment Queue ─────────────────────────────────────
function renderPaymentQueue(pendingEntries, allPayments, dismissedPay) {
    const list = document.getElementById("paymentQueueList");
    const empty = document.getElementById("paymentQueueEmpty");
    const hint = document.getElementById("paymentQueueHint");
    if (!list || !empty) return;

    const dismissed = dismissedPay || new Set();

    const approvedSticky = [];
    if (allPayments && typeof allPayments === "object") {
        for (const [key, p] of Object.entries(allPayments)) {
            if (p && p.status === "approved" && p.show_in_admin_queue && !dismissed.has(key)) {
                approvedSticky.push([key, p]);
            }
        }
    }

    const combined = [
        ...pendingEntries.map((entry) => ({ kind: "pending", entry })),
        ...approvedSticky.map((entry) => ({ kind: "approved", entry }))
    ];
    combined.sort((a, b) => (b.entry[1].submitted_at || 0) - (a.entry[1].submitted_at || 0));

    if (hint) {
        hint.style.display = approvedSticky.length > 0 ? "block" : "none";
    }

    if (!combined.length) {
        list.innerHTML = "";
        empty.style.display = "block";
        return;
    }
    empty.style.display = "none";

    list.innerHTML = combined.map(({ kind, entry: [key, p] }) => {
        const ts = p.submitted_at ? new Date(p.submitted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
        const reviewed = p.reviewed_at ? new Date(p.reviewed_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
        const thumb = p.screenshot_url
            ? `<img class="queue-thumb" src="${p.screenshot_url}" alt="Screenshot" onclick='openLightbox(${JSON.stringify(p.screenshot_url)})'>`
            : `<div class="queue-thumb" style="display:flex;align-items:center;justify-content:center;background:var(--bg2);color:var(--text3);font-size:.75rem;">No image</div>`;
        const statusBlock = kind === "approved"
            ? `<p style="margin-top:6px;color:var(--green);font-weight:600;font-size:.85rem;">Approved${p.auto_approved ? " <span style=\"color:var(--text3);font-weight:400;font-size:.75rem;\">(auto)</span>" : ""}</p><p style="margin-top:2px;font-size:.8rem;color:var(--text3);">Reviewed: ${reviewed}</p>`
            : "";
        const actions = kind === "pending"
            ? `<div class="queue-actions">
                    <button type="button" class="btn btn-green btn-sm" onclick='approvePayment(${JSON.stringify(key)}, ${JSON.stringify(p.roll_number)}, ${JSON.stringify(p.requested_plan)})'>✓ Approve</button>
                    <button type="button" class="btn btn-red btn-sm" onclick='rejectPayment(${JSON.stringify(key)}, ${JSON.stringify(p.roll_number)})'>✗ Reject</button>
                    ${p.screenshot_url ? `<a href="${p.screenshot_url}" target="_blank" class="btn btn-outline btn-sm">Full Image</a>` : ""}
                </div>`
            : `<div class="queue-actions">
                    <button type="button" class="btn btn-outline btn-sm" onclick='dismissPaymentQueueCard(${JSON.stringify(key)})'>Dismiss</button>
                    ${p.screenshot_url ? `<a href="${p.screenshot_url}" target="_blank" class="btn btn-outline btn-sm">Full Image</a>` : ""}
                </div>`;
        return `
        <div class="card queue-card" id="queueCard_${key.replace(/[^a-zA-Z0-9_-]/g, "_")}">
            ${thumb}
            <div class="queue-info">
                <strong>${p.roll_number || ""}</strong> — ${p.name || ""}
                <p>Requested: <strong>${p.requested_plan || "—"}</strong> &nbsp;·&nbsp; ₹${p.amount ?? "—"}</p>
                <p style="margin-top:2px;">Submitted: ${ts}</p>
                ${statusBlock}
                ${actions}
            </div>
        </div>`;
    }).join("");
}

async function _approvePaymentCore(key, roll, plan, opts) {
    if (!roll || !plan) {
        throw new Error("Missing roll or plan on payment request");
    }
    await applyAddon(roll, plan);
    const patch = { status: "approved", reviewed_at: Date.now(), show_in_admin_queue: true };
    if (opts && opts.auto) patch.auto_approved = true;
    await fbUpdate(`payment_requests/${key}`, patch);
}

async function approvePayment(key, roll, plan) {
    try {
        await _approvePaymentCore(key, roll, plan, { auto: false });
        await loadAdminDashboard();
    } catch (e) {
        alert("Approve failed: " + (e && e.message ? e.message : String(e)));
    }
}

async function rejectPayment(key, roll) {
    if (!confirm("Reject this payment? The user will keep their current plan.")) return;
    try {
        await fbUpdate(`payment_requests/${key}`, { status: "rejected", reviewed_at: Date.now() });
        if (roll) await fbUpdate(`users/${roll}`, { pending_plan: null, pending_submitted_at: null });
        await loadAdminDashboard();
    } catch (e) {
        alert("Reject failed: " + (e && e.message ? e.message : String(e)));
    }
}

// ── Edit User Password ─────────────────────────────────
async function editPassword(roll, name) {
    const newPass = prompt(`Set new plaintext password for ${name} (${roll}):`);
    if (newPass === null) return; // Cancelled
    if (newPass.trim() === "") {
        alert("Password cannot be empty.");
        return;
    }

    if (confirm(`Are you sure you want to change the password for ${roll} to "${newPass.trim()}"?`)) {
        await fbUpdate(`users/${roll}`, { password: newPass.trim() });
    }
}

// ── Logout All Devices ────────────────────────────────
async function logoutAllDevices() {
    if (!confirm("Are you sure you want to clear cache and log out all users from all devices?")) return;
    try {
        await fbSet("sessions", null);
        alert("Cache cleared and all users have been logged out.");
    } catch (e) {
        alert("Failed to clear sessions: " + e.message);
    }
}
