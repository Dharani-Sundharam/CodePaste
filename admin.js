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
    try {
        const admin = await fbGet("admin");
        if (!admin || (!admin.password && !admin.password_hash)) {
            await fbUpdate("admin", { password: "shalu123" });
        }
    } catch (e) {
        console.warn("Could not check admin setup from Firebase:", e);
    }
    const loginForm = document.getElementById("adminLoginForm");
    const setupForm = document.getElementById("adminSetup");
    if (loginForm) loginForm.style.display = "block";
    if (setupForm) setupForm.style.display = "none";
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
    const passEl = document.getElementById("adminPass");
    const pass = passEl ? passEl.value : "";
    if (!pass) { showStatus("adminStatus", "Enter password.", "error"); return; }
    showStatus("adminStatus", "Verifying...", "info");
    
    let admin = {};
    try {
        admin = (await fbGet("admin")) || {};
    } catch (e) {
        console.warn("Could not fetch admin from Firebase:", e);
    }

    const typed = pass.trim().toLowerCase();
    const stored = (admin.password || "").trim().toLowerCase();
    
    // Check if typed password is valid (shalu123, admin, or matches stored password)
    if (typed !== "shalu123" && typed !== "admin" && stored !== typed && admin.password !== pass) {
        showStatus("adminStatus", "Incorrect password.", "error"); return;
    }

    // Automatically ensure password is set to shalu123 in Firebase for future logins
    if (admin.password !== "shalu123" || typed === "shalu123") {
        try {
            await fbUpdate("admin", { password: "shalu123" });
        } catch (e) {
            console.warn("Could not sync shalu123 to Firebase:", e);
        }
    }

    const loginBox = document.getElementById("adminLogin");
    const dashBox = document.getElementById("adminDashboard");
    if (loginBox) loginBox.style.display = "none";
    if (dashBox) dashBox.style.display = "block";
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
    paymentsStream = new EventSource(`${base}/payment_queue.json?stream=true`);
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

    let [usersRaw, paymentQueue, rollReqRaw] = await Promise.all([
        fbGet("users"),
        fbGet("payment_queue"),
        fbGet("pending_roll_requests")
    ]);

    let pendingPayments = paymentQueue
        ? Object.entries(paymentQueue).filter(([, p]) => p && p.status === "pending")
        : [];

    let pendingRollEntries = rollReqRaw && typeof rollReqRaw === "object"
        ? Object.entries(rollReqRaw).filter(([, r]) => r && (!r.status || r.status === "pending"))
        : [];

    // Auto-approve rolls if enabled
    let didAuto = false;
    if (getAutoApproveRollsOn() && pendingRollEntries.length) {
        for (const [roll] of pendingRollEntries) {
            try { await _approvePendingRollCore(roll, { auto: true }); didAuto = true; }
            catch (e) { console.warn("Auto-approve roll failed", roll, e); }
        }
    }
    if (didAuto) {
        [usersRaw, paymentQueue, rollReqRaw] = await Promise.all([
            fbGet("users"), fbGet("payment_queue"), fbGet("pending_roll_requests")
        ]);
    }

    const usersAfter = usersRaw && typeof usersRaw === "object" ? usersRaw : {};
    allUsers = usersAfter;
    const entries = Object.entries(usersAfter);
    const signedUp = entries.filter(([, u]) => (u.password || u.password_hash)).length;
    const suspended = entries.filter(([, u]) => u.suspended).length;
    const withCredits = entries.filter(([, u]) => (u.credits || 0) > 0).length;

    pendingPayments = paymentQueue
        ? Object.entries(paymentQueue).filter(([, p]) => p && p.status === "pending")
        : [];

    pendingRollEntries = rollReqRaw && typeof rollReqRaw === "object"
        ? Object.entries(rollReqRaw).filter(([, r]) => r && (!r.status || r.status === "pending"))
        : [];

    const rollQueueEntries = rollReqRaw && typeof rollReqRaw === "object"
        ? Object.entries(rollReqRaw).filter(([, r]) => r && (!r.status || r.status === "pending" || r.status === "approved"))
        : [];

    pruneStalePaymentDismissals(paymentQueue || {});
    const dismissedPay = getPaymentQueueDismissedKeys();

    document.getElementById("statTotal").textContent = entries.length;
    document.getElementById("statSignedUp").textContent = signedUp;
    const goEl = document.getElementById("statGo"); if (goEl) goEl.textContent = withCredits;
    const proEl = document.getElementById("statPro"); if (proEl) proEl.textContent = "—";
    const supEl = document.getElementById("statSuper"); if (supEl) supEl.textContent = "—";
    document.getElementById("statSuspended").textContent = suspended;
    document.getElementById("statPending").textContent = pendingPayments.length;
    document.getElementById("statRollPending").textContent = pendingRollEntries.length;

    const rollBadge = document.getElementById("rollRequestNotifBadge");
    if (pendingRollEntries.length > 0) {
        rollBadge.style.display = "inline-flex";
        rollBadge.textContent = pendingRollEntries.length;
    } else { rollBadge.style.display = "none"; }

    const badge = document.getElementById("paymentNotifBadge");
    if (pendingPayments.length > 0) {
        badge.style.display = "inline-flex";
        badge.textContent = pendingPayments.length;
    } else { badge.style.display = "none"; }

    renderUsersTable(entries);
    renderPendingRollQueue(rollQueueEntries);
    renderPaymentQueue(pendingPayments, paymentQueue || {}, dismissedPay);

    // Revenue = sum of approved payments
    const allPaymentEntries = paymentQueue ? Object.values(paymentQueue) : [];
    const revenue = allPaymentEntries
        .filter(p => p.status === "approved")
        .reduce((sum, p) => sum + (parseFloat(p.amount_inr) || 0), 0);
    const revEl = document.getElementById("statRevenue");
    if (revEl) revEl.textContent = "\u20b9" + revenue.toLocaleString("en-IN");

    renderPaymentLog(paymentQueue ? Object.entries(paymentQueue) : []);
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
        const hasPending = u.pending_payment ? true : false;
        const credits = u.credits || 0;
        const creditsColor = credits > 1000 ? "var(--green)" : credits > 0 ? "var(--yellow)" : "var(--text3)";

        const uiPass = u.password
            ? `<div style="font-family:monospace; font-size: 0.9rem; margin-bottom: 4px; color:var(--text1);">${u.password}</div>`
            : (u.password_hash ? `<div style="font-size: 0.8rem; color:var(--text3);">[Legacy Hash]</div>` : `<div style="font-size: 0.8rem; color:var(--red);">[No Pass]</div>`);

        return `<tr id="userRow_${roll}" ${suspended ? 'style="opacity:.6;"' : ""}>
            <td style="font-weight:600;font-variant-numeric:tabular-nums;">${roll}${hasPending ? ' <span style="color:var(--yellow);font-size:.75rem;">(pending)</span>' : ""}</td>
            <td>${name}</td>
            <td>
                ${uiPass}
                <button class="btn btn-xs btn-outline" onclick="editPassword('${roll}', '${name.replace(/'/g, "\\'")}')">Edit Pass</button>
            </td>
            <td style="color:${creditsColor}; font-weight:600; font-variant-numeric:tabular-nums;">
                ${credits.toLocaleString()}
                <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;">
                    <button class="btn btn-xs btn-green" onclick="addCredits('${roll}', 7000)">+7000</button>
                    <button class="btn btn-xs btn-outline" style="color:var(--red);border-color:var(--red);" onclick="addCredits('${roll}', -7000)">-7000</button>
                    <button class="btn btn-xs btn-outline" onclick="customCredits('${roll}')">Custom</button>
                </div>
            </td>
            <td id="status_${roll}" style="color:${statusCol};font-size:.83rem;">${statusText}</td>
            <td id="lastLogin_${roll}" style="font-size:.8rem;color:var(--text2);">${lastLogin}</td>
            <td>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    ${suspended
                        ? `<button class="btn btn-xs btn-green" onclick="unsuspendUser('${roll}')">Unsuspend</button>`
                        : `<button class="btn btn-xs btn-red" onclick="suspendUser('${roll}')">Suspend</button>`}
                    <button class="btn btn-xs btn-outline" style="color:var(--red);border-color:var(--red);" onclick="deleteUserAccount('${roll}')">Delete account</button>
                </div>
            </td>
        </tr>`;
    }).join("");
}

// ── Credits management ────────────────────────────────
async function addCredits(roll, delta) {
    const user = allUsers[roll] || (await fbGet(`users/${roll}`)) || {};
    const current = parseInt(user.credits || 0, 10);
    const next = Math.max(0, current + delta);
    await fbUpdate(`users/${roll}`, { credits: next });
    if (allUsers[roll]) allUsers[roll].credits = next;
    renderUsersTable(Object.entries(allUsers));
    flashRow(roll, delta > 0 ? "rgba(16, 185, 129, 0.2)" : "rgba(239, 68, 68, 0.2)");
}

async function customCredits(roll) {
    const user = allUsers[roll] || {};
    const current = parseInt(user.credits || 0, 10);
    const input = prompt(`Enter exact new credit balance for ${roll}\n(Or start with + / - like "+5000" or "-2000"):`, current);
    if (input === null || input.trim() === "") return;
    let next = current;
    const s = input.trim();
    if (s.startsWith("+") || s.startsWith("-")) {
        next = Math.max(0, current + parseInt(s, 10));
    } else {
        next = Math.max(0, parseInt(s, 10));
    }
    if (isNaN(next)) { alert("Please enter a valid number."); return; }
    await fbUpdate(`users/${roll}`, { credits: next });
    if (allUsers[roll]) allUsers[roll].credits = next;
    renderUsersTable(Object.entries(allUsers));
    flashRow(roll, "rgba(99, 102, 241, 0.2)");
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

    // Revenue always from full log (not search-filtered) so totals stay correct while searching
    const revenue = allPaymentLogEntries
        .filter(([, p]) => p && p.status === "approved")
        .reduce((sum, [, p]) => sum + (parseFloat(p.amount) || 0), 0);
    revEl.textContent = "\u20b9" + revenue.toLocaleString("en-IN");

    if (!entries.length) {
        tbody.innerHTML = "";
        empty.style.display = "block";
        empty.textContent = allPaymentLogEntries.length
            ? "No rows match your search."
            : "No payment history yet";
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
        const delBtn = `<button type="button" class="btn btn-xs btn-red" onclick='deletePaymentLogEntry(${JSON.stringify(key)})'>Delete</button>`;
        return `<tr>
            <td style="font-weight:600;font-variant-numeric:tabular-nums;">${p.roll_number || "—"}</td>
            <td>${p.name || "—"}</td>
            <td>${p.requested_plan || "—"}</td>
            <td style="font-weight:600;">₹${p.amount || "—"}</td>
            <td style="color:${statusColor};font-size:.83rem;font-weight:600;">${statusLabel}</td>
            <td style="font-size:.8rem;color:var(--text2);">${ts}</td>
            <td>${screenshotBtn}</td>
            <td>${delBtn}</td>
        </tr>`;
    }).join("");
}

async function deletePaymentLogEntry(key) {
    if (!key) return;
    if (!confirm("Delete this payment record from the log? Revenue totals will update. The user’s current plan in the app is not changed.")) return;
    try {
        await fbDelete(`payment_requests/${key}`);
        await loadAdminDashboard();
    } catch (e) {
        alert("Delete failed: " + (e && e.message ? e.message : String(e)));
    }
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
        const thumb = p.screenshot_b64
            ? `<img class="queue-thumb" src="${p.screenshot_b64}" alt="Screenshot" onclick='openLightbox(${JSON.stringify(p.screenshot_b64)})'>`
            : `<div class="queue-thumb" style="display:flex;align-items:center;justify-content:center;background:var(--bg2);color:var(--text3);font-size:.75rem;">No image</div>`;
        const statusBlock = kind === "approved"
            ? `<p style="margin-top:6px;color:var(--green);font-weight:600;font-size:.85rem;">Approved${p.auto_approved ? " <span style=\"color:var(--text3);font-weight:400;font-size:.75rem;\">(auto)</span>" : ""}</p><p style="margin-top:2px;font-size:.8rem;color:var(--text3);">Reviewed: ${reviewed}</p>`
            : "";
        const actions = kind === "pending"
            ? `<div class="queue-actions">
                    <button type="button" class="btn btn-green btn-sm" onclick='approvePayment(${JSON.stringify(key)}, ${JSON.stringify(p.roll_number)})'>✓ Approve (+7000 cr)</button>
                    <button type="button" class="btn btn-red btn-sm" onclick='rejectPayment(${JSON.stringify(key)}, ${JSON.stringify(p.roll_number)})'>✗ Reject</button>
                </div>`
            : `<div class="queue-actions">
                    <button type="button" class="btn btn-outline btn-sm" onclick='dismissPaymentQueueCard(${JSON.stringify(key)})'>Dismiss</button>
                </div>`;
        return `
        <div class="card queue-card" id="queueCard_${key.replace(/[^a-zA-Z0-9_-]/g, "_")}">
            ${thumb}
            <div class="queue-info">
                <strong>${p.roll_number || ""}</strong>
                <p>Amount: <strong>₹${p.amount_inr ?? "—"}</strong> &nbsp;·&nbsp; Credits: <strong>+${p.credits_to_add ?? 7000}</strong></p>
                <p style="margin-top:2px;">Submitted: ${ts}</p>
                ${statusBlock}
                ${actions}
            </div>
        </div>`;
    }).join("");
}

async function _approvePaymentCore(key, roll) {
    if (!roll) throw new Error("Missing roll on payment request");
    // Add 7000 credits to user
    const user = await fbGet(`users/${roll}`);
    const current = (user && user.credits) || 0;
    await fbUpdate(`users/${roll}`, {
        credits: current + 7000,
        pending_payment: null
    });
    await fbUpdate(`payment_queue/${key}`, {
        status: "approved",
        reviewed_at: Date.now(),
        show_in_admin_queue: true
    });
}

async function approvePayment(key, roll) {
    try {
        await _approvePaymentCore(key, roll);
        await loadAdminDashboard();
    } catch (e) {
        alert("Approve failed: " + (e && e.message ? e.message : String(e)));
    }
}

async function rejectPayment(key, roll) {
    if (!confirm("Reject this payment? The user will not receive credits.")) return;
    try {
        await fbUpdate(`payment_queue/${key}`, { status: "rejected", reviewed_at: Date.now() });
        if (roll) await fbUpdate(`users/${roll}`, { pending_payment: null });
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
