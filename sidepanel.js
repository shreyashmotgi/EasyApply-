const $ = (id) => document.getElementById(id);
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const DEFAULT_SEARCH_MODEL = "openai/gpt-oss-20b";   // groq/compound was retired on 2026-09-21
const MAX_RESUME_CHARS = 6000;   // keeps requests inside Groq free-tier token limits
const MAX_PAGE_CHARS = 10000;
const MAX_CHAT_JD_CHARS = 5000;
const MAX_LATEX_CHARS = 12000;
const CACHE_DAYS = 7;

pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

const CHAT_SYSTEM = `You are a friendly career coach helping a candidate tailor their resume to one job posting. Use only the resume and job text given below.
FORMAT (very important): write plain text only. Do not use markdown: no asterisks, no # headings, no tables, no horizontal rules. Use short paragraphs. For lists, put each item on its own line starting with "- ". Put a short section name on its own line ending with a colon.
CONTENT RULES:
- When asked what to change, group the answer by resume section (Summary, Skills, Experience, Projects, Education). For each, say exactly what to change and why it matches the job.
- Only suggest changes based on what the resume already shows. If the job wants a skill that is not in the resume, say "Add this only if you really have it". Never invent tools, projects, metrics or experience.
- Do not make up score calculations or point tables.
- Keep answers under 250 words unless asked for more.`;

let runId = 0;          // increases on every Analyze click, so old async results are ignored
let current = null;     // { analysis, page } of the latest analysis
let chatHistory = [];
let chatContext = "";
let edits = [];         // LaTeX edits suggested by the model
let latexTruncated = false;

/* ---------- small helpers ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function setStatus(msg, isError = false, id = "status") {
  const s = $(id);
  s.textContent = msg;
  s.className = "status" + (isError ? " error" : "");
}
const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

/* ---------- clean text rendering (no raw markdown shown) ---------- */
function plain(t) {
  return String(t == null ? "" : t).replace(/\*\*/g, "").replace(/`/g, "").replace(/^#+\s*/, "");
}
function addInline(parent, text) {
  text.split(/(\*\*[^*]+\*\*)/g).forEach((p) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) parent.appendChild(el("strong", "", p.slice(2, -2)));
    else if (p) parent.appendChild(document.createTextNode(p.replace(/\*+/g, "").replace(/`/g, "")));
  });
}
function renderRich(container, raw) {
  container.replaceChildren();
  let list = null;
  raw.split("\n").forEach((line) => {
    let t = line.trim();
    if (!t || /^[-|:\s]+$/.test(t)) { list = null; return; }
    if (t.startsWith("|")) t = t.split("|").map((c) => c.trim()).filter(Boolean).join(" - ");
    const heading = /^#{1,6}\s+/.test(t);
    if (heading) t = t.replace(/^#{1,6}\s+/, "");
    if (/^([-*\u2022]|\d+[.)])\s+/.test(t)) {
      t = t.replace(/^([-*\u2022]|\d+[.)])\s+/, "");
      if (!list) { list = el("ul"); container.appendChild(list); }
      const li = el("li"); addInline(li, t); list.appendChild(li);
      return;
    }
    list = null;
    const p = el("p", heading || (t.endsWith(":") && t.length < 70) ? "sec" : "");
    addInline(p, t);
    container.appendChild(p);
  });
}
function linkEl(url, text) {
  const a = el("a", "", text || new URL(url).hostname.replace(/^www\./, ""));
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

/* ---------- settings, resume, LaTeX storage ---------- */
async function loadState() {
  const s = await chrome.storage.local.get(["apiKey", "model", "searchModel", "resume", "resumeName", "latex", "userName"]);
  if (s.apiKey) $("apiKey").value = s.apiKey;
  if (s.userName) $("userName").value = s.userName;
  if (s.model) $("model").value = s.model;
  if (s.searchModel && /^groq\/compound/.test(s.searchModel)) {
    s.searchModel = DEFAULT_SEARCH_MODEL;            // retired model: switch automatically
    await chrome.storage.local.set({ searchModel: s.searchModel });
  }
  if (s.searchModel) $("searchModel").value = s.searchModel;
  if (!s.apiKey) $("settings").open = true;
  showResumeStatus(s.resume, s.resumeName);
  showLatexStatus(s.latex);
}
function showResumeStatus(resume, name) {
  $("resumeStatus").textContent = resume
    ? `Saved: ${name || "resume"} (${resume.length} characters)`
    : "No resume saved yet.";
}
function showLatexStatus(latex, extra = "") {
  $("latexStatus").textContent = (latex ? `LaTeX resume saved (${latex.length} characters).` : "No LaTeX resume saved.") + extra;
}
$("userName").addEventListener("change", () => chrome.storage.local.set({ userName: sanitizeName($("userName").value) }));
$("saveSettings").addEventListener("click", async () => {
  await chrome.storage.local.set({
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || DEFAULT_MODEL,
    searchModel: $("searchModel").value.trim() || DEFAULT_SEARCH_MODEL,
  });
  $("settingsMsg").textContent = "Saved.";
  setTimeout(() => ($("settingsMsg").textContent = ""), 2000);
});

async function extractPdfText(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    out += content.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("") + "\n";
  }
  return out;
}
$("resumeFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = file.name.toLowerCase().endsWith(".pdf") ? await extractPdfText(file) : await file.text();
    const clean = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    if (clean.length < 50) throw new Error("Could not read text from this file. If it is a scanned PDF, paste the text instead.");
    await chrome.storage.local.set({ resume: clean, resumeName: file.name });
    showResumeStatus(clean, file.name);
  } catch (err) {
    $("resumeStatus").textContent = "Could not read file: " + err.message;
  }
});
$("saveResumeText").addEventListener("click", async () => {
  const t = $("resumeText").value.trim();
  if (t.length < 50) return;
  await chrome.storage.local.set({ resume: t, resumeName: "pasted text" });
  showResumeStatus(t, "pasted text");
});
$("saveLatex").addEventListener("click", async () => {
  const t = $("latexText").value.trim();
  if (!t.includes("\\begin{document}")) {
    $("latexStatus").textContent = "This does not look like a full LaTeX resume (\\begin{document} is missing).";
    return;
  }
  const upd = { latex: t };
  const { resume } = await chrome.storage.local.get("resume");
  let extra = "";
  if (!resume) {
    const txt = latexToText(t);
    if (txt.length >= 50) {
      upd.resume = txt;
      upd.resumeName = "LaTeX resume (converted to text)";
      extra = " A plain-text copy was also made for the analysis.";
      showResumeStatus(txt, upd.resumeName);
    }
  }
  await chrome.storage.local.set(upd);
  $("latexText").value = "";
  showLatexStatus(t, extra);
});
$("clearLatex").addEventListener("click", async () => {
  await chrome.storage.local.remove("latex");
  showLatexStatus(null);
});

/* ---------- read the current page ---------- */
async function readActivePage() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.id || /^(chrome|edge|about|chrome-extension):/.test(tab.url || "")) {
    throw new Error("Open a normal job page in the active tab first.");
  }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const sel = window.getSelection();
      const selText = sel ? String(sel).trim() : "";
      const useSel = selText.length > 300;
      let root = document.body;
      if (useSel) { root = document.createElement("div"); root.appendChild(sel.getRangeAt(0).cloneContents()); }
      return {
        title: document.title, url: location.href, usedSelection: useSel,
        text: (useSel ? selText : (document.body ? document.body.innerText : "")).slice(0, 300000),
        mailtos: [...root.querySelectorAll('a[href^="mailto:" i]')].slice(0, 20).map((a) => a.getAttribute("href")),
        cf: [...root.querySelectorAll("[data-cfemail]")].slice(0, 20).map((a) => a.getAttribute("data-cfemail")),
      };
    },
  });
  const r = res.result;
  const full = r.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { title: r.title, url: r.url, text: full.slice(0, MAX_PAGE_CHARS), fullText: full,
    mailtos: r.mailtos || [], cf: r.cf || [], usedSelection: r.usedSelection };
}

/* ---------- Groq ---------- */
class GroqError extends Error {
  constructor(msg, status, retryAfter) { super(msg); this.status = status; this.retryAfter = retryAfter; }
}
function parseRetrySeconds(msg) {
  const m = /try again in\s+(?:(\d+)m)?\s*([\d.]+)s/i.exec(msg || "");
  return m ? (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) : null;
}
async function groqRequest(body) {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) throw new GroqError("Add your Groq API key in Settings first.", 0);
  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json()).error?.message || ""; } catch {}
    if (resp.status === 401) throw new GroqError("Invalid API key. Check it in Settings.", 401);
    if (resp.status === 404) throw new GroqError(`Model "${body.model}" is not available. Groq may have retired or renamed it. Change the model name in Settings.`, 404);
    if (resp.status === 413) throw new GroqError("The request was too large for Groq's free tier. Try again in a minute or use a different model in Settings.", 413);
    if (resp.status === 429) {
      const ra = Number(resp.headers.get("retry-after")) || parseRetrySeconds(detail);
      throw new GroqError("Groq rate limit reached. " + detail, 429, ra);
    }
    throw new GroqError(`Groq error ${resp.status}. ${detail}`, resp.status);
  }
  return resp.json();
}
async function callGroq(messages, { json = false, model, maxTokens = 2000 } = {}) {
  const s = await chrome.storage.local.get("model");
  const m = model || s.model || DEFAULT_MODEL;
  const body = { model: m, messages, temperature: 0.3, max_tokens: maxTokens };
  if (json) body.response_format = { type: "json_object" };
  if (m.includes("gpt-oss")) body.reasoning_effort = "low";
  const data = await groqRequest(body);
  return data.choices?.[0]?.message?.content || "";
}
// On a rate-limit error, wait and retry automatically (up to 2 times).
async function withRetry(fn, onWait) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (e.status !== 429 || attempt >= 2) throw e;
      const wait = Math.min(90, Math.max(10, Math.ceil(e.retryAfter || 30)) + 2);
      for (let s = wait; s > 0; s--) { onWait(s); await sleep(1000); }
    }
  }
}
function parseJson(text) {
  const cleaned = String(text).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(cleaned); }
  catch {
    const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    throw new Error("The model returned an unreadable answer. Try again.");
  }
}

/* ---------- analysis ---------- */
const ANALYSIS_SYSTEM = `You are an expert recruiter and ATS reviewer. You compare a candidate's resume with the text of a web page that contains a job posting. The page text may include navigation or unrelated listings: find the main job description and ignore the rest.
Rules:
- Never invent facts. For company details, use only what the page says; otherwise write "Not mentioned".
- Do not predict the chance of being hired. Give a fit score based only on how well the resume matches the stated requirements.
- Resume edits must be specific, truthful and based on what the resume already contains. Never suggest adding skills or experience the candidate does not have; suggest rewording, reordering or emphasising instead.
- missing_skills and matched_skills must be short names (1 to 4 words each), for example "Docker" or "REST APIs".
Return ONLY valid JSON in exactly this shape:
{
 "job_title": string,
 "company": string,
 "fit_score": integer 0-100,
 "verdict": string (one or two sentences),
 "breakdown": {"skills": int, "experience": int, "education": int, "keywords": int},
 "matched_skills": [string],
 "missing_skills": [string],
 "resume_edits": [{"section": string, "issue": string, "suggestion": string}],
 "company_info": {"summary": string, "industry": string, "size_or_stage": string, "location": string},
 "contact_person": string (name of a recruiter or contact person named in the posting for applications, otherwise ""),
 "jd_summary": string (under 120 words: main responsibilities and requirements),
 "jd_keywords": [string] (up to 20 important skills, tools and keywords from the job)
}
Give 3 to 6 resume_edits. Use empty arrays when there is nothing to list.`;

function section(title) {
  const box = el("div", "box");
  box.appendChild(el("h2", "", title));
  return box;
}
function chips(list, cls) {
  const wrap = el("div", "chips");
  (list || []).forEach((t) => wrap.appendChild(el("span", "chip " + cls, plain(t))));
  if (!list || !list.length) wrap.appendChild(el("span", "hint", "None"));
  return wrap;
}
function render(a) {
  const root = $("results");
  root.replaceChildren();

  const top = el("div", "box");
  const row = el("div", "score");
  const num = el("div", "score-num", String(clamp(a.fit_score)));
  num.appendChild(el("small", "", "/100"));
  const info = el("div");
  info.appendChild(el("div", "job-title", plain(`${a.job_title || "Job"} at ${a.company || "company"}`)));
  info.appendChild(el("p", "verdict", plain(a.verdict)));
  row.append(num, info);
  top.appendChild(row);
  const bd = a.breakdown || {};
  [["Skills", bd.skills], ["Experience", bd.experience], ["Education", bd.education], ["Keywords", bd.keywords]]
    .forEach(([label, v]) => {
      const r = el("div", "bar-row");
      const bar = el("div", "bar");
      const fill = el("span");
      fill.style.width = clamp(v) + "%";
      bar.appendChild(fill);
      r.append(el("span", "", label), bar, el("span", "", clamp(v) + "%"));
      top.appendChild(r);
    });
  top.appendChild(el("p", "note", "Fit score shows how closely your resume matches the posting. It is not a prediction of being hired."));
  root.appendChild(top);

  const skills = section("Skills");
  skills.appendChild(el("h3", "", "You have"));
  skills.appendChild(chips(a.matched_skills, "good"));
  skills.appendChild(el("h3", "", "Missing or not shown"));
  skills.appendChild(chips(a.missing_skills, "gap"));
  root.appendChild(skills);

  const editsBox = section("Suggested resume changes");
  (a.resume_edits || []).forEach((e) => {
    const d = el("div", "edit");
    d.appendChild(el("div", "where", plain(e.section) || "Resume"));
    if (e.issue) d.appendChild(el("div", "why", plain(e.issue)));
    d.appendChild(el("div", "", plain(e.suggestion)));
    editsBox.appendChild(d);
  });
  root.appendChild(editsBox);
  root.hidden = false;
}

/* ---------- company check (web search, automatic) ---------- */
function riskBar(level) {
  const rank = RISK_RANK[level];
  const names = { unknown: "Not enough information", low: "Low risk", medium: "Medium risk", high: "High risk" };
  const wrap = el("div", "risk " + level);
  const bar = el("div", "risk-bar");
  for (let i = 1; i <= 3; i++) bar.appendChild(el("span", "seg" + (i <= rank ? " on" : "")));
  wrap.append(bar, el("div", "risk-label", names[level]));
  return wrap;
}
function renderCompany(data, local, note, analysis) {
  const box = $("companyBox");
  box.hidden = false;
  box.replaceChildren(el("h2", "", "Company check"));
  if (note) box.appendChild(el("div", "hint", note));

  const level = finalRisk(data ? data.level : "unknown", local.score);
  if (data || local.flags.length) box.appendChild(riskBar(level));
  if (data && data.reason) box.appendChild(el("p", "", data.reason));

  if (data) {
    if (data.summary) box.appendChild(el("p", "", data.summary));
    const ul = el("ul");
    if (data.industry) ul.appendChild(el("li", "", "Industry: " + data.industry));
    if (data.size) ul.appendChild(el("li", "", "Size or stage: " + data.size));
    if (data.website) { const li = el("li", "", "Website: "); li.appendChild(linkEl(data.website)); ul.appendChild(li); }
    if (ul.children.length) box.appendChild(ul);
  } else if (analysis && analysis.company_info) {
    const c = analysis.company_info;
    box.appendChild(el("p", "hint", "From the job page only:"));
    const ul = el("ul");
    [["About", c.summary], ["Industry", c.industry], ["Size or stage", c.size_or_stage], ["Location", c.location]]
      .forEach(([k, v]) => ul.appendChild(el("li", "", `${k}: ${plain(v) || "Not mentioned"}`)));
    box.appendChild(ul);
  }

  const flags = [
    ...local.flags.map((f) => ({ ...f, link: "", where: "Found in this job posting" })),
    ...(data ? data.flags : []).map((f) => ({ ...f, where: "Found online" })),
  ];
  if (flags.length) {
    box.appendChild(el("h3", "", "Red flags"));
    flags.forEach((f) => {
      const d = el("div", "flag");
      d.appendChild(el("strong", "", f.flag));
      if (f.evidence) d.appendChild(el("div", "ev", "\u201C" + f.evidence + "\u201D"));
      const w = el("div", "where", f.where + " ");
      if (f.link) { w.appendChild(linkEl(f.link)); if (f.linkNote) w.appendChild(document.createTextNode(` (${f.linkNote})`)); }
      d.appendChild(w);
      box.appendChild(d);
    });
  }

  if (data && data.findings.length) {
    const det = el("details");
    det.open = level === "medium" || level === "high";
    det.appendChild(el("summary", "", `Sources and findings (${data.findings.length})`));
    data.findings.forEach((f) => {
      const d = el("div", "finding " + f.type, f.text + " ");
      if (f.link) {
        d.appendChild(linkEl(f.link));
        if (f.linkNote) d.appendChild(el("span", "hint", ` (${f.linkNote})`));
      } else d.appendChild(el("span", "hint", "(no working link)"));
      det.appendChild(d);
    });
    box.appendChild(det);
  }
  if (data && !data.verified) {
    box.appendChild(el("p", "warn", "No source could be fully confirmed automatically. Open the links yourself before trusting this result."));
  }
  if (data || local.flags.length) {
    box.appendChild(el("p", "note", "This is evidence from a web search, not a verdict. Always verify a company yourself before sharing documents or paying any money."));
  }
}

const COMPANY_SYSTEM = `You are a careful job-scam researcher. Use your browser search tool to learn about the company in a job posting: its official website, LinkedIn page, news, and reviews or complaints (for example "COMPANY scam" and "COMPANY reviews").
Rules:
- Report only what you actually found while searching. If you find little, say so. Never call a company safe just because you found no complaints.
- Do not state as fact that a company is a scam. Describe the evidence and give a risk level.
- Every finding and red flag needs the full https URL of the page where you saw it. Never guess or invent a URL; leave source empty if you do not have one.
Return ONLY a JSON object (no markdown) in exactly this shape:
{"summary": string (2-3 sentences on what the company does, from sources), "industry": string, "size_or_stage": string, "website": string (official site URL or ""),
 "risk_level": "low" | "medium" | "high" | "unknown",
 "risk_reason": string (one or two sentences),
 "findings": [{"text": string, "type": "positive" | "negative" | "neutral", "source": string}],
 "red_flags": [{"flag": string, "evidence": string, "source": string}]}
Use "unknown" if you could not find enough reliable information. At most 6 findings.`;

// Groq's browser search does not return citations reliably, so every link the model gives is
// opened by the extension itself: dead links (404, no such site) are dropped.
async function checkLink(url, name, trusted) {
  if (trusted) return { ok: true, note: "" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(url, { signal: ctl.signal, credentials: "omit", redirect: "follow" });
    if (r.status === 404 || r.status === 410) return { ok: false };
    if (!r.ok) return { ok: true, note: "could not be checked automatically" };
    const text = (await r.text()).slice(0, 400000).toLowerCase();
    const lower = name.toLowerCase();
    const token = lower.split(/\s+/).find((w) => w.length >= 3) || lower;
    return { ok: true, note: text.includes(lower) || text.includes(token) ? "" : "page does not mention the company name" };
  } catch (e) {
    return e.name === "AbortError" ? { ok: true, note: "could not be checked automatically" } : { ok: false };
  } finally { clearTimeout(timer); }
}
async function verifyLinks(items, name, allowed) {
  const href = (u) => { try { const h = new URL(u).href; return normUrl(h) ? h : ""; } catch { return ""; } };
  const urls = [...new Set(items.map((i) => href(i.link)).filter(Boolean))];
  const res = {};
  await Promise.all(urls.map(async (u) => { res[u] = await checkLink(u, name, allowed.has(normUrl(u))); }));
  items.forEach((i) => {
    const h = href(i.link), r = res[h];
    if (r && r.ok) { i.link = h; i.linkNote = r.note; } else { i.link = ""; i.linkNote = ""; }
  });
}
async function getCachedCompany(name) {
  const { companyCache = {} } = await chrome.storage.local.get("companyCache");
  const e = companyCache[name.toLowerCase()];
  return e && Date.now() - e.ts < CACHE_DAYS * 864e5 ? e.data : null;
}
async function setCachedCompany(name, data) {
  const { companyCache = {} } = await chrome.storage.local.get("companyCache");
  companyCache[name.toLowerCase()] = { ts: Date.now(), data };
  const keys = Object.keys(companyCache);
  if (keys.length > 50) keys.sort((a, b) => companyCache[a].ts - companyCache[b].ts).slice(0, keys.length - 50).forEach((k) => delete companyCache[k]);
  await chrome.storage.local.set({ companyCache });
}
async function fetchCompanyInfo(name, analysis, page, onWait) {
  const { searchModel } = await chrome.storage.local.get("searchModel");
  const model = searchModel || DEFAULT_SEARCH_MODEL;
  const body = {
    model, temperature: 0.2, max_tokens: 2500,
    messages: [
      { role: "system", content: COMPANY_SYSTEM },
      { role: "user", content: `Company: ${name}\nJob title: ${analysis.job_title || ""}\nJob page URL: ${page.url}\nLocation hint: ${analysis.company_info?.location || ""}\nPosting excerpt:\n${page.text.slice(0, 2000)}` },
    ],
  };
  if (model.includes("gpt-oss")) {          // built-in web search for GPT-OSS models
    body.tools = [{ type: "browser_search" }];
    body.reasoning_effort = "low";
  }
  const data = await withRetry(() => groqRequest(body), onWait);
  const msg = data.choices?.[0]?.message || {};
  // URLs that the search tool itself returned (if Groq includes them) are trusted without a fetch.
  const allowed = new Set();
  (JSON.stringify(msg.executed_tools || []).match(/https?:\/\/[^\s"'<>\\)\]]+/g) || [])
    .forEach((u) => { const k = normUrl(u); if (k) allowed.add(k); });
  const p = parseJson(msg.content || "");

  const findings = (p.findings || []).slice(0, 6).map((f) => ({
    text: plain(f.text),
    type: ["positive", "negative", "neutral"].includes(f.type) ? f.type : "neutral",
    link: String(f.source || ""),
  })).filter((f) => f.text);
  const flags = (p.red_flags || []).slice(0, 6).map((f) => ({
    flag: plain(f.flag), evidence: plain(f.evidence), link: String(f.source || ""),
  })).filter((f) => f.flag);
  const site = { link: String(p.website || "") };
  await verifyLinks([...findings, ...flags, site], name, allowed);

  const verified = [...findings, ...flags, site].some((i) => i.link && !i.linkNote);
  let level = ["low", "medium", "high", "unknown"].includes(p.risk_level) ? p.risk_level : "unknown";
  if (!findings.length && !flags.length) level = "unknown";
  if (level === "low" && !verified) level = "unknown";   // never reassure without a checked source
  return {
    name, level, verified, reason: plain(p.risk_reason),
    summary: plain(p.summary), industry: plain(p.industry), size: plain(p.size_or_stage),
    website: site.link, findings, flags,
  };
}
async function checkCompany(analysis, page, id) {
  const local = localRedFlags(page.text);
  const name = (analysis.company || "").trim();
  if (!name || /^(not mentioned|company|unknown|n\/a)$/i.test(name)) {
    renderCompany(null, local, "The company name was not found on this page, so the web check was skipped.", analysis);
    return null;
  }
  renderCompany(null, local, `Searching the web for ${name}...`, analysis);
  try {
    let data = await getCachedCompany(name);
    if (!data) {
      data = await fetchCompanyInfo(name, analysis, page, (s) => {
        if (id === runId) renderCompany(null, local, `Rate limit reached. Retrying the company check in ${s}s...`, analysis);
      });
      if (data.level !== "unknown") await setCachedCompany(name, data);
    }
    if (id === runId) { renderCompany(data, local, "", analysis); if (current) current.company = data; }
    return data;
  } catch (e) {
    if (id === runId) renderCompany(null, local, "Company web check unavailable: " + e.message, analysis);
    return null;
  }
}

/* ---------- skills checklist + LaTeX tailoring ---------- */
function renderTailorBox(analysis) {
  const box = $("tailorBox");
  box.replaceChildren();
  box.hidden = false;
  box.appendChild(el("h2", "", "Tailor my LaTeX resume"));
  box.appendChild(el("p", "hint", "Tick only the skills you really have. They will be added to your Skills section. Nothing is invented, and the resume is only changed when you click the button."));

  const list = el("div");
  list.id = "skillList";
  const missing = (analysis.missing_skills || []).slice(0, 15);
  missing.forEach((s) => {
    const row = el("div", "skill-row");
    const lab = el("label", "chk");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.skill = plain(s);
    lab.append(cb, document.createTextNode(" " + plain(s)));
    const note = document.createElement("input");
    note.type = "text";
    note.className = "skill-note";
    note.placeholder = "Where did you use it? (optional)";
    row.append(lab, note);
    list.appendChild(row);
  });
  if (!missing.length) list.appendChild(el("p", "hint", "No missing skills were found."));
  box.appendChild(list);

  const lab = el("label", "", "Other skills from the job that you have (comma separated)");
  lab.htmlFor = "extraSkills";
  const extra = document.createElement("input");
  extra.type = "text"; extra.id = "extraSkills";
  const btn = el("button", "primary", "Suggest resume edits");
  btn.id = "tailorBtn";
  btn.style.marginTop = "10px";
  const st = el("div", "status"); st.id = "tailorStatus";
  const out = el("div"); out.id = "tailorOut";
  box.append(lab, extra, btn, st, out);
  btn.addEventListener("click", runTailor);
}
function collectSkills() {
  const found = [];
  document.querySelectorAll("#skillList .skill-row").forEach((row) => {
    const cb = row.querySelector("input[type=checkbox]");
    if (cb && cb.checked) found.push({ skill: cb.dataset.skill, note: row.querySelector(".skill-note").value.trim() });
  });
  ($("extraSkills").value || "").split(",").map((s) => s.trim()).filter(Boolean)
    .forEach((s) => found.push({ skill: s, note: "" }));
  return found;
}
const TAILOR_SYSTEM = `You tailor a LaTeX resume to one job. You do NOT rewrite the whole file. You return a list of small edits that a program applies by exact find-and-replace.
RULES:
- FIND must be copied exactly, character for character, from the LaTeX code (one line or a few consecutive lines, for example one bullet or the skills line). It must appear only once.
- REPLACE must keep all LaTeX commands, braces and structure. Change only the wording, order or emphasis of the text.
- Use only facts that are in the resume plus the CONFIRMED SKILLS list. Never invent tools, projects, employers, dates or numbers. A confirmed skill may be added to the Skills section. Mention it inside a bullet only if the user gave a "used in" note, and then only as that note describes.
- Special LaTeX characters in new text must be escaped (\\& \\% \\# \\_).
- Use the job keywords naturally so an ATS can find them. Keep each line about the same length so the resume stays on one page.
- At most 10 edits, most important first. If nothing should change, return no edits.
OUTPUT FORMAT (plain text only: no markdown fences, no JSON):
===EDIT===
SECTION: <section name>
REASON: <one short sentence>
---FIND---
<exact text from the resume>
---REPLACE---
<new text>
===END===
Repeat the block for each edit.`;

async function runTailor() {
  const btn = $("tailorBtn"), out = $("tailorOut");
  out.replaceChildren();
  const { latex } = await chrome.storage.local.get("latex");
  if (!latex) { setStatus("Save your LaTeX resume first (in the Your resume section).", true, "tailorStatus"); return; }
  if (!current) return;
  const confirmed = collectSkills();
  const { analysis } = current;
  const prep = prepLatexBody(latex, MAX_LATEX_CHARS);
  latexTruncated = prep.truncated;
  const skillsText = confirmed.length
    ? confirmed.map((c) => `- ${c.skill}${c.note ? ` (used in: ${c.note})` : ""}`).join("\n")
    : "(none)";
  btn.disabled = true;
  try {
    setStatus("Asking the model for edits...", false, "tailorStatus");
    const content = await withRetry(
      () => callGroq([
        { role: "system", content: TAILOR_SYSTEM },
        { role: "user", content: `JOB TITLE: ${analysis.job_title}\nCOMPANY: ${analysis.company}\nJOB SUMMARY: ${analysis.jd_summary || ""}\nJOB KEYWORDS: ${(analysis.jd_keywords || []).join(", ")}\n\nCONFIRMED SKILLS (the candidate really has these):\n${skillsText}\n\nLATEX RESUME (body only):\n${prep.text}` },
      ], { maxTokens: 3000 }),
      (s) => setStatus(`Groq free-tier limit reached. Retrying in ${s}s...`, false, "tailorStatus")
    );
    edits = parseEdits(content).map((e) => locate(latex, e));
    renderEdits(latex, out);
    setStatus(edits.length ? "Review the edits below, untick any you do not want." : "The model suggested no edits for this job.", false, "tailorStatus");
  } catch (e) {
    setStatus(e.message, true, "tailorStatus");
  } finally {
    btn.disabled = false;
  }
}
function renderEdits(latex, out) {
  out.replaceChildren();
  if (latexTruncated) out.appendChild(el("p", "warn", "Your LaTeX is long, so only the first part was sent to the model. Later parts could not be edited."));
  if (!edits.length) return;
  edits.forEach((e) => {
    const card = el("div", "edit-card");
    const head = el("label", "chk");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = e.status === "ok";
    cb.disabled = e.status !== "ok";
    e.cb = cb;
    head.append(cb, el("strong", "", " " + plain(e.section)));
    card.appendChild(head);
    if (e.reason) card.appendChild(el("div", "why", plain(e.reason)));
    if (e.status === "notfound") card.appendChild(el("div", "warn", "This text was not found in your LaTeX, so it will be skipped."));
    if (e.status === "ambiguous") card.appendChild(el("div", "warn", "This text appears more than once, so it will be skipped."));
    card.appendChild(el("div", "hint", "Before"));
    card.appendChild(el("pre", "before", e.find));
    card.appendChild(el("div", "hint", "After"));
    card.appendChild(el("pre", "after", fixEscapes(e.find, e.replace)));
    out.appendChild(card);
  });
  const buildBtn = el("button", "primary", "Build tailored LaTeX");
  const res = el("div");
  buildBtn.addEventListener("click", () => buildResult(latex, res));
  out.append(buildBtn, res);
}
function buildResult(latex, res) {
  res.replaceChildren();
  const chosen = edits.filter((e) => e.status === "ok" && e.cb && e.cb.checked);
  if (!chosen.length) { res.appendChild(el("p", "warn", "No edits are selected.")); return; }
  const r = applyEdits(latex, chosen);
  res.appendChild(el("p", "hint", `${r.applied} edit(s) applied${r.skipped ? `, ${r.skipped} skipped because they overlapped` : ""}.`));
  checkLatex(latex, r.text).forEach((w) => res.appendChild(el("p", "warn", w)));
  const ta = document.createElement("textarea");
  ta.className = "code"; ta.rows = 12; ta.readOnly = true; ta.value = r.text;
  const row = el("div", "btn-row");
  const copy = el("button", "secondary", "Copy");
  const dl = el("button", "secondary", "Download .tex");
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(r.text); }
    catch { ta.select(); document.execCommand("copy"); }
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  });
  dl.addEventListener("click", () => {
    const slug = (current?.analysis?.company || "job").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "job";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.text], { type: "text/plain" }));
    a.download = `resume_${slug}.tex`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  row.append(copy, dl);
  res.append(ta, row, el("p", "note", "Paste this into Overleaf, compile it, and check that the PDF still looks right and fits one page before you apply."));
}

/* ---------- contact emails (read from live pages only, never guessed) ---------- */
const mxCache = new Map();
const NOT_COMPANY_SITE = /(^|\.)(linkedin|naukri|indeed|glassdoor|instahyre|foundit|monster|ziprecruiter|wellfound|angel|facebook|instagram|twitter|x|youtube|google)\.[a-z.]+$/;

async function mxLookup(domain) {
  if (mxCache.has(domain)) return mxCache.get(domain);
  let verdict = null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { accept: "application/dns-json" }, signal: ctl.signal });
    verdict = mxVerdict(await r.json());
  } catch { verdict = null; }
  finally { clearTimeout(timer); }
  mxCache.set(domain, verdict);
  return verdict;
}
async function fetchPage(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(url, { signal: ctl.signal, credentials: "omit", redirect: "follow" });
    if (!r.ok) return null;
    return { url: r.url || url, text: (await r.text()).slice(0, 500000) };
  } catch { return null; }
  finally { clearTimeout(timer); }
}
const SITE_PATHS = ["/", "/contact", "/contact-us", "/careers", "/jobs", "/about", "/about-us", "/team"];
async function crawlSite(host) {
  const base = "https://" + host;
  const pages = (await Promise.all(SITE_PATHS.map((p) => fetchPage(base + p)))).filter(Boolean);
  const found = [], seen = new Set();
  pages.forEach((pg) => {
    const h = hostFromUrl(pg.url);
    if (!h || !emailDomainMatches("x@" + h, host)) return;   // redirected to another site: ignore
    if (seen.has(pg.url)) return;
    seen.add(pg.url);
    extractEmails(pg.text).forEach((e) => found.push({ email: e, source: "company website", url: pg.url }));
  });
  return { found, pages: seen.size };
}
function emailsFromPage(page) {
  const out = [...extractEmails(page.fullText || page.text)];
  (page.mailtos || []).forEach((m) => {
    let d = m; try { d = decodeURIComponent(m); } catch {}
    extractEmails(d).forEach((e) => out.push(e));
  });
  (page.cf || []).forEach((h) => extractEmails(cfDecode(h)).forEach((e) => out.push(e)));
  return [...new Set(out)];
}
function pickCompanyHost(data, postFound) {
  if (data && data.website) {
    const h = hostFromUrl(data.website);
    if (h && !NOT_COMPANY_SITE.test(h)) return h;
  }
  const own = pickContacts(postFound, null).find((c) => c.kind !== "free");   // domain of a non-free address in the post
  return own ? own.email.split("@")[1] : null;
}
async function finalizeContacts(found, host) {
  const list = pickContacts(found, host);
  await Promise.all([...new Set(list.map((c) => c.email.split("@")[1]))].map((d) => mxLookup(d)));
  const kept = [], dropped = [];
  list.forEach((c) => {
    const v = mxCache.get(c.email.split("@")[1]);
    (v === false ? dropped : kept).push({ ...c, mx: v });
  });
  return { kept, dropped };
}
function renderContacts({ list, note = "", warnings = [], dropped = 0, busy = false }) {
  const box = $("contactBox");
  box.hidden = false;
  box.replaceChildren(el("h2", "", "Contact emails"));
  warnings.forEach((w) => box.appendChild(el("p", "warn", w)));
  if (note) box.appendChild(el("div", "hint", note));
  const groups = [["hr", "Recruiting or HR"], ["general", "General company address"],
    ["person", "Named people"], ["free", "Free email address (be careful)"]];
  groups.forEach(([kind, title]) => {
    const items = list.filter((c) => c.kind === kind);
    if (!items.length) return;
    box.appendChild(el("h3", "", title));
    items.forEach((c) => {
      const d = el("div", "contact");
      d.appendChild(el("div", "addr", c.email));
      const meta = el("div", "meta", c.source === "job post" ? "Found in the job post " : "Found on the company website ");
      if (c.source !== "job post" && c.url) meta.appendChild(linkEl(c.url));
      d.appendChild(meta);
      if (c.mx === true) d.appendChild(el("span", "badge ok", "mail server found"));
      else if (c.mx === null && c.mx !== undefined) d.appendChild(el("span", "badge bad", "mail server not checked"));
      if (c.domainMatch === false) d.appendChild(el("span", "badge bad", "domain differs from the company website"));
      if (c.kind === "free") d.appendChild(el("div", "warn", "Free email addresses are common in scam postings. Verify the company first."));
      const use = el("button", "secondary", "Use for email");
      use.addEventListener("click", () => {
        $("emailTo").value = c.email;
        use.textContent = "Selected";
        $("emailBox").scrollIntoView({ block: "nearest" });
      });
      d.appendChild(use);
      box.appendChild(d);
    });
  });
  if (!list.length && !busy) {
    box.appendChild(el("p", "", "No recruiter or HR email was found on the job post or on the company website. Many companies do not publish one. You can type an address in the Cold email box yourself."));
  }
  if (dropped) box.appendChild(el("p", "hint", `${dropped} address(es) were removed because their domain has no mail server.`));
  box.appendChild(el("p", "note", "Addresses are read from live pages only. They are never guessed or recalled by an AI model. The extension checks that the domain has a mail server, but nobody can confirm that the mailbox is still monitored."));
}
async function runContacts(analysis, page, id, companyPromise) {
  const warnings = [];
  const age = postingAgeWarning(page.fullText);
  if (age) warnings.push(age);
  if (postingClosed(page.fullText)) warnings.push("This posting may be closed, so any contact below may no longer be used.");
  const postFound = emailsFromPage(page).map((e) => ({ email: e, source: "job post", url: page.url }));
  renderContacts({ list: pickContacts(postFound, null), warnings, busy: true, note: "Looking for the company website..." });
  const data = await companyPromise.catch(() => null);
  if (id !== runId) return;
  const host = pickCompanyHost(data, postFound);
  const found = [...postFound];
  let note;
  if (host) {
    renderContacts({ list: pickContacts(postFound, host), warnings, busy: true, note: `Reading pages on ${host}...` });
    const crawl = await crawlSite(host);
    if (id !== runId) return;
    found.push(...crawl.found);
    note = `Checked the job post and ${crawl.pages} page(s) on ${host}.`;
  } else {
    note = "The company website could not be identified, so only the job post was checked.";
  }
  const { kept, dropped } = await finalizeContacts(found, host);
  if (id !== runId) return;
  renderContacts({ list: kept, warnings, note, dropped: dropped.length });
}

/* ---------- cold email ---------- */
const EMAIL_SYSTEM = `You write short, honest job-application emails for a candidate.
RULES:
- Use only facts from the RESUME and the CONFIRMED SKILLS list. Never invent experience, numbers, employers, referrals or relationships. Never say the candidate was referred by, or has spoken to, anyone.
- Mention the company only using the JOB SUMMARY or the COMPANY FACTS. Do not praise the company with facts you were not given.
- Write ONLY the body paragraphs for the email: no greeting, no sign-off, no subject line inside the body.
- Email body: 90 to 130 words in at most 3 short paragraphs. (1) The role and why the candidate fits, naming 2 or 3 strengths from the resume that match the job keywords. (2) One concrete project or achievement from the resume. (3) A clear, polite ask, such as being considered or a short chat. Say that the resume is attached.
- Avoid clichés such as "I hope this email finds you well", "passionate" and "dynamic". No exaggeration.
- Plain text only: no markdown, no asterisks, no bullet symbols.
OUTPUT FORMAT (exactly):
SUBJECT_1: <clear subject, under 9 words, includes the job title>
SUBJECT_2: <another option>
SUBJECT_3: <another option>
---EMAIL---
<body paragraphs>
---FOLLOWUP---
<40 to 60 words, body only: a polite reminder to send about a week later>
---LINKEDIN---
<connection note under 280 characters, starting with "Hi <name>," if a recipient name was given, otherwise "Hi,">`;

async function copyText(text, ta) {
  try { await navigator.clipboard.writeText(text); }
  catch { if (ta) { ta.select(); document.execCommand("copy"); } }
}
function prepareEmailBox(analysis) {
  $("emailBox").hidden = false;
  $("emailOut").replaceChildren();
  setStatus("", false, "emailStatus");
  $("emailTo").value = "";
  $("emailName").value = sanitizeName(analysis.contact_person);
}
async function runEmail() {
  if (!current) return;
  const to = $("emailTo").value.trim();
  if (to && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(to)) { setStatus("That email address does not look valid.", true, "emailStatus"); return; }
  const { resume, userName } = await chrome.storage.local.get(["resume", "userName"]);
  if (!resume) { setStatus("Upload or paste your resume first.", true, "emailStatus"); return; }
  const { analysis, company } = current;
  const confirmed = collectSkills();
  const name = sanitizeName($("emailName").value);
  const skillsText = confirmed.length
    ? confirmed.map((c) => `- ${c.skill}${c.note ? ` (used in: ${c.note})` : ""}`).join("\n") : "(none)";
  const facts = company && company.verified && company.summary ? company.summary : "(none)";
  const btn = $("emailGen");
  btn.disabled = true;
  try {
    setStatus("Writing your email...", false, "emailStatus");
    const content = await withRetry(
      () => callGroq([
        { role: "system", content: EMAIL_SYSTEM },
        { role: "user", content: `JOB TITLE: ${analysis.job_title}\nCOMPANY: ${analysis.company}\nJOB SUMMARY: ${analysis.jd_summary || ""}\nJOB KEYWORDS: ${(analysis.jd_keywords || []).join(", ")}\nCOMPANY FACTS (checked): ${facts}\nCONFIRMED SKILLS:\n${skillsText}\nRECIPIENT: ${$("emailRole").value}\nRECIPIENT NAME: ${name || "(not known)"}\nTONE: ${$("emailTone").value}\n\nRESUME:\n${resume.slice(0, 4000)}` },
      ], { maxTokens: 1500 }),
      (s) => setStatus(`Groq free-tier limit reached. Retrying in ${s}s...`, false, "emailStatus")
    );
    const parsed = parseColdEmail(content);
    if (!parsed.body) throw new Error("The model returned an unreadable answer. Try again.");
    renderEmailOut(parsed, { name, sign: userName });
    setStatus("Read it, edit it, then open it in Gmail.", false, "emailStatus");
  } catch (e) {
    setStatus(e.message, true, "emailStatus");
  } finally { btn.disabled = false; }
}
function textArea(id, value, rows) {
  const ta = document.createElement("textarea");
  ta.id = id; ta.rows = rows; ta.value = value;
  return ta;
}
function renderEmailOut(p, ctx) {
  const out = $("emailOut");
  out.replaceChildren();
  const subjects = p.subjects.length ? p.subjects.map(plain) : [`Application for ${plain(current.analysis.job_title) || "the role"}`];

  const pick = document.createElement("select");
  pick.id = "subjectPick";
  subjects.forEach((t) => { const o = document.createElement("option"); o.value = t; o.textContent = t; pick.appendChild(o); });
  const subj = document.createElement("input");
  subj.type = "text"; subj.id = "emailSubject"; subj.value = subjects[0];
  pick.addEventListener("change", () => { subj.value = pick.value; });
  const subjLabel = el("label", "", "Subject"); subjLabel.htmlFor = "emailSubject";
  const bodyLabel = el("label", "", "Email (you can edit it)"); bodyLabel.htmlFor = "emailBody";
  const body = textArea("emailBody", assembleEmail(ctx.name, plain(p.body), ctx.sign), 12);

  const row = el("div", "btn-row");
  const gmail = el("button", "primary", "Open in Gmail");
  const copy = el("button", "secondary", "Copy email");
  gmail.style.marginTop = "8px"; gmail.style.width = "auto";
  const msg = el("p", "hint", "Remember to attach your resume before you press Send.");
  gmail.addEventListener("click", async () => {
    const g = buildGmailUrl({ to: $("emailTo").value.trim(), subject: subj.value, body: body.value });
    if (!g.bodyIncluded) {
      await copyText(body.value, body);
      msg.textContent = "The email was too long for a link, so it was copied. Paste it into the Gmail window, then attach your resume.";
    } else msg.textContent = "Gmail opened in a new tab. Attach your resume before you press Send.";
    chrome.tabs.create({ url: g.url });
  });
  copy.addEventListener("click", async () => {
    await copyText(`Subject: ${subj.value}\n\n${body.value}`, body);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy email"), 1500);
  });
  row.append(gmail, copy);
  out.append(subjLabel, pick, subj, bodyLabel, body, row, msg);

  if (p.followup) {
    const d = el("details");
    d.appendChild(el("summary", "", "Follow-up (send after about a week)"));
    const ta = textArea("followupText", assembleEmail(ctx.name, plain(p.followup), ctx.sign), 7);
    const b = el("button", "secondary", "Copy follow-up");
    b.addEventListener("click", async () => { await copyText(ta.value, ta); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy follow-up"), 1500); });
    d.append(ta, b);
    out.appendChild(d);
  }
  if (p.linkedin) {
    const d = el("details");
    d.appendChild(el("summary", "", "LinkedIn connection note"));
    const note = plain(p.linkedin).slice(0, 300);
    const ta = textArea("linkedinText", note, 4);
    const count = el("div", "count", `${note.length}/300`);
    ta.addEventListener("input", () => { count.textContent = `${ta.value.length}/300`; });
    const b = el("button", "secondary", "Copy note");
    b.addEventListener("click", async () => { await copyText(ta.value, ta); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy note"), 1500); });
    d.append(ta, count, b);
    out.appendChild(d);
  }
}
$("emailGen").addEventListener("click", runEmail);

/* ---------- analyze ---------- */
$("analyze").addEventListener("click", async () => {
  const btn = $("analyze");
  btn.disabled = true;
  const id = ++runId;
  ["results", "chatBox", "companyBox", "tailorBox", "contactBox", "emailBox"].forEach((x) => ($(x).hidden = true));
  current = null; edits = [];
  try {
    const { resume } = await chrome.storage.local.get("resume");
    if (!resume) throw new Error("Upload or paste your resume first.");
    setStatus("Reading the page...");
    const page = await readActivePage();
    if (page.text.length < 200) throw new Error("This page has too little text. Open a job posting and try again.");

    setStatus("Analyzing with Groq...");
    const content = await withRetry(
      () => callGroq([
        { role: "system", content: ANALYSIS_SYSTEM },
        { role: "user", content: `RESUME:\n${resume.slice(0, MAX_RESUME_CHARS)}\n\nPAGE URL: ${page.url}\nPAGE TITLE: ${page.title}\nPAGE TEXT:\n${page.text}` },
      ], { json: true, maxTokens: 2500 }),
      (s) => setStatus(`Groq free-tier limit reached. Retrying in ${s}s...`)
    );
    const analysis = parseJson(content);
    if (id !== runId) return;
    current = { analysis, page };
    render(analysis);
    renderTailorBox(analysis);
    setStatus(page.usedSelection ? "Done. Used your selected text." : "Done.");

    chatContext = `RESUME:\n${resume.slice(0, MAX_RESUME_CHARS)}\n\nJOB PAGE TEXT:\n${page.text.slice(0, MAX_CHAT_JD_CHARS)}\n\nEARLIER ANALYSIS:\n${JSON.stringify(analysis).slice(0, 2500)}`;
    chatHistory = [];
    $("chatLog").replaceChildren();
    $("chatBox").hidden = false;

    const companyPromise = checkCompany(analysis, page, id);   // background: fills the Company check box
    prepareEmailBox(analysis);
    runContacts(analysis, page, id, companyPromise);            // background: fills the Contact emails box
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- follow-up chat ---------- */
async function sendChat() {
  const input = $("chatInput");
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  $("chatLog").appendChild(el("div", "msg user", q));
  const pending = el("div", "msg bot", "Thinking...");
  $("chatLog").appendChild(pending);
  $("chatSend").disabled = true;
  try {
    chatHistory.push({ role: "user", content: q });
    const answer = await callGroq([
      { role: "system", content: CHAT_SYSTEM + "\n\n" + chatContext },
      ...chatHistory.slice(-6),
    ]);
    chatHistory.push({ role: "assistant", content: answer });
    renderRich(pending, answer);
  } catch (err) {
    pending.textContent = err.message;
    chatHistory.pop();
  } finally {
    $("chatSend").disabled = false;
    pending.scrollIntoView({ block: "nearest" });
  }
}
$("chatSend").addEventListener("click", sendChat);
$("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

loadState();
