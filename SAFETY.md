# How this extension avoids hammering your school's servers

You asked for two things that pull against each other: get enough data to be genuinely
useful, and don't generate traffic that gets you noticed. Here is exactly how the
extension resolves that, so you can check the claims rather than trust them.

## 1. Most data costs zero extra requests

The default path is **passive capture**. A script runs in your portal tab and watches the
responses the Campus app *already requested* while you click around. It copies the JSON out
of responses that have already arrived and hands them to the extension.

No extra connection. No duplicate request. From the server's perspective, a session where
this extension is installed is byte-for-byte identical to one where it isn't.

This is why the dashboard nudges you to "open Grades once" instead of fetching for you —
one page view you were going to make anyway is cheaper than any request the extension
could make.

## 2. When it does crawl, it stays inside a hard budget

Passive capture can't see pages you never open, which is usually the transcript and
sometimes per-class assignment detail. **Fetch my data** fills those in. Every request goes
through one function — the Governor in `src/content/bridge.js` — and these limits are
enforced there, not in the planner:

| Limit | Default | Why |
|---|---|---|
| Method | GET only | The extension can never change anything in your record |
| Origin | The exact tab you're signed into | No cross-district, no third-party |
| Concurrency | 1 | Never a burst |
| Minimum gap | 3s + up to 1.5s random jitter | Slower than a person clicking, and not metronomic |
| Per round | 14 | One planning pass |
| Per page visit | 25 | Reload required to get more |
| **Per day** | **100** | Hard ceiling across every tab |
| Tab must be visible | yes | No background activity while you're elsewhere |
| Trigger | A button you pressed | Never on a timer, never on startup |

There is no `alarms` permission in the manifest. The extension **cannot** poll your school
on a schedule even if it wanted to.

For scale: 100 requests spread over a day is fewer than a student refreshing their grades
during lunch. A round of 14 takes about a minute of wall-clock because of the spacing.

## 3. It stops at the first sign the server is unhappy

| Server says | Extension does |
|---|---|
| `429` or `503` | Stops the whole run, honours `Retry-After`, otherwise pauses **6 hours** |
| `401` or `403` | Stops immediately, tells you to sign in. Never retries, never touches an auth endpoint |
| Redirect to a login page | Same — stops, never re-authenticates |
| `404` / `400` / `405` | Writes that URL down as dead and **never requests it again, ever** |
| `5xx` three times in a row | Circuit breaker: 6-hour cooldown |
| Tab hidden or navigated away | Aborts mid-run |

The 404 rule matters most. The thing that actually looks like an attack is endpoint
enumeration — hundreds of 404s as something guesses at paths. Because dead URLs are
remembered permanently per district, the extension's 404 count converges to near zero after
the first run and stays there.

## 4. It learns your district instead of guessing at it

The endpoint paths are the ones community reference implementations have confirmed against
live districts, not guesses. The only thing inferred is your district's path prefix, read
from URLs your portal already used. That makes the candidate set one or two URLs per kind
rather than a combinatorial sweep.

On top of that, `displayOptions` returns your district's ~90-flag feature allow-list. Modules
your district has switched off are never requested at all, so a disabled feature costs zero
requests instead of a 404. Bootstrapping now takes **one** request, not nine.

Every URL requested appears in the dashboard's **Requests** tab with its status and timing.
Nothing is hidden from you.

## 5. It never handles your credentials

The extension has no login code, stores no password, and cannot authenticate. It relies
entirely on the session cookie your browser already holds because *you* signed in. If the
session expires, it stops and asks you to sign in yourself.

The passive observer refuses any response whose URL looks like authentication — login,
logout, password, oauth, token, saml, sso, mfa, otp, verify, session.

**A URL blocklist is not sufficient on its own, and this was found the hard way.** A real
district returned the signed-in user's account record — containing `salt`, `totpToken`,
`sessionID` and password-state flags — from a path that looked perfectly ordinary and
matched none of those words. The observer copied it, because nothing was checking what was
actually in the response.

So responses are now inspected by content as well:

- The content script drops any body carrying credential-shaped JSON keys before it leaves
  the page, using a cheap high-signal check in the hot path.
- The service worker repeats the check, word-aware, before anything reaches storage — so a
  payload cannot slip through via an older content script still running in an open tab.
- Structure dumps used for debugging withhold credential-shaped key names entirely,
  reporting only a count of how many were withheld.
- Key names are compared word by word after splitting camelCase and snake_case, never as
  substrings, so `mapping` and `pointsPossible` are not mistaken for credentials.
- On upgrade, any structure recorded by an earlier build that contains such keys is purged
  from storage.

Being over-eager here costs a little grade data. Being under-eager copies secrets, so the
checks are deliberately tilted toward dropping too much.

## 6. The honest part

Technical politeness is only half the question, and code can't settle the other half.

Many districts have an acceptable-use policy that covers automated access to school
systems. Some prohibit it outright, some don't mention it, some only care about volume.
Accounts get flagged for *policy* reasons as often as technical ones, and no rate limit
protects you from a rule that says "don't do this at all."

Two practical suggestions:

- **Read your district's AUP** before using the fetch feature. Passive capture is much
  harder to object to — it reads your own screen's data and generates no traffic — but
  "reads my own grades faster" is not a universal defence.
- **If you're unsure, ask.** A counsellor or IT admin saying "sure, that's fine" is worth
  more than any setting in this extension. Framing matters: "an extension that analyses my
  own grades locally" lands very differently than "a scraper."

You can also run the extension in pure passive mode forever: never press **Fetch my data**,
and it will never originate a single request. You'll get everything you actually browse,
which for grades and schedule is usually everything you need.

## 7. Things this extension will not do

- Access anyone's data but your own signed-in account
- Send any request other than GET
- Automate login, password entry, or session refresh
- Run on a timer or in the background
- Retry past a stop signal
- Send your grades anywhere except the AI provider you configured, when you press Analyze
