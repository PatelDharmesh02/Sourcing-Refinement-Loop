# Sourcing refinement loop

A recruiter types one sentence. The app turns it into filters and a rubric, ranks a local pool of 48 profiles, and keeps refining that search from chat feedback until the recruiter freezes it.

## Setup

Python 3.11+ and Node 20+.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm install
```

Set the key, then start the API and the UI:

```bash
export GEMINI_API_KEY=your_key
uvicorn server:app --reload --port 8000 --reload-exclude node_modules --reload-exclude .venv --reload-exclude dist
```

```bash
npm run dev
```

Open http://localhost:5173. A `.env` file in this folder is also read, and it is gitignored. Copy `.env.example` if you want that instead of `export`.

The API key environment variable is `GEMINI_API_KEY`.

The model is `gemini-3.8-flash` through the Gemini Interactions API. Calls are server-side only. Structured filters, rubrics, and scores use `response_format` JSON schema, then Pydantic checks the reply.

## Decisions

The session lives in the browser: each request sends the current filters, rubric, and the profiles on screen. Refresh starts over. There is no login and no saved search.

Objective filters run in Python. The model writes filters, writes one rubric paragraph, scores a shortlist, and rewrites the filters after feedback. It never decides who passes a hard filter. A weak explanation is filled from the profile's real fields instead of calling the model again.

`retrieve()` is the only function that reads `profiles.json`. `pre_rank()` then keeps at most 15 people, and one model call scores that shortlist. The screen shows the top 5. The response includes how many matched and how many were scored.

Explanations have to mention a real skill, company, title, or location from that profile. A bad explanation is retried once, then replaced with a sentence built from the fields that actually matched. If scoring times out, is rate-limited, or comes back unusable, the filters stay and the screen shows that pre-ranked five labeled as not model-scored.

Prompts are in `prompts.py`.

### What this would be at 98 million profiles

The loop is the same. The file scan is not.

The model would still write a small filter document. `retrieve()` would send that document to a search index (skills, years, location, company type, including past companies when the scope is "any") instead of scanning a JSON file. Callers would not change. `pre_rank()` would still cap the model at 15, because an index might return tens of thousands and the model cannot read them. The recruiter would still see 4 or 5 people.

Embeddings are the wrong first pass. "4–7 years in Bangalore" is a hard constraint, not a similarity guess. Judgment stays on the rubric, and the rubric only sees the shortlist.

Not built, on purpose: a search cluster, a queue, a vector index, a score cache, login, and persistence. At full scale the next cache would be keyed by profile id plus a hash of the rubric, so an unchanged rubric does not pay for the same person twice. A cache of 48 rows would not show that, so it is left out. Facet counts like the empty-state trace would come from the index.

### What we cut

No second model, no scripted failure button, no pagination past the top 5. The failure moment in a walkthrough is a real rate limit, timeout, or bad JSON response: the search degrades, it does not go blank.
