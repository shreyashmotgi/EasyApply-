# EasyApply

Chrome extension that compares your resume with the job page you have open, checks the
company, and can tailor your Overleaf (LaTeX) resume to the job.

## Install
1. Download or clone this folder.
2. Open chrome://extensions and turn on Developer mode (top right).
3. Click "Load unpacked" and choose the job-match-helper folder.
4. Click the extension icon to open the side panel.
After updating the code, click the reload icon on the extension card.

## First-time setup
1. Get a free API key at https://console.groq.com/keys
2. Open Settings in the panel, paste the key and click Save settings.
3. Upload your resume (PDF or text). Optionally paste your Overleaf .tex code too.

## What it does
- **Match analysis:** fit score, matched and missing skills, resume suggestions.
  The score is a resume-to-posting match, not a hiring prediction.
- **Company check (automatic):** searches the web (GPT-OSS with Groq's built-in browser search) and shows a risk bar
  (low / medium / high / not enough information), findings with source links, and red
  flags with evidence. Red flags found in the posting itself (fees, deposits, WhatsApp-only
  contact, free email, "no interview") raise the risk level even if the web search finds nothing.
  Results are cached for 7 days per company. This is evidence, not a verdict.
  Always verify a company yourself before sharing documents or paying money.
- **LaTeX tailoring (on request only):** after an analysis, tick the missing skills you
  really have, click "Suggest resume edits", review each before/after change, untick any
  you do not want, then build and copy or download the new .tex.
  The model returns small find-and-replace edits (not the whole file), which saves tokens
  and keeps your template untouched. It may only use facts already in your resume plus the
  skills you ticked.
- **Contact emails:** looks for a recruiter or HR address in the job post (text, mailto links,
  Cloudflare-hidden addresses), then on the company's own website (Contact, Careers, About,
  Team pages). Addresses are read from live pages only: never guessed and never recalled by an
  AI model, so old remembered emails cannot appear. Junk (noreply, privacy, third-party
  addresses) is removed, and addresses on a domain with no mail server are dropped (checked
  through Cloudflare's public DNS service, which sees only the domain name). Old or closed
  postings get a warning. No tool can confirm a mailbox is still monitored.
- **Cold email:** writes a short email from the job, your resume and the skills you ticked,
  plus a follow-up and a LinkedIn note. "Open in Gmail" opens Gmail on the web with the
  recipient, subject and body filled in. You attach your resume and press Send yourself.
  Nothing is ever sent automatically.
- **Follow-up chat** about the job and your resume.

## Limits and notes
- Groq's free tier limits tokens per minute. If a limit is hit, the extension waits and
  retries automatically.
- Company check uses openai/gpt-oss-20b with browser search (groq/compound was retired by
  Groq on Sept 21, 2026). Web pages add tokens, so on the free tier a check can hit a rate
  limit; the extension waits and retries. Each company is cached for 7 days.
- Groq does not reliably return citations from browser search, so the extension opens every
  link the model gives and drops dead ones. Links that cannot be checked are labelled.
- Very long LaTeX files are cut to the first 12,000 characters before sending.
- Always compile the new LaTeX in Overleaf and check the PDF before applying.
- Your resume and the page text are sent to Groq to produce the results.
- The extension fetches the company's public pages from your own browser, like visiting them.

## Files
- manifest.json, background.js: extension setup
- sidepanel.html / .css / .js: the panel UI and logic
- utils.js: LaTeX edit, risk, email-finding and cold-email helpers (pure functions)
- lib/: PDF.js, used to read PDF resumes
