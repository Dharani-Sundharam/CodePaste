/* ═══════════════════════════════════════════════════════
   CTpaste — app.js  v3
   Auth · Sessions · Credits · Firebase helpers
   ═══════════════════════════════════════════════════════ */

const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBj0DiKnREPMutNn_r1w8tq3F1-K0v6MoI",
    projectId: "codepaste-ds",
    databaseURL: "https://codepaste-ds-default-rtdb.asia-southeast1.firebasedatabase.app",
    storageBucket: "codepaste-ds.firebasestorage.app"
};

const DB_URL = FIREBASE_CONFIG.databaseURL;

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

// ── Roll number validation ────────────────────────────
function validateRollNumberFormat(roll) {
    const s = (roll || "").trim();
    if (s.length !== 12 || !/^\d+$/.test(s)) return { ok: false };
    if (!s.startsWith("111")) return { ok: false };
    const inst = s[3];
    if (!["5","6","7"].includes(inst)) return { ok: false };
    const yr = s.slice(4, 6);
    if (!["24","25","26"].includes(yr)) return { ok: false };
    const mid = s.slice(6, 8);
    if (!["10","11"].includes(mid)) return { ok: false };
    const dept = s[8];
    if (!["0","1","2","3","4","5"].includes(dept)) return { ok: false };
    const seq = parseInt(s.slice(9), 10);
    if (seq < 1 || seq > 999) return { ok: false };
    return { ok: true };
}

function isRollEdgeCaseSubmission(roll) {
    const s = (roll || "").trim();
    if (s.length < 10 || s.length > 15) return false;
    if (!/^\d+$/.test(s)) return false;
    if (!s.startsWith("111")) return false;
    return true;
}

// ── WhatsApp notification for edge-case rolls ─────────
const WHATSAPP_PHONE = "+919626262428";
const WHATSAPP_APIKEY = "4667147";

function notifyCallMeBotEdgeCaseRoll(roll) {
    const msg = encodeURIComponent(
        `CTpaste roll review%0ARoll: ${roll}%0ATime: ${new Date().toLocaleString("en-IN")}%0AOpen Admin → Roll requests to approve.`
    );
    fetch(
        `https://api.callmebot.com/whatsapp.php?phone=${WHATSAPP_PHONE}&text=${msg}&apikey=${WHATSAPP_APIKEY}`
    ).catch(() => {});
}

function notifyCallMeBotPayment(roll, amount) {
    const msg = encodeURIComponent(
        `CTpaste payment%0ARoll: ${roll}%0AAmount: ₹${amount}%0ATime: ${new Date().toLocaleString("en-IN")}%0AOpen Admin → Payments to approve.`
    );
    fetch(
        `https://api.callmebot.com/whatsapp.php?phone=${WHATSAPP_PHONE}&text=${msg}&apikey=${WHATSAPP_APIKEY}`
    ).catch(() => {});
}

// ── Local auth state ──────────────────────────────────
function getLoggedInUser() {
    const d = localStorage.getItem("CTpaste_user");
    return d ? JSON.parse(d) : null;
}
function setLoggedInUser(rollNumber, name) {
    localStorage.setItem("CTpaste_user", JSON.stringify({ rollNumber, name }));
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

    const fmt = validateRollNumberFormat(roll);
    clearStatus("statusMsg");
    showStatus("statusMsg", "Checking...", "info");

    let user = await fbGet(`users/${roll}`);

    if (fmt.ok) {
        if (!user) {
            await fbUpdate(`users/${roll}`, { roll_number: roll, credits: 0 });
            user = await fbGet(`users/${roll}`);
        }
    } else {
        if (user) {
            // existing edge-case account — allow through
        } else if (isRollEdgeCaseSubmission(roll)) {
            const pend = await fbGet(`pending_roll_requests/${roll}`);
            if (pend && pend.status === "pending") {
                clearStatus("statusMsg");
                showStatus("statusMsg", "This registration number is already under review. Please wait for admin approval before signing in.", "info");
                return;
            }
            const w = await fetch(`${DB_URL}/pending_roll_requests/${roll}.json`, {
                method: "PATCH",
                body: JSON.stringify({ roll_number: roll, submitted_at: Date.now(), status: "pending" }),
                headers: { "Content-Type": "application/json" }
            });
            if (!w.ok) {
                clearStatus("statusMsg");
                showStatus("statusMsg", "We could not submit your registration for review. Please try again later or contact admin.", "error");
                return;
            }
            notifyCallMeBotEdgeCaseRoll(roll);
            clearStatus("statusMsg");
            showStatus("statusMsg", "Your registration number has been submitted for review. You can sign in after an admin approves it — check back later.", "success");
            return;
        } else {
            clearStatus("statusMsg");
            showStatus("statusMsg", "Please enter a valid registration number.", "error");
            return;
        }
    }

    clearStatus("statusMsg");

    if (!user) { showStatus("statusMsg", "Could not open your account slot. Try again.", "error"); return; }

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

    const check = await fbGet(`users/${currentRoll}`);
    if (!check || check.password !== pass) {
        showStatus("statusMsg", "Could not save account — check your internet and try again.", "error");
        return;
    }

    setLoggedInUser(currentRoll, name);
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

    // Support legacy hashed users
    let expectedHash = null;
    try {
        if (window.crypto && crypto.subtle) {
            const data = new TextEncoder().encode(pass + "__CTpaste_salt__");
            const buf = await crypto.subtle.digest("SHA-256", data);
            expectedHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
        }
    } catch (e) { console.warn("Legacy hash generation skipped."); }

    if (!user.password && !user.password_hash) {
        showStatus("statusMsg", "Account not fully set up — please sign up again.", "error"); return;
    }

    if (user.password !== pass && user.password_hash !== expectedHash) {
        showStatus("statusMsg", "Incorrect password. Please try again.", "error"); return;
    }

    if (!user.password && user.password_hash === expectedHash) {
        await fbUpdate(`users/${currentRoll}`, { password: pass });
    }

    if (user.suspended) {
        showStatus("statusMsg", "Account suspended. Contact admin.", "error"); return;
    }

    await fbUpdate(`users/${currentRoll}`, { last_login: Date.now() });
    setLoggedInUser(currentRoll, user.name);
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

async function loadDashboard(user) {
    const userData = await fbGet(`users/${user.rollNumber}`);
    if (!userData) { logout(); return; }

    if (userData.suspended) {
        document.getElementById("suspendedNotice").style.display = "block";
        document.getElementById("paymentSection").style.display = "none";
        return;
    }

    const credits = userData.credits || 0;
    setLoggedInUser(user.rollNumber, userData.name);

    document.getElementById("userRoll").textContent = `${userData.name}  ·  ${user.rollNumber}`;
    document.getElementById("creditsBalance").textContent = credits.toLocaleString();

    // Pending payment notice
    if (userData.pending_payment) {
        document.getElementById("pendingNotice").style.display = "block";
        const t = userData.pending_payment.submitted_at;
        if (t) document.getElementById("pendingSubmittedAt").textContent = "Submitted: " + new Date(t).toLocaleString();
        document.getElementById("paymentSection").style.display = "none";
    } else {
        document.getElementById("pendingNotice").style.display = "none";
        document.getElementById("paymentSection").style.display = "";
    }
}

// ── Screenshot compression & payment submission ───────
function onScreenshotSelected(input) {
    const file = input.files[0];
    if (!file) return;
    const preview = document.getElementById("screenshotPreview");
    if (!preview) return;
    const reader = new FileReader();
    reader.onload = e => {
        preview.src = e.target.result;
        preview.style.display = "block";
    };
    reader.readAsDataURL(file);
}

async function compressImageToBase64(file, maxWidth = 800, quality = 0.5) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxWidth / img.width);
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/jpeg", quality));
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function submitPayment() {
    const user = getLoggedInUser();
    if (!user) { logout(); return; }

    const fileInput = document.getElementById("screenshotInput");
    if (!fileInput || !fileInput.files[0]) {
        showStatus("paymentStatus", "Please select a payment screenshot.", "error");
        return;
    }

    const btn = document.getElementById("submitPaymentBtn");
    btn.disabled = true;
    btn.textContent = "Uploading...";
    showStatus("paymentStatus", "Compressing and uploading screenshot...", "info");

    try {
        const b64 = await compressImageToBase64(fileInput.files[0], 800, 0.5);

        const key = `${Date.now()}_${user.rollNumber}`;
        const paymentData = {
            roll_number: user.rollNumber,
            amount_inr: 50,
            credits_to_add: 7000,
            screenshot_b64: b64,
            status: "pending",
            submitted_at: Date.now()
        };

        await fbSet(`payment_queue/${key}`, paymentData);
        await fbUpdate(`users/${user.rollNumber}`, {
            pending_payment: { submitted_at: Date.now(), key }
        });

        notifyCallMeBotPayment(user.rollNumber, 50);

        showStatus("paymentStatus", "✅ Payment submitted! Admin will verify and credit 7,000 credits to your account.", "success");
        document.getElementById("paymentSection").style.display = "none";
        document.getElementById("pendingNotice").style.display = "block";
        document.getElementById("pendingSubmittedAt").textContent = "Submitted: " + new Date().toLocaleString();
    } catch (err) {
        showStatus("paymentStatus", "Upload failed — please try again.", "error");
        console.error(err);
    } finally {
        btn.disabled = false;
        btn.textContent = "Submit Payment";
    }
}
