# IC Insight

[![test](https://github.com/elijahmanlockedin112/ic-insight/actions/workflows/test.yml/badge.svg)](https://github.com/elijahmanlockedin112/ic-insight/actions/workflows/test.yml)

A Chrome extension that reads your own Infinite Campus grades, schedule and transcript,
computes what's actually going on with them, and coaches you toward a goal you set — using
an AI model and API key you choose.

Everything stays on your machine except the analysis request itself, which goes only to the
provider you configured, only when you press Analyze.

---

## What it actually does

**Reads your data without pestering your school's servers.** A script in your portal tab
watches the responses Campus already loaded as you click around and copies the data out.
That costs zero extra requests. For pages you rarely open — usually the transcript — there's
a **Fetch my data** button that makes a small number of heavily rate-limited GET requests.
See [SAFETY.md](SAFETY.md) for every limit and stop condition.

**Does the math locally, not with the AI.** Course percentages, weighted and unweighted GPA,
cumulative GPA by year, points needed for the next letter, the exact grade effect of making
up each missing assignment, per-category drag, and assignment-level trend slopes are all
computed in `src/common/analysis.js` before the model sees anything. The AI is told to treat
those numbers as settled and never recompute them — language models are worse at arithmetic
than a spreadsheet, and a coach that gets your percentage wrong is worse than no coach.

**Coaches against *your* goal.** "Keep straight A's", "Ivy / T20", "state flagship", "raise
my GPA to X", "just pass and stay eligible", or something custom — plus your grade level,
realistic study hours, what you're good at, what trips you up, and anything else shaping
your week. A student aiming at an Ivy and a student trying to stay eligible get genuinely
different advice from the same gradebook.

**Finds assignment-level patterns.** Not just "your Chem grade is a 71" but "your exam scores
went 82, 64, 58 while your labs stayed at 88 — the slide is entirely in exams, which are 45%
of the grade, and one missing lab is worth 4.2 points."

---

## Install

1. Clone or download this folder.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. **Load unpacked** → select the `ic-insight` folder.
4. The options page opens. Work through it top to bottom.

Requires Chrome 116+. If you regenerate the icons: `node tools/make-icons.mjs`.

## Set up

**1. Pick a model.** Anthropic, OpenAI, Google or OpenRouter. Paste your key and press
*Save & load models* to pull the live model list for that provider. Anthropic defaults to
`claude-opus-5` with adaptive thinking; effort is adjustable if you want to trade depth for
cost.

**2. Set your goal.** This is the part that makes the output yours. Be honest — a vague goal
gets vague advice.

**3. Check the grading scale.** Standard (A = 93+) or flat 10-point (A = 90+), and whether
your school weights AP/honours. Course rigor is guessed from the title; fix any wrong guess
per course on the dashboard.

**4. Your district's address.** Works out of the box on `*.infinitecampus.org`. If your
district self-hosts, add the origin in section 6 and approve the Chrome prompt.

## Use

1. Sign into Infinite Campus and click through Grades, Schedule and Reports once. That alone
   captures most of your data for free.
2. Open the extension → **Fetch my data** to fill gaps like your transcript.
3. **Open dashboard** for GPA, risks, ranked actions and per-course detail.
4. **Coach** tab → *Analyze my grades*. Ask follow-ups in the same box; they reuse the same
   brief instead of re-sending everything.

---

## Privacy

| | |
|---|---|
| Where grades live | `chrome.storage.local` on this computer only |
| Where they're sent | Only to the AI provider you picked, only on Analyze |
| Name redaction | On by default — your name, student ID and teacher names are stripped first |
| Your API key | Stored locally, sent only to its own provider, excluded from exports |
| Backend server | There isn't one |

`chrome.storage.local` is **not encrypted at rest**. On a shared or school-managed computer,
assume someone with admin access could read it. Use a scoped API key you're willing to
revoke.

---

## How it's put together

```
manifest.json           MV3. No "alarms" permission, so it cannot poll on a timer.
src/content/
  interceptor.js        MAIN world. Wraps fetch/XHR to observe responses. Makes no
                        requests. Refuses to read anything auth-shaped.
  bridge.js             ISOLATED world. The Governor: the only code that may originate
                        a request to a school server, and where every limit is enforced.
src/background/
  service-worker.js     Storage, crawl orchestration, model calls, message routing.
  crawler.js            Plans what to ask for. Derives your district's URL shape from
                        observed traffic; remembers dead paths permanently.
  providers.js          Anthropic / OpenAI / Google / OpenRouter, streaming, one interface.
  prompt.js             Redaction, brief construction, goal-aware system prompt.
src/common/
  normalize.js          IC JSON -> canonical model, by structural shape rather than by
                        hardcoded response paths (districts differ too much for those).
  analysis.js           All the math. Nothing here calls a model.
  storage.js, util.js
src/ui/                 popup, options, dashboard
test/run.mjs            53 checks over synthetic IC-shaped payloads.
```

## Development

No build step and no dependencies — the `src/` tree is exactly what Chrome loads. Node is
only used for the checks and the release zip.

```bash
npm run verify   # check it will load unpacked, then run the tests
npm run check    # syntax, manifest references, MV3 CSP rules, missing files
npm test         # 53 assertions over synthetic IC-shaped payloads
npm run icons    # regenerate icons/*.png
npm run build    # dist/ic-insight-v<version>.zip, runtime files only
```

`npm run check` catches the things that make Chrome refuse to load an extension: a manifest
reference to a file that isn't there, an inline `<script>` or `onclick=` attribute that MV3's
CSP blocks, a malformed version string. It also asserts the `alarms` permission is *absent*,
so a future change can't quietly hand the extension the ability to poll a school server on a
timer.

`npm test` covers parsing, weighted and total-points grade computation, the points-needed
inversion, missing-work impact, GPA from transcript, redaction, and the crawler's dead-path
rule — everything that doesn't need a browser. CI runs both on every push.

After editing anything under `src/`, press the reload icon on `chrome://extensions`. Changes
to content scripts also need a refresh of the Infinite Campus tab.

---

## Limitations worth knowing

**The endpoint list is educated guessing.** IC API paths vary by district and release, and
these were written without access to a live instance. The design absorbs that: the crawler
learns your real base path from traffic your portal generates, and each wrong guess costs
exactly one 404 that's then remembered forever. But your first **Fetch my data** may find
less than a later one, after the extension has watched you browse.

**Weighted GPA is a local convention.** The +1.0 / +0.5 rule here is common, not universal.
If your school does something else, the unweighted number is the trustworthy one.

**IC's own percentage may differ slightly** from the computed one — teachers drop lowest
scores, apply curves, or exclude assignments in ways the API doesn't always expose. Where
both exist, the dashboard shows what it computed and the report keeps IC's reported score
alongside it.

**Trends need data.** A course with fewer than three graded assignments reports
`insufficient-data` rather than inventing a direction.

**Nobody can predict admissions.** The goal presets shape priorities and tolerance for a B.
They don't estimate your chances anywhere, and the system prompt tells the model not to.

---

## Before you use the crawler

Check your district's acceptable-use policy. Rate limiting handles the technical question;
it can't handle a rule that says don't do this at all. Passive capture — which generates no
traffic and only reads your own screen's data — is a much easier thing to justify, and you
can run in that mode permanently by simply never pressing **Fetch my data**.
