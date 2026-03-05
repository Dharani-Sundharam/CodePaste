/* ═══════════════════════════════════════════════════════
   CTpaste — admin.js  v2
   Admin panel: users, suspend, payment queue approval
   ═══════════════════════════════════════════════════════ */

let allUsers = {};
let currentTab = "users";

// ── Check first-time setup ─────────────────────────────
async function checkAdminSetup() {
    const admin = await fbGet("admin");
    if (!admin || !admin.password_hash) {
        document.getElementById("adminLoginForm").style.display = "none";
        document.getElementById("adminSetup").style.display = "block";
    }
}

async function setupAdminPassword() {
    const pass = document.getElementById("adminNewPass").value;
    const confirm = document.getElementById("adminNewPassConfirm").value;
    if (pass.length < 4) { showStatus("adminStatus", "Min 4 characters.", "error"); return; }
    if (pass !== confirm) { showStatus("adminStatus", "Passwords don't match.", "error"); return; }
    const hash = await hashPassword(pass);
    await fbUpdate("admin", { password_hash: hash });
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
    const hash = await hashPassword(pass);
    const admin = await fbGet("admin");
    if (!admin || admin.password_hash !== hash) {
        showStatus("adminStatus", "Incorrect password.", "error"); return;
    }
    localStorage.setItem("CTpaste_admin", "true");
    document.getElementById("adminLogin").style.display = "none";
    document.getElementById("adminDashboard").style.display = "block";
    loadAdminDashboard();

    // Start real-time background updates for user statuses
    if (!window.statusInterval) {
        window.statusInterval = setInterval(updateOnlineStatus, 8000);
    }
}

function adminLogout() {
    localStorage.removeItem("CTpaste_admin");
    window.location.reload();
}

// ── Tab switching ──────────────────────────────────────
function switchTab(tab) {
    currentTab = tab;
    document.getElementById("tabUsers").style.display = tab === "users" ? "block" : "none";
    document.getElementById("tabPayments").style.display = tab === "payments" ? "block" : "none";
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
    const signedUp = entries.filter(([, u]) => u.password_hash).length;
    const goCount = entries.filter(([, u]) => !u.plan || u.plan === "GO").length;
    const proCount = entries.filter(([, u]) => u.plan && u.plan.startsWith("PRO")).length;
    const superCount = entries.filter(([, u]) => u.plan === "SUPER").length;
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
}

// ── Dynamic Online Status Update ───────────────────────
async function updateOnlineStatus() {
    if (currentTab !== "users") return;
    const users = await fbGet("users");
    if (!users) return;

    allUsers = users;
    const entries = Object.entries(users);

    // Update stats text quietly
    document.getElementById("statTotal").textContent = entries.length;
    document.getElementById("statSignedUp").textContent = entries.filter(([, u]) => u.password_hash).length;
    document.getElementById("statGo").textContent = entries.filter(([, u]) => !u.active_addons || (!u.active_addons.speed_boost && !u.active_addons.extra_hours_added && !u.active_addons.super_pass)).length;
    document.getElementById("statPro").textContent = entries.filter(([, u]) => u.active_addons && (u.active_addons.speed_boost || u.active_addons.extra_hours_added)).length;
    document.getElementById("statSuper").textContent = entries.filter(([, u]) => u.active_addons && u.active_addons.super_pass).length;
    document.getElementById("statSuspended").textContent = entries.filter(([, u]) => u.suspended).length;

    // Update row texts selectively
    entries.forEach(([roll, u]) => {
        const row = document.getElementById(`userRow_${roll}`);
        if (!row) {
            renderUsersTable(entries); // A new user signed up, rebuild full table
            return;
        }

        const isOnline = u.last_active && (Date.now() - u.last_active < 45000); // 45 sec threshold
        const suspended = u.suspended ? true : false;
        const statusText = suspended ? "Suspended" : (isOnline ? "Online 🟢" : (u.password_hash ? "Offline ⭕" : "Not Registered"));
        const statusCol = suspended ? "var(--red)" : (isOnline ? "var(--green)" : "var(--text3)");
        const lastLogin = u.last_login ? new Date(u.last_login).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }) : "—";

        const statusTd = document.getElementById(`status_${roll}`);
        const loginTd = document.getElementById(`lastLogin_${roll}`);
        if (statusTd) {
            statusTd.innerHTML = statusText;
            statusTd.style.color = statusCol;
        }
        if (loginTd) {
            loginTd.innerHTML = lastLogin;
        }
    });
}

// ── Render users table ─────────────────────────────────
function renderUsersTable(entries) {
    const tbody = document.getElementById("usersTable");
    if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text3);">No users</td></tr>';
        return;
    }
    tbody.innerHTML = entries.map(([roll, u]) => {
        const name = u.name || "—";
        const suspended = u.suspended ? true : false;
        const isOnline = u.last_active && (Date.now() - u.last_active < 45000);
        const lastLogin = u.last_login ? new Date(u.last_login).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }) : "—";
        const statusText = suspended ? "Suspended" : (isOnline ? "Online 🟢" : (u.password_hash ? "Offline ⭕" : "Not Registered"));
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
        if (parts.length > 0) addonsText = parts.join(" | ");

        return `<tr id="userRow_${roll}" ${suspended ? 'style="opacity:.6;"' : ""}>
            <td style="font-weight:600;font-variant-numeric:tabular-nums;">${roll}${hasPending ? ' <span style="color:var(--yellow);font-size:.75rem;">(pending)</span>' : ""}</td>
            <td>${name}</td>
            <td>
                <div style="font-size: .85rem; margin-bottom: 4px; color: var(--text1);">${addonsText}</div>
                <select onchange="applyAddon('${roll}', this.value); this.selectedIndex=0;" style="${suspended ? 'pointer-events:none;opacity:.4;' : ''}; font-size:.8rem; padding: 2px 4px;">
                    <option value="" disabled selected>Give Add-On...</option>
                    <option value="PRO_SPEED">+ SPEED Boost</option>
                    <option value="PRO_HOUR">+ 1 HOUR</option>
                    <option value="PRO_BOTH">+ Both (Speed + Hour)</option>
                    <option value="SUPER">SUPER Pass</option>
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
    } else if (addonAction === "PRO_SPEED") {
        active_addons.speed_boost = true;
    } else if (addonAction === "PRO_HOUR") {
        active_addons.extra_hours_added = (active_addons.extra_hours_added || 0) + 1;
    } else if (addonAction === "PRO_BOTH") {
        active_addons.speed_boost = true;
        active_addons.extra_hours_added = (active_addons.extra_hours_added || 0) + 1;
    } else if (addonAction === "SUPER") {
        active_addons.super_pass = true;
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
    // We recreate stats by recounting active addons instead of plan plan keys
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
