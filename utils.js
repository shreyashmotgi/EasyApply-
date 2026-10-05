/* Pure helper functions (no DOM, no chrome APIs). Loaded before sidepanel.js. */

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/* ---------- LaTeX edit parsing and applying ---------- */
function trimNl(s) {
  return s.replace(/^\s*```[a-z]*\s*$/gm, "").replace(/^\r?\n/, "").replace(/\r?\n\s*$/, "");
}

// Model output uses a plain-text format (not JSON) because LaTeX is full of backslashes.
function parseEdits(text) {
  const out = [];
  const chunks = String(text || "").split("===EDIT===").slice(1);
  for (const ch of chunks) {
    const end = ch.indexOf("===END===");
    const body = end >= 0 ? ch.slice(0, end) : ch;
    const fi = body.indexOf("---FIND---");
    const ri = body.indexOf("---REPLACE---");
    if (fi < 0 || ri < 0 || ri < fi) continue;
    const head = body.slice(0, fi);
    const section = (/SECTION:\s*(.*)/.exec(head) || [])[1] || "Resume";
    const reason = (/REASON:\s*(.*)/.exec(head) || [])[1] || "";
    const find = trimNl(body.slice(fi + 10, ri));
    const replace = trimNl(body.slice(ri + 13));
    if (!find.trim()) continue;
    out.push({ section: section.trim(), reason: reason.trim(), find, replace });
  }
  return out.slice(0, 12);
}

// Finds where an edit's FIND text sits in the original LaTeX. Must match exactly once.
function locate(latex, e) {
  const idxs = [];
  let from = 0;
  while (true) {
    const i = latex.indexOf(e.find, from);
    if (i < 0) break;
    idxs.push(i);
    from = i + Math.max(1, e.find.length);
  }
  if (idxs.length === 1) { e.start = idxs[0]; e.end = idxs[0] + e.find.length; e.status = "ok"; return e; }
  if (idxs.length > 1) { e.status = "ambiguous"; return e; }
  const pat = e.find.trim().split(/\s+/).map(escapeRegex).join("\\s+");
  const ms = [...latex.matchAll(new RegExp(pat, "g"))];
  if (ms.length === 1) { e.start = ms[0].index; e.end = e.start + ms[0][0].length; e.status = "ok"; }
  else e.status = ms.length ? "ambiguous" : "notfound";
  return e;
}

// If the model adds an unescaped & % # _ that the original text did not have, escape it.
function fixEscapes(find, replace) {
  let out = replace;
  for (const ch of ["&", "%", "#", "_"]) {
    const un = new RegExp("(?<!\\\\)" + ch);
    if (!un.test(find) && un.test(out)) out = out.replace(new RegExp("(?<!\\\\)" + ch, "g"), (m) => "\\" + m);
  }
  return out;
}

function applyEdits(latex, chosen) {
  const sorted = chosen.filter((e) => e.status === "ok").sort((a, b) => a.start - b.start);
  let res = "", pos = 0, applied = 0, skipped = 0;
  for (const e of sorted) {
    if (e.start < pos) { skipped++; continue; }
    res += latex.slice(pos, e.start) + fixEscapes(e.find, e.replace);
    pos = e.end;
    applied++;
  }
  res += latex.slice(pos);
  return { text: res, applied, skipped };
}

function latexStats(s) {
  const t = s.split("\n").map((l) => l.replace(/(?<!\\)%.*$/, "")).join("\n");
  const c = (re) => (t.match(re) || []).length;
  return { bal: c(/(?<!\\)\{/g) - c(/(?<!\\)\}/g), env: c(/\\begin\{/g) - c(/\\end\{/g) };
}
function checkLatex(original, result) {
  const a = latexStats(original), b = latexStats(result), w = [];
  if (a.bal !== b.bal) w.push("Curly brackets { } are no longer balanced. Check the edited lines before compiling.");
  if (a.env !== b.env) w.push("\\begin and \\end no longer match. Check the edited lines before compiling.");
  return w;
}

function prepLatexBody(latex, maxChars) {
  let s = latex;
  const a = s.indexOf("\\begin{document}");
  if (a >= 0) s = s.slice(a);
  s = s.split("\n").filter((l) => !/^\s*%/.test(l) && l.trim() !== "").join("\n");
  let truncated = false;
  if (s.length > maxChars) { s = s.slice(0, maxChars); truncated = true; }
  return { text: s, truncated };
}

// Rough plain-text version of a LaTeX resume, used only when no plain resume was saved.
function latexToText(latex) {
  let s = latex;
  const a = s.indexOf("\\begin{document}");
  if (a >= 0) s = s.slice(a + 16);
  s = s.split("\n").map((l) => l.replace(/(?<!\\)%.*$/, "")).join("\n");
  return s
    .replace(/\\(?:begin|end)\{[^}]*\}(\[[^\]]*\])?/g, " ")
    .replace(/\\href\{[^}]*\}/g, "")
    .replace(/\\\\/g, "\n")
    .replace(/\\item\b/g, "\n- ")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/\\([&%$#_])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/* ---------- company risk helpers ---------- */
const FLAG_RULES = [
  { weight: 2, label: "Asks for money (fee or deposit)",
    re: /(registration|training|security|processing|joining|application|refundable|kit|laptop)\s+(fee|fees|deposit|charges?|amount)|(pay|deposit|transfer)\s+(a\s+|an\s+)?(small\s+)?(fee|deposit|amount)|deposit\s+(of\s+)?(rs\.?|₹|inr|\$)/i },
  { weight: 1, label: "Contact through WhatsApp or Telegram",
    re: /(contact|message|reach|apply|send|resume|cv|hr|call)[^.\n]{0,40}(whatsapp|telegram)|(whatsapp|telegram)[^.\n]{0,30}(only|number|no\.?|\+?\d{5,})/i },
  { weight: 1, label: "Recruiter uses a free email address",
    re: /[\w.+-]+@(gmail|yahoo|hotmail|outlook|rediffmail)\.com/i },
  { weight: 2, label: "Promises a job without a proper interview",
    re: /no\s+interview|without\s+(any\s+|an\s+)?interview|selection\s+without\s+interview/i },
  { weight: 2, label: "Unrealistic or guaranteed income",
    re: /(earn|income)\s+(up\s+to\s+)?(rs\.?|₹|inr|\$)?\s*[\d,]+\s*(\/|per\s+)(day|daily|week|hour)|guaranteed\s+(job|income|placement|salary)/i },
];
function localRedFlags(text) {
  const flags = [];
  let score = 0;
  for (const r of FLAG_RULES) {
    const m = r.re.exec(text);
    if (!m) continue;
    const a = Math.max(0, m.index - 50), b = Math.min(text.length, m.index + m[0].length + 60);
    flags.push({ flag: r.label, evidence: text.slice(a, b).replace(/\s+/g, " ").trim() });
    score += r.weight;
  }
  return { flags, score };
}
const RISK_RANK = { unknown: 0, low: 1, medium: 2, high: 3 };
function finalRisk(modelLevel, localScore) {
  const lvl = RISK_RANK[modelLevel] !== undefined ? modelLevel : "unknown";
  const floor = localScore >= 4 ? "high" : localScore >= 2 ? "medium" : null;
  return floor && RISK_RANK[floor] > RISK_RANK[lvl] ? floor : lvl;
}
function normUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:") return null;
    return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase();
  } catch { return null; }
}

/* ---------- contact emails: read from live pages only, never guessed ---------- */
const FREE_MAIL_DOMAIN = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|rediffmail|protonmail|proton|icloud|aol)\.[a-z.]{2,}$/;
const BAD_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|noreply|privacy|abuse|unsubscribe|legal|dmca|security|webmaster|postmaster|mailer-daemon|billing|invoices?|accounts?|press|media|marketing|newsletter|sales|support|help|helpdesk|admin|feedback|complaints?|grievance|compliance|ir|investors?)$/;
const HR_LOCAL = /^(hr|hrd|humanresources?|careers?|jobs?|recruit(?:er|ers|ment|ing)?|talent|hiring|apply|applications?|resumes?|cv|people|peopleops|joinus|staffing|campus|interns?|internships?|placements?)(?:[._-][a-z0-9._-]+)?$/;
const GENERAL_LOCAL = /^(info|contact|contactus|hello|hi|office|enquiry|enquiries|inquiry|inquiries|mail|team|connect|general)$/;

// Cloudflare "email protection" hides addresses as hex; this decodes them.
function cfDecode(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch { return ""; }
}
function extractEmails(source) {
  let s = String(source || "");
  const found = [];
  for (const m of s.matchAll(/data-cfemail="([0-9a-f]{6,})"|email-protection#([0-9a-f]{6,})/gi)) found.push(cfDecode(m[1] || m[2]));
  s = s.replace(/\\u00[0-9a-f]{2}/gi, " ")
    .replace(/&#0*64;|&#x0*40;|&commat;/gi, "@")
    .replace(/&#0*46;|&#x0*2e;/gi, ".")
    .replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, "@")
    .replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".");
  for (const m of s.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) found.push(m[0]);
  const out = [];
  for (let e of found) {
    e = e.toLowerCase().replace(/^(?:%[0-9a-f]{2})+/, "").replace(/^[._%+-]+/, "").replace(/[._-]+$/, "");
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e) && !out.includes(e)) out.push(e);
  }
  return out;
}
function classifyEmail(email) {
  const m = /^([^@\s]+)@([^@\s]+\.[a-z]{2,})$/i.exec(email || "");
  if (!m) return null;
  const local = m[1].toLowerCase(), domain = m[2].toLowerCase();
  if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ico|pdf)$/.test(domain)) return { kind: "skip" };
  if (BAD_LOCAL.test(local) || /^(example|test|your|name|email|user|username|firstname|lastname)$/.test(local)) return { kind: "skip" };
  if (/^(example|domain|yourdomain|email|test|sentry)\./.test(domain) || /(^|\.)sentry\.io$/.test(domain)) return { kind: "skip" };
  if (FREE_MAIL_DOMAIN.test(domain)) return { kind: "free" };
  if (HR_LOCAL.test(local)) return { kind: "hr" };
  if (GENERAL_LOCAL.test(local)) return { kind: "general" };
  return { kind: "person" };
}
function hostFromUrl(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } }
function emailDomainMatches(email, host) {
  const d = String(email).split("@")[1].replace(/^www\./, "").toLowerCase();
  const h = String(host).replace(/^www\./, "").toLowerCase();
  return d === h || d.endsWith("." + h) || h.endsWith("." + d);
}
// found: [{email, source: "job post" | "company website", url}]
function pickContacts(found, host) {
  const map = new Map();
  for (const f of found) {
    const email = String(f.email || "").toLowerCase();
    const c = classifyEmail(email);
    if (!c || c.kind === "skip") continue;
    const dm = host ? emailDomainMatches(email, host) : null;
    if (f.source === "company website" && host && dm === false) continue;   // third-party address on the site
    const item = { email, kind: c.kind, source: f.source, url: f.url || "", domainMatch: dm };
    const prev = map.get(email);
    if (!prev || (prev.source !== "job post" && f.source === "job post")) map.set(email, item);
  }
  const kindRank = { hr: 0, general: 1, person: 2, free: 3 };
  const srcRank = { "job post": 0, "company website": 1 };
  return [...map.values()]
    .sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || srcRank[a.source] - srcRank[b.source])
    .slice(0, 8);
}
// DNS-over-HTTPS JSON answer -> true (mail server exists), false (domain cannot receive mail), null (unknown)
function mxVerdict(j) {
  if (!j || typeof j.Status !== "number") return null;
  if (j.Status === 3) return false;
  if (j.Status !== 0) return null;
  return Array.isArray(j.Answer) && j.Answer.some((a) => a.type === 15);
}
function postingAgeWarning(text) {
  const m = /(?:posted|reposted|published|date posted)[^.\n]{0,25}?(\d+)\s*(month|year)s?\s+ago/i.exec(String(text || ""));
  if (!m) return "";
  const n = Number(m[1]);
  const months = m[2].toLowerCase() === "year" ? n * 12 : n;
  return months >= 2 ? `This posting says it was posted ${n} ${m[2].toLowerCase()}${n > 1 ? "s" : ""} ago, so the contact may be outdated.` : "";
}
function postingClosed(text) {
  return /no longer accepting applications|this job is closed|position (?:has been |is )?filled|job (?:has )?expired|applications? (?:are |is )?closed/i.test(String(text || ""));
}

/* ---------- cold email helpers ---------- */
function sanitizeName(n) {
  if (/[<>@\d]/.test(String(n || ""))) return "";
  const t = String(n || "").replace(/[^\p{L}\s.'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return /^(hiring|hr|recruiter|team|manager|not mentioned|n\/a|none|unknown)/i.test(t) ? "" : t;
}
function parseColdEmail(text) {
  const t = String(text || "").replace(/^\s*```[a-z]*\s*$/gm, "");
  const subjects = [];
  for (const m of t.matchAll(/^\s*SUBJECT_\d:\s*(.+)$/gm)) subjects.push(m[1].trim());
  const marks = ["---EMAIL---", "---FOLLOWUP---", "---LINKEDIN---"]
    .map((m) => ({ m, i: t.indexOf(m) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);
  const part = {};
  marks.forEach((x, k) => {
    const start = x.i + x.m.length, end = k + 1 < marks.length ? marks[k + 1].i : t.length;
    part[x.m] = t.slice(start, end).trim();
  });
  return { subjects: subjects.slice(0, 3), body: part["---EMAIL---"] || "", followup: part["---FOLLOWUP---"] || "", linkedin: part["---LINKEDIN---"] || "" };
}
// Removes a greeting or sign-off if the model added one anyway.
function stripGreetingSignoff(body) {
  let lines = String(body || "").trim().split("\n");
  if (lines.length && /^(hi|hello|dear)\b[^.!?]{0,60},?\s*$/i.test(lines[0].trim())) lines.shift();
  const i = lines.findIndex((l) => /^(best regards|warm regards|kind regards|regards|sincerely|thanks|thank you|best|cheers)[,!.]?\s*$/i.test(l.trim()));
  if (i >= 0) lines = lines.slice(0, i);
  return lines.join("\n").trim();
}
function greetingName(name) {
  const t = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!t.length) return "";
  if (/^(dr|mr|mrs|ms|prof)\.?$/i.test(t[0])) return t.length > 1 ? `${t[0]} ${t[t.length - 1]}` : t[0];
  return t[0];
}
function assembleEmail(name, body, sign) {
  const first = greetingName(name);
  const greeting = first ? `Hi ${first},` : "Hi Hiring Team,";
  return `${greeting}\n\n${stripGreetingSignoff(body)}\n\nBest regards,\n${sign || "[Your Name]"}`;
}
// Gmail compose in the browser. If the link would be too long, the body is left out (the UI copies it instead).
function buildGmailUrl({ to, subject, body }, maxLen = 6000) {
  const base = "https://mail.google.com/mail/?view=cm&fs=1";
  const q = (k, v) => (v ? `&${k}=${encodeURIComponent(v)}` : "");
  const full = base + q("to", to) + q("su", subject) + q("body", body);
  if (full.length <= maxLen) return { url: full, bodyIncluded: true };
  return { url: base + q("to", to) + q("su", subject), bodyIncluded: false };
}

if (typeof module !== "undefined") {
  module.exports = { parseEdits, locate, fixEscapes, applyEdits, checkLatex, prepLatexBody,
    latexToText, localRedFlags, finalRisk, normUrl,
    cfDecode, extractEmails, classifyEmail, hostFromUrl, emailDomainMatches, pickContacts, mxVerdict,
    postingAgeWarning, postingClosed, sanitizeName, parseColdEmail, stripGreetingSignoff, greetingName, assembleEmail, buildGmailUrl };
}
