# Sourcing refinement loop

A small recruiter tool. You type who you are looking for, in plain language. The app turns that sentence into hard filters and one fit rubric, ranks people from a local file of 48 profiles, and lets you react in chat until you freeze the search.

There is no login and nothing is saved. Refresh the page and the search is gone.

## What you see

1. A single search box. Example: "RDS developers with 4–7 years who have worked at startups, based in Bangalore."
2. The app shows that it is thinking, then puts the filters and the rubric on the right. You can edit both.
3. It shows the top 5 profiles. Each card says why that person matched, using real fields from their profile.
4. You reply in the box ("1 is too junior, 2 and 4 are right") or press Yes / No on the cards. The app says what it changed, runs the search again, and shows a new set. The current filters and rubric stay on screen.
5. Freeze locks the filters, the rubric, and the shortlist.

Empty results, a slow model, a rate limit, and a bad model reply each have their own state. The filters are not cleared when a later call fails.

## How it works

The browser holds the session. Each request sends the current filters, the rubric, and the profiles on screen. The server does not store searches.

Three model calls, all server-side, all checked as JSON before the UI uses them:

| Step | What the model does | What the code does |
| --- | --- | --- |
| Interpret | Writes filters and one rubric paragraph from the sentence | Nothing is filtered yet |
| Search | Scores at most 15 people, 0–100, with a short reason | Applies the filters to `profiles.json` first. If nobody passes, the model is not called |
| Refine | Updates the filters and rubric from your feedback, and says what changed | Runs the same search again |

`retrieve()` in `server.py` is the only function that reads the profile file. `pre_rank()` then keeps at most 15 people. The screen shows the top 5, and says how many matched versus how many were scored.

An explanation has to mention a real skill, company, title, or location from that profile. If it does not, the app fills the line from those fields instead of calling the model again. If scoring itself fails, the same pre-ranked five still appear, labeled as not model-scored.

Prompts are in `prompts.py`.

The model is `gemini-3.1-flash-lite` through the Gemini Interactions API. The API key environment variable is `GEMINI_API_KEY`.

## Setup

You need Python 3.11+ and Node 20+.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm install
```

Put the key in a `.env` file in this folder (it is gitignored):

```bash
cp .env.example .env
```

`.env` contains one line:

```bash
GEMINI_API_KEY=your_key
```

You can `export GEMINI_API_KEY=your_key` instead. If both are set, the exported value wins. Restart the API after changing the key.

## Run

Two terminals, from this folder.

Terminal 1, API:

```bash
source .venv/bin/activate
uvicorn server:app --reload --port 8000 --reload-exclude node_modules --reload-exclude .venv --reload-exclude dist
```

Terminal 2, UI:

```bash
npm run dev
```

Open http://localhost:5173. The UI proxies `/api` to the API on port 8000.

## Decisions

**Prioritised.** The loop a recruiter can follow: one sentence, visible filters and one rubric, five explained profiles, chat or Yes/No, then freeze. Objective filters stay in Python so the model cannot invent who passes. Explanations have to cite the profile. Timeouts, rate limits, and malformed JSON keep the search on screen instead of crashing it.

**Cut, and why.**

- One rubric paragraph, not a list of weighted criteria. The brief asks for a rubric. Extra criteria cost tokens on every interpret, score, and refine call, and they made the side panel harder to read.
- No second scoring call when an explanation is weak. The replacement sentence is built from the profile, so the recruiter still sees a cited reason.
- No login, roles, or saving a search across refresh. The brief says to stay inside one session.
- No search cluster, queue, vector index, or score cache. The sample file is the whole pool. Embeddings would turn "4–7 years in Bangalore" into a similarity guess. Those facts belong in the filters.

**At 98 million profiles.** The loop would not change. `retrieve()` would become an index query on skills, years, location, and company type, including past companies when the scope is "any". `pre_rank()` would still send at most 15 people to the model, and the recruiter would still see 5. The next thing to add, later, is a score cache keyed by profile id and a hash of the rubric, so an unchanged rubric does not pay for the same person twice. A cache of 48 rows would not show that, so it is not here.
