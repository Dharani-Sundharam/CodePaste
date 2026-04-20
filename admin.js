/* ═══════════════════════════════════════════════════════
   CTpaste — admin.js  v3
   Admin panel: users, suspend, payment queue approval
   + Session persistence across refresh
   + Real-time Firebase SSE listeners (no more polling)
   ═══════════════════════════════════════════════════════ */

let allUsers = {};
let currentTab = "users";

// SSE streams
let usersStream = null;
let paymentsStream = null;

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

function stopRealTimeListeners() {
    if (usersStream) { usersStream.close(); usersStream = null; }
    if (paymentsStream) { paymentsStream.close(); paymentsStream = null; }
    // Hide live indicator
    const liveEl = document.getElementById("liveIndicator");
    if (liveEl) liveEl.style.display = "none";
}

// ── Tab switching ──────────────────────────────────────
function switchTab(tab) {
    currentTab = tab;
    document.getElementById("tabUsers").style.display = tab === "users" ? "block" : "none";
    document.getElementById("tabPayments").style.display = tab === "payments" ? "block" : "none";
    document.getElementById("tabPaylog").style.display = tab === "paylog" ? "block" : "none";
    document.querySelectorAll(".admin-tab").forEach(t => t.classList.remove("active"));
    document.getElementById("tab-" + tab).classList.add("active");
}

// ── Load Dashboard ─────────────────────────────────────
async function loadAdminDashboard() {
    const [users, payments] = await Promise.all([
        fbGet("users"),
        fbGet("payment_requests")
    ]);
    if (!users) return;

    allUsers = users;
    const entries = Object.entries(users);
    const signedUp = entries.filter(([, u]) => (u.password || u.password_hash)).length;
    const superCount = entries.filter(([, u]) => u.active_addons && u.active_addons.super_pass).length;
    const proCount = entries.filter(([, u]) => u.active_addons && !u.active_addons.super_pass && (u.active_addons.speed_boost || u.active_addons.extra_hours_added)).length;
    const goCount = entries.filter(([, u]) => !u.active_addons || (!u.active_addons.speed_boost && !u.active_addons.extra_hours_added && !u.active_addons.super_pass)).length;
    const suspended = entries.filter(([, u]) => u.suspended).length;

    const pendingPayments = payments
        ? Object.entries(payments).filter(([, p]) => p.status === "pending")
        : [];

    document.getElementById("statTotal").textContent = entries.length;
    document.getElementById("statSignedUp").textContent = signedUp;
    document.getElementById("statGo").textContent = goCount;
    document.getElementById("statPro").textContent = proCount;
    document.getElementById("statSuper").textContent = superCount;
    document.getElementById("statSuspended").textContent = suspended;
    document.getElementById("statPending").textContent = pendingPayments.length;

    // Payment badge
    const badge = document.getElementById("paymentNotifBadge");
    if (pendingPayments.length > 0) {
        badge.style.display = "inline-flex";
        badge.textContent = pendingPayments.length;
    } else {
        badge.style.display = "none";
    }

    renderUsersTable(entries);
    renderPaymentQueue(pendingPayments, payments ? payments : {});

    // Revenue = sum of approved payment amounts
    const allPaymentEntries = payments ? Object.values(payments) : [];
    const revenue = allPaymentEntries
        .filter(p => p.status === "approved")
        .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    document.getElementById("statRevenue").textContent = "\u20b9" + revenue.toLocaleString("en-IN");

    renderPaymentLog(payments ? Object.entries(payments) : []);
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
        let addonsText = "GO (Base)";
        let parts = [];
        if (addons.super_pass) parts.push("SUPER Pass (+Medium Speed, 3Hrs)");
        else {
            if (addons.speed_boost) parts.push("Fast Speed");
            if (addons.extra_hours_added) parts.push(`+${addons.extra_hours_added} Hrs`);
        }

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
                    <option value="PRO_SPEED">+ SPEED Boost</option>
                    <option value="SYNC_APP">+ Phone Sync (7-Day)</option>
                    <option value="PRO_HOUR">+ 1 HOUR</option>
                    <option value="PRO_BOTH">+ Both (Speed + Hour)</option>
                    <option value="SUPER">SUPER Pass</option>
                    <option value="AI_ADDON">⚡ AI Addon (Expires EOD)</option>
                    <option value="RESET">Reset to GO</option>
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
    } else if (addonAction === "PRO_SPEED") {
        active_addons.speed_boost = true;
    } else if (addonAction === "SYNC_APP") {
        active_addons.sync_app_expiry = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 days from now
    } else if (addonAction === "PRO_HOUR") {
        active_addons.extra_hours_added = (active_addons.extra_hours_added || 0) + 1;
    } else if (addonAction === "PRO_BOTH") {
        active_addons.speed_boost = true;
        active_addons.extra_hours_added = (active_addons.extra_hours_added || 0) + 1;
    } else if (addonAction === "SUPER") {
        active_addons.super_pass = true;
    } else if (addonAction === "AI_ADDON") {
        // Expires at end-of-day (midnight IST = UTC+5:30)
        const now = new Date();
        // Set to 23:59:59.999 in IST by working with UTC offset
        const istOffsetMs = 5.5 * 60 * 60 * 1000;
        const istNow = new Date(now.getTime() + istOffsetMs);
        const istMidnight = new Date(istNow);
        istMidnight.setUTCHours(23, 59, 59, 999);
        // Convert back to UTC ms for storing
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
function renderPaymentQueue(pendingEntries, allPayments) {
    const list = document.getElementById("paymentQueueList");
    const empty = document.getElementById("paymentQueueEmpty");

    if (!pendingEntries.length) {
        list.innerHTML = "";
        empty.style.display = "block";
        return;
    }
    empty.style.display = "none";

    // Sort newest first
    pendingEntries.sort((a, b) => (b[1].submitted_at || 0) - (a[1].submitted_at || 0));

    list.innerHTML = pendingEntries.map(([key, p]) => {
        const ts = p.submitted_at ? new Date(p.submitted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";
        return `
        <div class="card queue-card" id="queueCard_${key}">
            <img class="queue-thumb" src="${p.screenshot_url}" alt="Screenshot" onclick="openLightbox('${p.screenshot_url}')">
            <div class="queue-info">
                <strong>${p.roll_number || ""}</strong> — ${p.name || ""}
                <p>Requested: <strong>${p.requested_plan}</strong> &nbsp;·&nbsp; ₹${p.amount}</p>
                <p style="margin-top:2px;">Submitted: ${ts}</p>
                <div class="queue-actions">
                    <button class="btn btn-green btn-sm" onclick="approvePayment('${key}', '${p.roll_number}', '${p.requested_plan}')">
                        ✓ Approve
                    </button>
                    <button class="btn btn-red btn-sm" onclick="rejectPayment('${key}', '${p.roll_number}')">
                        ✗ Reject
                    </button>
                    <a href="${p.screenshot_url}" target="_blank" class="btn btn-outline btn-sm">Full Image</a>
                </div>
            </div>
        </div>`;
    }).join("");
}

async function approvePayment(key, roll, plan) {
    // Automatically apply the addon logic
    await applyAddon(roll, plan);

    // Mark payment as approved
    await fbUpdate(`payment_requests/${key}`, { status: "approved", reviewed_at: Date.now() });

    // Remove card with animation
    const card = document.getElementById(`queueCard_${key}`);
    if (card) { card.style.opacity = "0"; card.style.transition = "opacity .3s"; setTimeout(() => card.remove(), 350); }

    // Update stats
    document.getElementById("statPro").textContent = Object.values(allUsers).filter(u => u.active_addons && (u.active_addons.speed_boost || u.active_addons.extra_hours_added)).length;
    document.getElementById("statSuper").textContent = Object.values(allUsers).filter(u => u.active_addons && u.active_addons.super_pass).length;

    // Decrease badge
    const b = document.getElementById("paymentNotifBadge");
    const n = parseInt(b.textContent) - 1;
    if (n <= 0) b.style.display = "none"; else b.textContent = n;
    document.getElementById("statPending").textContent = Math.max(0, n);
}

async function rejectPayment(key, roll) {
    if (!confirm("Reject this payment? The user will keep their current plan.")) return;
    await fbUpdate(`payment_requests/${key}`, { status: "rejected", reviewed_at: Date.now() });
    await fbUpdate(`users/${roll}`, { pending_plan: null, pending_submitted_at: null });

    const card = document.getElementById(`queueCard_${key}`);
    if (card) { card.style.opacity = "0"; card.style.transition = "opacity .3s"; setTimeout(() => card.remove(), 350); }

    const b = document.getElementById("paymentNotifBadge");
    const n = parseInt(b.textContent) - 1;
    if (n <= 0) b.style.display = "none"; else b.textContent = n;
    document.getElementById("statPending").textContent = Math.max(0, n);
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
