/**
 * 12-digit registration: 111 + institution(5–7) + year(24|25|26) + 10 + XYYY
 * Last four XYYY: X = department (2–5), YYY = serial 001–999.
 */
function validateRollNumberFormat(roll) {
    const s = String(roll == null ? "" : roll).trim();
    if (!/^\d{12}$/.test(s)) {
        return { ok: false, message: "Roll number must be exactly 12 digits." };
    }
    if (!s.startsWith("111")) {
        return { ok: false, message: "Roll number must start with 111." };
    }
    if (!"567".includes(s[3])) {
        return { ok: false, message: "Invalid institution digit (use 5, 6, or 7)." };
    }
    const yy = s.slice(4, 6);
    if (!["24", "25", "26"].includes(yy)) {
        return { ok: false, message: "Invalid year code (use 24, 25, or 26)." };
    }
    if (s.slice(6, 8) !== "10") {
        return { ok: false, message: "Invalid segment (positions 7–8 must be 10)." };
    }
    if (!"2345".includes(s[8])) {
        return { ok: false, message: "Invalid department digit (use 2, 3, 4, or 5)." };
    }
    const yyy = parseInt(s.slice(9, 12), 10);
    if (yyy < 1 || yyy > 999) {
        return { ok: false, message: "Invalid serial (last 3 digits must be 001–999)." };
    }
    return { ok: true };
}
