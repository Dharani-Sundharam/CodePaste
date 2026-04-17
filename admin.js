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

// ── OCR & Admin Notification Config ───────────────────
const PAYEE_NAME      = "GOPALAKRISHNAN P";
const ADMIN_WA_PHONE  = "+919626262428";
const ADMIN_WA_APIKEY = "4667147";
const verifyingKeys   = new Set(); // prevents double-OCR on re-render

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
    document.getElementById("tabPaymentLog").style.display = tab === "log" ? "block" : "none";
    document.querySelectorAll(".admin-tab").forEach(t => t.classList.remove("active"));
    document.getElementById("tab-" + tab).classList.add("active");
    // Reload log data fresh each time the tab is visited
    if (tab === "log") fbGet("payment_requests").then(p => renderPaymentLog(p || {}));
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
    renderPaymentLog(payments ? payments : {});
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

                <!-- OCR Verification Status (auto-populated) -->
                <div class="ocr-status" id="ocrStatus_${key}">
                    <div class="ocr-verifying">
                        <div class="ocr-spinner"></div>
                        <span>Verifying payment via OCR…</span>
                    </div>
                </div>

                <div class="queue-actions" id="queueActions_${key}">
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

    // Kick off OCR verification for each card (async, non-blocking)
    pendingEntries.forEach(([key, p]) => runOcrVerification(key, p));
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

// ═══════════════════════════════════════════════════════
//  OCR PAYMENT VERIFICATION ENGINE
// ═══════════════════════════════════════════════════════

// ── Main orchestrator ─────────────────────────────────
async function runOcrVerification(key, p) {
    // Prevent re-running if already verifying this key
    if (verifyingKeys.has(key)) return;
    verifyingKeys.add(key);

    const statusEl = document.getElementById(`ocrStatus_${key}`);
    if (!statusEl) { verifyingKeys.delete(key); return; }

    try {
        // Call our Vercel serverless proxy (keeps API key server-side)
        const res = await fetch("/api/ocr", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: p.screenshot_url })
        });

        const data = await res.json();

        if (!data.success) {
            // OCR itself failed — flag for manual review
            _showOcrError(key, `OCR failed: ${data.error}`);
            verifyingKeys.delete(key);
            return;
        }

        const ocrData = _parseOcrText(data.text, p.amount);
        const reasons = [];

        // ── Check 1: Correct payee ─────────────────────
        if (!ocrData.payeeVerified)
            reasons.push(`Payee not found — expected "${PAYEE_NAME}"`);

        // ── Check 2: Amount matches ────────────────────
        if (!ocrData.amountVerified)
            reasons.push(`Amount mismatch — expected ₹${p.amount}, OCR found: ${ocrData.amount != null ? '₹' + ocrData.amount : 'none'}`);

        // ── Check 3: UTR uniqueness ────────────────────
        if (ocrData.utr) {
            const existing = await fbGet(`verified_utrs/${ocrData.utr}`);
            if (existing)
                reasons.push(`Duplicate UTR ${ocrData.utr} — already used by roll ${existing.roll}`);
        } else {
            reasons.push("No UTR / Transaction ID found in screenshot");
        }

        if (reasons.length === 0) {
            await _autoApprove(key, p, ocrData);
        } else {
            await _flagPayment(key, p, ocrData, reasons);
        }

    } catch (err) {
        _showOcrError(key, `Unexpected error: ${err.message}`);
    } finally {
        verifyingKeys.delete(key);
    }
}

// ── OCR text parser ───────────────────────────────────
function _parseOcrText(text, expectedAmount) {
    const upper = text.toUpperCase();
    const expected = parseInt(expectedAmount);
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    // Payee: case-insensitive, also tolerate OCR dropping the space
    const payeeVerified =
        upper.includes(PAYEE_NAME.toUpperCase()) ||
        upper.includes(PAYEE_NAME.replace(" ", "").toUpperCase());

    // ── Amount (3-pass) ──────────────────────────────────
    // GPay renders the rupee symbol as a separate giant glyph,
    // so OCR emits "₹" on its own line then "20" on the next line.
    let amount = null;
    let amountVerified = false;

    // Pass 1: adjacent symbol  ₹20 / Rs.20 / 20 Rs (single line)
    const adj = text.match(/(?:₹|Rs\.?\s*|INR\s*)(\d+(?:[.,]\d+)?)/i)
             || text.match(/(\d+(?:\.\d+)?)\s*(?:₹|Rs|INR)/i);
    if (adj) {
        amount = parseFloat(adj[1].replace(",", ""));
        amountVerified = Math.round(amount) === expected;
    }

    // Pass 2: multiline — currency symbol alone on line i, digits on line i+1
    if (!amountVerified) {
        for (let i = 0; i < lines.length - 1; i++) {
            if (["₹", "Rs", "INR"].includes(lines[i])) {
                const val = parseFloat(lines[i + 1].replace(/[,\s]/g, ""));
                if (!isNaN(val)) { amount = val; amountVerified = Math.round(val) === expected; break; }
            }
        }
    }

    // Pass 3: standalone exact-match line (the big display number, no symbol)
    // Only accept if the number exactly equals the expected amount
    if (!amountVerified) {
        for (const line of lines) {
            const clean = line.replace(/[₹,\s]/g, "");
            if (/^\d+(\.\d+)?$/.test(clean)) {
                const val = parseFloat(clean);
                if (Math.round(val) === expected) { amount = val; amountVerified = true; break; }
            }
        }
    }

    // ── UTR (5-pass) ─────────────────────────────────────
    // GPay: "UPI transaction ID" on line i, value "643158208486" on line i+1
    let utr = null;

    // Pass 1: same-line label:value (Paytm / PhonePe)
    const sl = text.match(/(?:UTR|UPI\s*(?:transaction\s*)?(?:Ref(?:erence)?)?\s*(?:ID|No\.?)?|Transaction\s*ID|Txn\s*ID|Ref(?:erence)?\s*(?:No\.?|ID)?|Order\s*ID)[:\s#*—-]*([A-Z0-9]{8,25})/i);
    if (sl && sl[1]) utr = sl[1].toUpperCase().replace(/\s/g, "");

    // Pass 2: label on line i, value on line i+1 (GPay style)
    if (!utr) {
        const LBL = ["UPI TRANSACTION ID", "TRANSACTION ID", "UTR", "REF NO", "ORDER ID", "REFERENCE ID"];
        for (let i = 0; i < lines.length - 1; i++) {
            const lu = lines[i].toUpperCase();
            if (LBL.some(k => lu.includes(k))) {
                const val = lines[i + 1].replace(/\s/g, "");
                if (/^[A-Z0-9]{8,25}$/i.test(val)) { utr = val.toUpperCase(); break; }
            }
        }
    }

    // Pass 3: PhonePe T-prefixed ID
    if (!utr) { const pp = text.match(/\b([T][0-9A-Z]{10,15})\b/i); if (pp) utr = pp[1].toUpperCase(); }

    // Pass 4: bare 12-digit UPI UTR number
    if (!utr) { const b12 = text.match(/\b([0-9]{12})\b/); if (b12) utr = b12[1]; }

    // Pass 5: Google transaction ID as last resort
    if (!utr) {
        for (let i = 0; i < lines.length - 1; i++) {
            if (lines[i].toUpperCase().includes("GOOGLE TRANSACTION ID")) {
                const val = lines[i + 1].replace(/\s/g, "");
                if (val.length >= 8) { utr = val.toUpperCase(); break; }
            }
        }
    }

    // ── Timestamp ────────────────────────────────────────
    // GPay: "6 Mar 2026, 2:11 pm"
    let timestamp = null;
    const tsMatch =
        text.match(/(\d{1,2}\s+\w{3,9}\s+\d{4},?\s+\d{1,2}:\d{2}\s*(?:am|pm)?)/i) ||
        text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}[\s,]+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i) ||
        text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)\s+\d{1,2}\s+\w+\s+\d{4})/i);
    if (tsMatch) timestamp = tsMatch[1].trim();

    return { payeeVerified, amount, amountVerified, utr, timestamp };
}


// ── Auto-approve path ─────────────────────────────────
async function _autoApprove(key, p, ocrData) {
    // Apply the addon to user
    await applyAddon(p.roll_number, p.requested_plan);

    // Mark as auto_approved in DB
    await fbUpdate(`payment_requests/${key}`, {
        status: "auto_approved",
        reviewed_at: Date.now(),
        ocr_utr: ocrData.utr || null,
        ocr_amount: ocrData.amount || null,
        ocr_timestamp: ocrData.timestamp || null,
        review_method: "ocr_auto"
    });

    // Store UTR to block reuse
    if (ocrData.utr) {
        await fbSet(`verified_utrs/${ocrData.utr}`, {
            roll: p.roll_number,
            plan: p.requested_plan,
            amount: parseInt(p.amount),
            verified_at: Date.now(),
            payment_key: key
        });
    }

    // Update card UI → green verified panel
    const statusEl = document.getElementById(`ocrStatus_${key}`);
    if (statusEl) {
        statusEl.innerHTML = `
            <div class="ocr-verified">
                <span class="ocr-badge verified">✅ Auto-Verified & Approved</span>
                <div class="ocr-fields">
                    <span>Payee: <strong class="ocr-pass">✓ ${PAYEE_NAME}</strong></span>
                    <span>Amount: <strong>₹${ocrData.amount || p.amount}</strong></span>
                    ${ocrData.utr ? `<span>UTR: <strong>${ocrData.utr}</strong></span>` : ""}
                    ${ocrData.timestamp ? `<span>Paid at: <strong>${ocrData.timestamp}</strong></span>` : ""}
                </div>
            </div>`;
    }

    // Hide action buttons — no manual action needed
    const actionsEl = document.getElementById(`queueActions_${key}`);
    if (actionsEl) actionsEl.style.display = "none";

    // Animate card fadeout after a moment
    setTimeout(() => {
        const card = document.getElementById(`queueCard_${key}`);
        if (card) {
            card.style.transition = "opacity 0.5s ease, transform 0.5s ease";
            card.style.opacity = "0";
            card.style.transform = "scale(0.96)";
            setTimeout(() => { card.remove(); _updateBadge(-1); }, 550);
        }
    }, 2500);

    // WhatsApp success notification
    _sendAdminWhatsApp(
        `✅ CTpaste Auto-Approved!\nRoll: ${p.roll_number}\nName: ${p.name}\nPlan: ${p.requested_plan}\nAmount: ₹${p.amount}\nUTR: ${ocrData.utr || "N/A"}\nPaid at: ${ocrData.timestamp || new Date().toLocaleString("en-IN")}\nStatus: Verified & Approved ✓`
    );
}

// ── Flag path ─────────────────────────────────────────
async function _flagPayment(key, p, ocrData, reasons) {
    // Mark as flagged in DB (stays in queue for manual review)
    await fbUpdate(`payment_requests/${key}`, {
        status: "flagged",
        flagged_at: Date.now(),
        flag_reasons: reasons,
        ocr_utr: ocrData.utr || null,
        ocr_amount: ocrData.amount || null,
        review_method: "ocr_flagged"
    });

    const statusEl = document.getElementById(`ocrStatus_${key}`);
    if (statusEl) {
        const amtClass = ocrData.amountVerified ? "ocr-pass" : "ocr-miss";
        statusEl.innerHTML = `
            <div class="ocr-flagged">
                <span class="ocr-badge flagged">⚠ Manual Review Required</span>
                <div class="ocr-fields">
                    <span class="${ocrData.payeeVerified ? "ocr-pass" : "ocr-miss"}">
                        Payee: ${ocrData.payeeVerified ? "✓ Found" : "❌ Not found"}
                    </span>
                    ${ocrData.amount != null
                        ? `<span class="${amtClass}">Amount: ₹${ocrData.amount} ${ocrData.amountVerified ? "✓" : "(expected ₹" + p.amount + ")"}</span>`
                        : `<span class="ocr-miss">Amount: ❌ Not found</span>`}
                    ${ocrData.utr
                        ? `<span>UTR: <strong>${ocrData.utr}</strong></span>`
                        : `<span class="ocr-miss">UTR: ❌ Not found</span>`}
                    ${ocrData.timestamp ? `<span>Paid at: ${ocrData.timestamp}</span>` : ""}
                </div>
                <div class="ocr-reasons">
                    ${reasons.map(r => `<div class="ocr-reason">• ${r}</div>`).join("")}
                </div>
            </div>`;
    }

    // WhatsApp alert to admin
    _sendAdminWhatsApp(
        `⚠ CTpaste Payment FLAGGED!\nRoll: ${p.roll_number}\nName: ${p.name}\nPlan: ${p.requested_plan} (₹${p.amount})\nIssues:\n${reasons.map(r => "• " + r).join("\n")}\nPlease check admin panel.`
    );
}

// ── OCR error fallback ────────────────────────────────
function _showOcrError(key, msg) {
    const statusEl = document.getElementById(`ocrStatus_${key}`);
    if (statusEl) {
        statusEl.innerHTML = `
            <div class="ocr-flagged">
                <span class="ocr-badge flagged">⚠ OCR Unavailable — Manual Review</span>
                <div style="font-size:.8rem;color:var(--text3);margin-top:4px;">${msg}</div>
            </div>`;
    }
}

// ── WhatsApp sender ───────────────────────────────────
function _sendAdminWhatsApp(plainText) {
    const encoded = encodeURIComponent(plainText);
    fetch(`https://api.callmebot.com/whatsapp.php?phone=${ADMIN_WA_PHONE}&text=${encoded}&apikey=${ADMIN_WA_APIKEY}`)
        .catch(() => {}); // fire-and-forget
}

// ── Badge updater ─────────────────────────────────────
function _updateBadge(delta) {
    const b = document.getElementById("paymentNotifBadge");
    const s = document.getElementById("statPending");
    const n = Math.max(0, parseInt(b.textContent || "0") + delta);
    if (n <= 0) b.style.display = "none";
    else { b.textContent = n; b.style.display = "inline-flex"; }
    if (s) s.textContent = Math.max(0, parseInt(s.textContent || "0") + delta);
}

// ── Payment Log renderer ──────────────────────────────
function renderPaymentLog(allPayments) {
    const logBody = document.getElementById("paymentLogBody");
    if (!logBody) return;

    const processed = Object.entries(allPayments)
        .filter(([, p]) => p.status && p.status !== "pending")
        .sort((a, b) => (b[1].reviewed_at || b[1].flagged_at || 0) - (a[1].reviewed_at || a[1].flagged_at || 0));

    if (!processed.length) {
        logBody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text3);">No processed payments yet.</td></tr>`;
        return;
    }

    const COLORS = { auto_approved: "var(--green,#3fb950)", approved: "var(--green,#3fb950)", rejected: "var(--red,#f85149)", flagged: "var(--yellow,#d29922)" };
    const LABELS = { auto_approved: "✅ Auto-Approved", approved: "✓ Approved", rejected: "✗ Rejected", flagged: "⚠ Flagged" };

    logBody.innerHTML = processed.map(([key, p]) => {
        const color = COLORS[p.status] || "var(--text3)";
        const label = LABELS[p.status] || p.status;
        const ts = (p.reviewed_at || p.flagged_at)
            ? new Date(p.reviewed_at || p.flagged_at).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })
            : "—";
        return `<tr>
            <td style="font-weight:600;font-variant-numeric:tabular-nums;">${p.roll_number || "—"}</td>
            <td>${p.name || "—"}</td>
            <td>${p.requested_plan || "—"}</td>
            <td>₹${p.amount || "—"}</td>
            <td style="font-family:monospace;font-size:.8rem;color:var(--text2);">${p.ocr_utr || "—"}</td>
            <td style="color:${color};font-weight:600;font-size:.83rem;">${label}</td>
            <td style="font-size:.8rem;color:var(--text2);">${ts}</td>
        </tr>`;
    }).join("");
}
