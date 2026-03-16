/* ═══════════════════════════════════════════════════════
   CTpaste — app.js  v2
   Auth · Sessions · Payment · Firebase helpers
   ═══════════════════════════════════════════════════════ */

const FIREBASE_CONFIG = {
    apiKey: "AIzaSyDCwXGlANMZKKcGZudG8r7M72Uz-jNknkI",
    projectId: "codepaste-sync",
    databaseURL: "https://codepaste-sync-default-rtdb.asia-southeast1.firebasedatabase.app",
    storageBucket: "codepaste-sync.firebasestorage.app"
};

const DB_URL = FIREBASE_CONFIG.databaseURL;
const API_KEY = FIREBASE_CONFIG.apiKey;
const BUCKET = FIREBASE_CONFIG.storageBucket;

// ── Plan configs ─────────────────────────────────────
const PLAN_CONFIG = {
    "GO": { speed: "Slow", sessionHrs: 1, cooldownHrs: 3, label: "GO (Free)" },
    "PRO_SPEED": { speed: "Fast", sessionHrs: 1, cooldownHrs: 3, label: "PRO Speed" },
    "PRO_HOUR": { speed: "Slow", sessionHrs: 2, cooldownHrs: 3, label: "PRO Hour" },
    "PRO_BOTH": { speed: "Fast", sessionHrs: 2, cooldownHrs: 3, label: "PRO (Speed+Hour)" },
    "SUPER": { speed: "Medium", sessionHrs: 3, cooldownHrs: 3, label: "SUPER" }
};



// ── Firebase REST helpers ─────────────────────────────
async function fbGet(path) {
    const r = await fetch(`${DB_URL}/${path}.json`);
    return r.json();
}
async function fbSet(path, data) {
    await fetch(`${DB_URL}/${path}.json`, {
        method: "PUT", body: JSON.stringify(data),
        headers: { "Content-Type": "application/json" }
    });
}
async function fbUpdate(path, data) {
    await fetch(`${DB_URL}/${path}.json`, {
        method: "PATCH", body: JSON.stringify(data),
        headers: { "Content-Type": "application/json" }
    });
}
async function fbDelete(path) {
    await fetch(`${DB_URL}/${path}.json`, { method: "DELETE" });
}


// ── Local auth state ──────────────────────────────────
function getLoggedInUser() {
    const d = localStorage.getItem("CTpaste_user");
    return d ? JSON.parse(d) : null;
}
function setLoggedInUser(rollNumber, name, plan) {
    localStorage.setItem("CTpaste_user", JSON.stringify({ rollNumber, name, plan }));
}
function logout() {
    localStorage.removeItem("CTpaste_user");
    window.location.href = "auth.html";
}

// ── UI helpers ────────────────────────────────────────
function showStatus(id, msg, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = "status-msg " + type;
    el.textContent = msg;
}
function clearStatus(id) {
    const el = document.getElementById(id);
    if (el) { el.className = "status-msg"; el.textContent = ""; }
}

// ══════════════════════════════════════════════════════
// AUTH PAGE
// ══════════════════════════════════════════════════════
let currentRoll = "";

async function checkRollNumber() {
    const roll = document.getElementById("rollNumber").value.trim();
    if (!roll) { showStatus("statusMsg", "Please enter a roll number.", "error"); return; }
    clearStatus("statusMsg");
    showStatus("statusMsg", "Checking...", "info");

    const user = await fbGet(`users/${roll}`);
    clearStatus("statusMsg");

    if (!user) { showStatus("statusMsg", "Roll number not found. Contact admin.", "error"); return; }

    if (user.suspended) {
        showStatus("statusMsg", "This account has been suspended. Contact admin.", "error");
        return;
    }

    currentRoll = roll;
    if (!user.password && !user.password_hash) {
        document.getElementById("stepRoll").style.display = "none";
        document.getElementById("stepSignup").style.display = "block";
        document.getElementById("signupName").closest(".form-group").style.display = "block";
        document.getElementById("stepSignup").querySelector("p.auth-sub").textContent = "First time here? Set up your name and password to get started.";
    } else {
        document.getElementById("stepRoll").style.display = "none";
        document.getElementById("stepLogin").style.display = "block";
        document.getElementById("loginName").textContent = user.name || roll;
    }
}

async function signupUser() {
    let name = document.getElementById("signupName").value.trim();
    const pass = document.getElementById("signupPassword").value;
    const confirm = document.getElementById("signupConfirm").value;

    const isReset = document.getElementById("signupName").closest(".form-group").style.display === "none";

    if (!isReset && !name) { showStatus("statusMsg", "Enter your name.", "error"); return; }
    if (pass.length < 4) { showStatus("statusMsg", "Password must be at least 4 chars.", "error"); return; }
    if (pass !== confirm) { showStatus("statusMsg", "Passwords do not match.", "error"); return; }

    showStatus("statusMsg", isReset ? "Resetting password..." : "Creating account...", "info");

    if (isReset) {
        const u = await fbGet(`users/${currentRoll}`);
        name = (u && u.name) ? u.name : currentRoll;
    }

    await fbUpdate(`users/${currentRoll}`, { password: pass, name, last_login: Date.now() });

    // Verify the write actually landed before proceeding
    const check = await fbGet(`users/${currentRoll}`);
    if (!check || check.password !== pass) {
        showStatus("statusMsg", "Could not save account — check your internet and try again.", "error");
        return;
    }

    setLoggedInUser(currentRoll, name, "GO");
    showStatus("statusMsg", isReset ? "Password reset successful! Redirecting..." : "Account created! Redirecting...", "success");
    setTimeout(() => { window.location.href = "dashboard.html"; }, 900);
}

async function loginUser() {
    const pass = document.getElementById("loginPassword").value;
    if (!pass) { showStatus("statusMsg", "Enter your password.", "error"); return; }
    showStatus("statusMsg", "Verifying...", "info");

    let user;
    try {
        user = await fbGet(`users/${currentRoll}`);
    } catch (e) {
        showStatus("statusMsg", "Network error — check your connection and try again.", "error"); return;
    }

    if (!user) {
        showStatus("statusMsg", "Account not found. Try again.", "error"); return;
    }

    // Support legacy hashed users migrating to plaintext
    let expectedHash = null;
    try {
        if (window.crypto && crypto.subtle) {
            const data = new TextEncoder().encode(pass + "__CTpaste_salt__");
            const buf = await crypto.subtle.digest("SHA-256", data);
            expectedHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
        }
    } catch (e) { console.warn("Legacy hash generation skipped due to browser limits."); }

    if (!user.password && !user.password_hash) {
        showStatus("statusMsg", "Account not fully set up — please sign up again.", "error"); return;
    }

    if (user.password !== pass && user.password_hash !== expectedHash) {
        showStatus("statusMsg", "Incorrect password. Please try again.", "error"); return;
    }

    // Upgrade seamlessly if they matched legacy hash
    if (!user.password && user.password_hash === expectedHash) {
        await fbUpdate(`users/${currentRoll}`, { password: pass });
    }

    if (user.suspended) {
        showStatus("statusMsg", "Account suspended. Contact admin.", "error"); return;
    }

    await fbUpdate(`users/${currentRoll}`, { last_login: Date.now() });
    setLoggedInUser(currentRoll, user.name, user.plan || "GO");
    showStatus("statusMsg", "Login successful! Redirecting...", "success");
    setTimeout(() => { window.location.href = "dashboard.html"; }, 700);
}

function goBack() {
    document.getElementById("stepRoll").style.display = "block";
    document.getElementById("stepLogin").style.display = "none";
    document.getElementById("stepSignup").style.display = "none";
    clearStatus("statusMsg");
    currentRoll = "";
}

function resetPassword() {
    // Show the signup form so the user can overwrite their stored hash
    document.getElementById("stepLogin").style.display = "none";
    document.getElementById("stepSignup").style.display = "block";
    document.getElementById("signupName").closest(".form-group").style.display = "none";
    document.getElementById("stepSignup").querySelector("p.auth-sub").textContent =
        "Reset your password. Your new password will be saved instantly.";
    clearStatus("statusMsg");
}

// ══════════════════════════════════════════════════════
// DASHBOARD PAGE
// ══════════════════════════════════════════════════════
let sessionTimer = null;

async function loadDashboard(user) {
    const userData = await fbGet(`users/${user.rollNumber}`);
    if (!userData) { logout(); return; }

    // Suspended check
    if (userData.suspended) {
        document.getElementById("suspendedNotice").style.display = "block";
        document.getElementById("suspendedNotice").className = "status-msg error";
        document.getElementById("suspendedNotice").style.display = "block";
        document.getElementById("paymentSection").style.display = "none";
        document.getElementById("startSessionBtn") && (document.getElementById("startSessionBtn").disabled = true);
    }

    const addons = userData.active_addons || {};
    let speed = "Slow";
    let hrs = 1;
    let badgeText = "GO";
    let badgeClass = "go";
    let planLabel = "GO (Base)";

    // Check Phone Sync Expiration
    let hasSync = false;
    if (addons.sync_app_expiry && Date.now() < addons.sync_app_expiry) {
        hasSync = true;
    }

    if (addons.super_pass) {
        speed = "Medium";
        hrs = 3;
        badgeText = "SUPER";
        badgeClass = "super";
        planLabel = "SUPER Pass";
        hasSync = true; // Super pass gets phone sync for free
    } else {
        if (addons.speed_boost) speed = "Fast";
        if (addons.extra_hours_added) hrs += addons.extra_hours_added;
        if (addons.speed_boost || addons.extra_hours_added) {
            badgeText = "PRO";
            badgeClass = "pro";
            let p = [];
            if (addons.speed_boost) p.push("Speed");
            if (addons.extra_hours_added) p.push(`+${addons.extra_hours_added}Hr`);
            planLabel = `GO with ${p.join(" & ")}`;
        }
    }

    setLoggedInUser(user.rollNumber, userData.name, planLabel);

    document.getElementById("userRoll").textContent = `${userData.name}  ·  ${user.rollNumber}`;
    document.getElementById("planName").textContent = planLabel;
    document.getElementById("planSpeed").textContent = speed;
    document.getElementById("planDuration").textContent = hrs + " hr" + (hrs > 1 ? "s" : "");

    const badge = document.getElementById("planBadge");
    badge.textContent = badgeText;
    badge.className = "plan-badge " + (userData.suspended ? "suspended" : badgeClass);

    document.getElementById("planDetails").innerHTML = `
        <p><strong>Speed:</strong> ${speed}</p>
        <p><strong>Session length:</strong> ${hrs} hour${hrs > 1 ? "s" : ""}</p>
        <p><strong>Phone Sync:</strong> <strong style="color:${hasSync ? '#43e97b' : '#ff6b81'}">${hasSync ? 'Active (7-Day Pass)' : 'Expired / Not Purchased'}</strong></p>
        <p><strong>Cooldown:</strong> 2 hours after session ends</p>
    `;

    // Pending payment notice
    if (userData.pending_plan) {
        document.getElementById("pendingNotice").style.display = "block";
        document.getElementById("pendingPlanName").textContent = userData.pending_plan;
        const t = userData.pending_submitted_at;
        if (t) document.getElementById("pendingSubmittedAt").textContent = "Submitted: " + new Date(t).toLocaleString();
        document.getElementById("paymentSection").style.display = "none";
    }
}

