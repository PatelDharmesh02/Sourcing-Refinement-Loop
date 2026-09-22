import json
import os
import re
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google import genai
from google.genai.errors import APIError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

import prompts

ROOT = Path(__file__).resolve().parent
PROFILES = json.loads((ROOT / "profiles.json").read_text())
# At 98M, retrieve() is the index query. The model still only sees this many.
SCORE_CAP = 15
TOP_N = 5
MODEL = "gemini-3.1-flash-lite"

FILTER_SCHEMA = {
    "type": "object",
    "properties": {
        "skills_all": {"type": "array", "items": {"type": "string"}},
        "skills_any": {"type": "array", "items": {"type": "string"}},
        "min_years": {"type": ["integer", "null"]},
        "max_years": {"type": ["integer", "null"]},
        "locations": {"type": "array", "items": {"type": "string"}},
        "company_types": {
            "type": "array",
            "items": {"type": "string", "enum": ["startup", "scaleup", "enterprise", "agency"]},
        },
        "company_scope": {"type": "string", "enum": ["current", "any"]},
        "title_keywords": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "skills_all",
        "skills_any",
        "min_years",
        "max_years",
        "locations",
        "company_types",
        "company_scope",
        "title_keywords",
    ],
}
LOCATIONS = {
    "Bangalore",
    "Chennai",
    "Mumbai",
    "Hyderabad",
    "Delhi NCR",
    "Pune",
    "Amsterdam",
    "Berlin",
    "Remote - India",
}
LOCATION_ALIASES = {
    "bangalore": "Bangalore",
    "bengaluru": "Bangalore",
    "blr": "Bangalore",
    "chennai": "Chennai",
    "mumbai": "Mumbai",
    "bombay": "Mumbai",
    "hyderabad": "Hyderabad",
    "delhi": "Delhi NCR",
    "delhi ncr": "Delhi NCR",
    "ncr": "Delhi NCR",
    "gurgaon": "Delhi NCR",
    "gurugram": "Delhi NCR",
    "noida": "Delhi NCR",
    "pune": "Pune",
    "amsterdam": "Amsterdam",
    "berlin": "Berlin",
    "remote": "Remote - India",
    "remote india": "Remote - India",
    "remote - india": "Remote - India",
}
COMPANY_TYPES = {"startup", "scaleup", "enterprise", "agency"}
SKILL_ALIASES = {
    "rds": "aws rds",
    "aws rds": "aws rds",
    "amazon rds": "aws rds",
    "postgres": "postgresql",
    "postgresql": "postgresql",
    "node": "node.js",
    "nodejs": "node.js",
    "node.js": "node.js",
    "node js": "node.js",
    "react": "react",
    "react.js": "react",
    "reactjs": "react",
    "react js": "react",
    "next": "next.js",
    "next.js": "next.js",
    "nextjs": "next.js",
    "next js": "next.js",
    "k8s": "kubernetes",
    "kubernetes": "kubernetes",
    "golang": "go",
    "go": "go",
    "ts": "typescript",
    "typescript": "typescript",
    "js": "javascript",
    "javascript": "javascript",
    "py": "python",
    "python": "python",
    "mongo": "mongodb",
    "mongodb": "mongodb",
}


def load_local_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_local_env()


class LlmError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message


class Filters(BaseModel):
    model_config = ConfigDict(extra="ignore")
    skills_all: list[str] = Field(default_factory=list)
    skills_any: list[str] = Field(default_factory=list)
    min_years: int | None = None
    max_years: int | None = None
    locations: list[str] = Field(default_factory=list)
    company_types: list[str] = Field(default_factory=list)
    company_scope: str = "any"
    title_keywords: list[str] = Field(default_factory=list)


class QueryIn(BaseModel):
    query: str


class SearchIn(BaseModel):
    filters: Filters
    rubric: str


class ShownProfile(BaseModel):
    model_config = ConfigDict(extra="ignore")
    index: int
    id: str
    name: str
    current_title: str
    years_experience: int
    location: str
    current_company: str
    current_company_type: str
    skills: list[str] = Field(default_factory=list)
    score: int | None = None
    explanation: str = ""
    verdict: str | None = None


class RefineIn(BaseModel):
    filters: Filters
    rubric: str
    feedback: str = ""
    shown: list[ShownProfile]


class InterpretOut(BaseModel):
    filters: Filters
    rubric: str

    @field_validator("rubric")
    @classmethod
    def clean_rubric(cls, value: str) -> str:
        return value.strip()


class ScoreItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    score: int
    explanation: str

    @field_validator("score")
    @classmethod
    def clamp_score(cls, value: int) -> int:
        return min(100, max(0, int(value)))

    @field_validator("explanation")
    @classmethod
    def clean_explanation(cls, value: str) -> str:
        return value.strip()


class ScoreOut(BaseModel):
    scores: list[ScoreItem]


class RefineOut(BaseModel):
    filters: Filters
    rubric: str
    change_summary: str

    @field_validator("rubric", "change_summary")
    @classmethod
    def clean_text(cls, value: str) -> str:
        return value.strip()


def fail(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def llm_fail(error: LlmError) -> JSONResponse:
    status = {"rate_limit": 429, "timeout": 504, "malformed": 502, "config": 500, "upstream": 502}[error.code]
    return fail(status, error.code, error.message)


def dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    kept: list[str] = []
    for value in values:
        text = value.strip()
        key = text.lower()
        if text and key not in seen:
            seen.add(key)
            kept.append(text)
    return kept


def norm_skill(value: str) -> str:
    key = re.sub(r"[^a-z0-9.+#]+", " ", value.lower()).strip()
    key = re.sub(r"\s+", " ", key)
    return SKILL_ALIASES.get(key, key)


def skill_hit(needed: str, skills: list[str]) -> bool:
    target = norm_skill(needed)
    return any(norm_skill(skill) == target for skill in skills)


def usable_titles(words: list[str]) -> list[str]:
    # Drop phrases no title contains, so "RDS developer" cannot empty the pool.
    kept: list[str] = []
    for word in words:
        token = word.strip()
        if token and any(token.lower() in profile["current_title"].lower() for profile in PROFILES):
            kept.append(token)
    return kept


def normalize(filters: Filters) -> Filters:
    locations: list[str] = []
    for raw in filters.locations:
        mapped = LOCATION_ALIASES.get(raw.strip().lower())
        if mapped:
            locations.append(mapped)
    if filters.min_years is not None and filters.max_years is not None and filters.min_years > filters.max_years:
        filters.min_years, filters.max_years = filters.max_years, filters.min_years
    scope = filters.company_scope if filters.company_scope in {"current", "any"} else "any"
    return Filters(
        skills_all=dedupe(filters.skills_all)[:8],
        skills_any=dedupe(filters.skills_any)[:8],
        min_years=filters.min_years if filters.min_years is None or filters.min_years >= 0 else None,
        max_years=filters.max_years if filters.max_years is None or filters.max_years >= 0 else None,
        locations=dedupe(locations),
        company_types=dedupe([item.lower() for item in filters.company_types if item.lower() in COMPANY_TYPES]),
        company_scope=scope,
        title_keywords=usable_titles(dedupe(filters.title_keywords))[:4],
    )


def company_types_of(profile: dict, scope: str) -> set[str]:
    types = {profile["current_company_type"]}
    if scope == "any":
        types.update(job["company_type"] for job in profile["past_companies"])
    return types


def passes(profile: dict, filters: Filters, check: str) -> bool:
    if check == "skills":
        skills = profile["skills"]
        if filters.skills_all and not all(skill_hit(skill, skills) for skill in filters.skills_all):
            return False
        if filters.skills_any and not any(skill_hit(skill, skills) for skill in filters.skills_any):
            return False
        return True
    if check == "years":
        years = profile["years_experience"]
        if filters.min_years is not None and years < filters.min_years:
            return False
        if filters.max_years is not None and years > filters.max_years:
            return False
        return True
    if check == "location":
        return not filters.locations or profile["location"] in filters.locations
    if check == "company":
        if not filters.company_types:
            return True
        return bool(company_types_of(profile, filters.company_scope) & set(filters.company_types))
    title = profile["current_title"].lower()
    return not filters.title_keywords or any(word.lower() in title for word in filters.title_keywords)


def retrieve(filters: Filters) -> tuple[list[dict], list[dict]]:
    """Hard filters only. This scan is the stand-in for an index query."""
    current = PROFILES
    trace = [{"label": "Pool", "remaining": len(current)}]
    for label, check in (
        ("Skills", "skills"),
        ("Years", "years"),
        ("Location", "location"),
        ("Company", "company"),
        ("Title", "title"),
    ):
        current = [profile for profile in current if passes(profile, filters, check)]
        trace.append({"label": label, "remaining": len(current)})
    return current, trace


def cheap_score(profile: dict, filters: Filters) -> float:
    score = 0.0
    years = profile["years_experience"]
    bounds = [value for value in (filters.min_years, filters.max_years) if value is not None]
    if len(bounds) == 2:
        score += max(0, 10 - abs(years - sum(bounds) / 2))
    elif bounds:
        score += max(0, 8 - abs(years - bounds[0]))
    requested = filters.skills_all + filters.skills_any
    if requested:
        score += sum(2 for skill in profile["skills"] if any(skill_hit(need, [skill]) for need in requested))
    return score


def pre_rank(matches: list[dict], filters: Filters) -> list[dict]:
    return sorted(matches, key=lambda profile: cheap_score(profile, filters), reverse=True)[:SCORE_CAP]


def matched_skills(profile: dict, filters: Filters) -> list[str]:
    needed = filters.skills_all + filters.skills_any
    if not needed:
        return []
    return [skill for skill in profile["skills"] if any(skill_hit(need, [skill]) for need in needed)]


def local_explanation(profile: dict, filters: Filters) -> str:
    skills = matched_skills(profile, filters) or profile["skills"][:3]
    return (
        f"{profile['current_title']} at {profile['current_company']} "
        f"({profile['current_company_type']}), {profile['years_experience']} years in {profile['location']}. "
        f"Skills include {', '.join(skills)}."
    )


def cites(profile: dict, text: str) -> bool:
    haystack = text.lower()
    needles = [profile["current_company"], profile["current_title"], profile["location"], *profile["skills"]]
    needles.extend(job["company"] for job in profile["past_companies"])
    return any(len(needle) > 2 and needle.lower() in haystack for needle in needles)


def to_card(profile: dict, filters: Filters, score: int | None, explanation: str) -> dict:
    return {
        "id": profile["id"],
        "name": profile["name"],
        "current_title": profile["current_title"],
        "years_experience": profile["years_experience"],
        "location": profile["location"],
        "current_company": profile["current_company"],
        "current_company_type": profile["current_company_type"],
        "skills": profile["skills"],
        "matched_skills": matched_skills(profile, filters),
        "score": score,
        "explanation": explanation,
    }


def compact(profile: dict) -> dict:
    past = [f"{job['company']} ({job['company_type']})" for job in profile["past_companies"][:3]]
    return {
        "id": profile["id"],
        "name": profile["name"],
        "title": profile["current_title"],
        "years": profile["years_experience"],
        "location": profile["location"],
        "company": profile["current_company"],
        "company_type": profile["current_company_type"],
        "skills": profile["skills"],
        "past": past,
        "education": profile["education"],
    }


def parse_json(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    data = json.loads(cleaned)
    if not isinstance(data, dict):
        raise json.JSONDecodeError("object required", cleaned, 0)
    return data


def gemini_client() -> genai.Client:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise LlmError("config", "Set GEMINI_API_KEY and restart the server.")
    return genai.Client(api_key=key)


def response_schema(model: type[BaseModel]) -> dict:
    if model is ScoreOut:
        return {
            "type": "object",
            "properties": {
                "scores": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "score": {"type": "integer"},
                            "explanation": {"type": "string"},
                        },
                        "required": ["id", "score", "explanation"],
                    },
                }
            },
            "required": ["scores"],
        }
    if model is RefineOut:
        return {
            "type": "object",
            "properties": {
                "filters": FILTER_SCHEMA,
                "rubric": {"type": "string"},
                "change_summary": {"type": "string"},
            },
            "required": ["filters", "rubric", "change_summary"],
        }
    return {
        "type": "object",
        "properties": {"filters": FILTER_SCHEMA, "rubric": {"type": "string"}},
        "required": ["filters", "rubric"],
    }


def raise_llm(error: Exception) -> None:
    if isinstance(error, APIError) and error.code == 429:
        raise LlmError("rate_limit", "The model is rate-limited. Wait a moment and try again.") from None
    if "Timeout" in type(error).__name__:
        raise LlmError("timeout", "The model took too long. Try again.") from None
    detail = getattr(error, "message", None) or str(error)
    print(f"gemini {type(error).__name__}: {detail[:300]}", file=sys.stderr)
    raise LlmError("upstream", "The model request failed. Try again.") from None


def complete(messages: list[dict], model: type[BaseModel]) -> BaseModel:
    client = gemini_client()
    system = "\n".join(item["content"] for item in messages if item["role"] == "system")
    last_error = "empty response"
    for attempt in range(2):
        turns = [item for item in messages if item["role"] != "system"]
        if attempt:
            turns.append({
                "role": "user",
                "content": f"The previous reply was invalid: {last_error}. Return one JSON object matching the schema.",
            })
        try:
            interaction = client.interactions.create(
                model=MODEL,
                input="\n\n".join(item["content"] for item in turns),
                system_instruction=system or None,
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": response_schema(model),
                },
                generation_config={"temperature": 0.2, "thinking_level": "low"},
                store=False,
                timeout=60,
            )
        except LlmError:
            raise
        except Exception as error:
            raise_llm(error)
        try:
            return model.model_validate(parse_json(interaction.output_text or ""))
        except (json.JSONDecodeError, ValidationError) as error:
            last_error = str(error)[:400]
    raise LlmError("malformed", "The model returned a response we couldn't use.")


def score_shortlist(shortlist: list[dict], filters: Filters, rubric: str) -> list[dict]:
    scored = complete(
        [
            {"role": "system", "content": prompts.SCORE},
            {"role": "user", "content": json.dumps({"rubric": rubric, "profiles": [compact(profile) for profile in shortlist]})},
        ],
        ScoreOut,
    )
    by_id = {item.id: item for item in scored.scores}
    cards = []
    for profile in shortlist:
        item = by_id.get(profile["id"])
        if item and cites(profile, item.explanation):
            cards.append(to_card(profile, filters, item.score, item.explanation))
        else:
            cards.append(to_card(profile, filters, item.score if item else 0, local_explanation(profile, filters)))
    cards.sort(key=lambda card: card["score"] or 0, reverse=True)
    return cards[:TOP_N]


def run_search(filters: Filters, rubric: str) -> dict:
    filters = normalize(filters)
    rubric = rubric.strip()
    if not rubric:
        return fail(400, "bad_request", "Write a rubric before running the search.")
    matched, trace = retrieve(filters)
    body = {
        "filters": filters.model_dump(),
        "rubric": rubric,
        "profiles": [],
        "pool_size": len(matched),
        "scored_count": 0,
        "trace": trace,
        "scored": True,
        "warning": None,
    }
    if not matched:
        return body
    shortlist = pre_rank(matched, filters)
    body["scored_count"] = len(shortlist)
    try:
        body["profiles"] = score_shortlist(shortlist, filters, rubric)
    except LlmError as error:
        body["profiles"] = [to_card(profile, filters, None, local_explanation(profile, filters)) for profile in shortlist[:TOP_N]]
        body["scored"] = False
        body["warning"] = {"code": error.code, "message": error.message}
    return body


DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://sourcing-refinement-loop-chi.vercel.app",
]


def cors_origins() -> list[str]:
    raw = os.environ.get("CORS_ORIGINS", "").strip()
    if not raw:
        return DEFAULT_CORS_ORIGINS
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


app = FastAPI(title="Sourcing")
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.post("/api/interpret")
def interpret(body: QueryIn):
    query = body.query.strip()
    if not query:
        return fail(400, "bad_request", "Enter a search.")
    messages = [
        {"role": "system", "content": prompts.INTERPRET},
        {"role": "user", "content": query},
    ]
    try:
        result = complete(messages, InterpretOut)
        if not result.rubric:
            raise LlmError("malformed", "The model returned a response we couldn't use.")
        filters = normalize(result.filters)
        rubric = result.rubric
    except LlmError as error:
        return llm_fail(error)
    return {"filters": filters.model_dump(), "rubric": rubric}


@app.post("/api/search")
def search(body: SearchIn):
    result = run_search(body.filters, body.rubric)
    if isinstance(result, JSONResponse):
        return result
    return result


@app.post("/api/refine")
def refine(body: RefineIn):
    feedback = body.feedback.strip()
    if not feedback and not any(item.verdict in {"yes", "no"} for item in body.shown):
        return fail(400, "bad_request", "Tell us who fits before refining.")
    lines = []
    for item in body.shown:
        vote = item.verdict if item.verdict in {"yes", "no"} else "unrated"
        lines.append(
            f"{item.index}. {item.name} ({item.id}) — {vote}. {item.current_title}, "
            f"{item.years_experience} years, {item.location}, {item.current_company} "
            f"({item.current_company_type}). Skills: {', '.join(item.skills)}. "
            f"Score: {item.score}. {item.explanation}"
        )
    try:
        updated = complete(
            [
                {"role": "system", "content": prompts.REFINE},
                {
                    "role": "user",
                    "content": json.dumps({
                        "filters": normalize(body.filters).model_dump(),
                        "rubric": body.rubric.strip(),
                        "feedback": feedback,
                        "shortlist": lines,
                    }),
                },
            ],
            RefineOut,
        )
        if not updated.rubric:
            raise LlmError("malformed", "The model returned a response we couldn't use.")
        filters = normalize(updated.filters)
        rubric = updated.rubric
    except LlmError as error:
        return llm_fail(error)
    result = run_search(filters, rubric)
    if isinstance(result, JSONResponse):
        return result
    summary = updated.change_summary or "Updated the search from your feedback."
    return {**result, "change_summary": summary}
