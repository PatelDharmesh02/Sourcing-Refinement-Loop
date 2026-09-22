import { useEffect, useRef, useState } from "react";
import { ApiError, interpret, refine, search } from "./api";
import { COMPANY_TYPES, LOCATIONS, emptyFilters, type Filters, type Profile, type SearchResult, type TraceStep } from "./types";

type Busy = "interpreting" | "scoring" | "refining" | null;
type Vote = "yes" | "no";

type Item =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "change"; text: string }
  | { id: string; kind: "results"; result: SearchResult }
  | { id: string; kind: "empty"; result: SearchResult }
  | { id: string; kind: "error"; message: string };

const EXAMPLES = [
  "RDS developers with 4-7 years who have worked at startups, based in Bangalore",
  "Frontend engineers who know React and TypeScript",
  "DevOps engineers with Kubernetes",
];

const STATUS: Record<Exclude<Busy, null>, string> = {
  interpreting: "Turning that into filters and a rubric",
  scoring: "Filtering the pool and scoring the closest matches",
  refining: "Updating the search from your feedback",
};

function snapshot(filters: Filters, rubric: string) {
  return JSON.stringify({ filters, rubric });
}

function emptyCopy(trace: TraceStep[]) {
  const zero = trace.findIndex((step) => step.remaining === 0);
  if (zero <= 0) return "No one in this pool passed the filters. Loosen them on the right and run the search again.";
  const previous = trace[zero - 1];
  return `${trace[zero].label} removed the last ${previous.remaining}. Loosen that filter and run the search again.`;
}

function resultHeading(result: SearchResult) {
  const count = result.profiles.length;
  if (result.pool_size === count) return `${count} match${count === 1 ? "" : "es"}`;
  return `${count} of ${result.pool_size} matches`;
}

function App() {
  const [view, setView] = useState<"land" | "work">("land");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [landError, setLandError] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [frozen, setFrozen] = useState(false);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [rubric, setRubric] = useState("");
  const [saved, setSaved] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [votes, setVotes] = useState<Record<string, Vote>>({});
  const seq = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);
  const locked = frozen || busy !== null;
  const dirty = saved !== "" && snapshot(filters, rubric) !== saved;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items, busy]);

  function nextId() {
    seq.current += 1;
    return String(seq.current);
  }

  function push(item: Item) {
    setItems((current) => [...current, item]);
  }

  function applyResult(result: SearchResult, note?: string) {
    setFilters(result.filters);
    setRubric(result.rubric);
    setSaved(snapshot(result.filters, result.rubric));
    setVotes({});
    if (note) push({ id: nextId(), kind: "change", text: note });
    push({ id: nextId(), kind: result.profiles.length ? "results" : "empty", result });
  }

  async function runQuery(text: string) {
    const value = text.trim();
    if (!value || busy) return;
    setLandError("");
    setBusy("interpreting");
    try {
      const interpreted = await interpret(value);
      setFilters(interpreted.filters);
      setRubric(interpreted.rubric);
      setSaved(snapshot(interpreted.filters, interpreted.rubric));
      setItems([{ id: nextId(), kind: "user", text: value }]);
      setView("work");
      setQuery("");
      setBusy("scoring");
      try {
        applyResult(await search(interpreted.filters, interpreted.rubric));
      } catch (error) {
        push({ id: nextId(), kind: "error", message: messageOf(error) });
      }
    } catch (error) {
      setLandError(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  async function runEdited() {
    if (!dirty || locked) return;
    setBusy("scoring");
    push({ id: nextId(), kind: "user", text: "Updated the filters and ran the search." });
    try {
      applyResult(await search(filters, rubric));
    } catch (error) {
      push({ id: nextId(), kind: "error", message: messageOf(error) });
    } finally {
      setBusy(null);
    }
  }

  async function sendFeedback(text: string) {
    const latest = [...items].reverse().find((item) => item.kind === "results" || item.kind === "empty");
    if (!latest || locked || (latest.kind !== "results" && latest.kind !== "empty")) return;
    const profiles = latest.kind === "results" ? latest.result.profiles : [];
    const typed = text.trim();
    const reactions = profiles.flatMap((profile, index) => (votes[profile.id] ? [`${index + 1} ${votes[profile.id]}`] : []));
    if (!typed && reactions.length === 0) return;
    const feedback = [typed, reactions.length ? `Reactions: ${reactions.join(", ")}` : ""].filter(Boolean).join("\n");
    setBusy("refining");
    setDraft("");
    push({ id: nextId(), kind: "user", text: typed || reactions.join(", ") });
    try {
      const result = await refine({
        filters,
        rubric,
        feedback,
        shown: profiles.map((profile, index) => ({
          index: index + 1,
          id: profile.id,
          name: profile.name,
          current_title: profile.current_title,
          years_experience: profile.years_experience,
          location: profile.location,
          current_company: profile.current_company,
          current_company_type: profile.current_company_type,
          skills: profile.skills,
          score: profile.score,
          explanation: profile.explanation,
          verdict: votes[profile.id] ?? null,
        })),
      });
      applyResult(result, result.change_summary || "Updated the search from your feedback.");
    } catch (error) {
      push({ id: nextId(), kind: "error", message: messageOf(error) });
    } finally {
      setBusy(null);
    }
  }

  function restart() {
    setView("land");
    setQuery("");
    setDraft("");
    setLandError("");
    setBusy(null);
    setFrozen(false);
    setFilters(emptyFilters());
    setRubric("");
    setSaved("");
    setItems([]);
    setVotes({});
    seq.current = 1;
  }

  if (view === "land") {
    return (
      <Landing
        query={query}
        busy={busy === "interpreting"}
        error={landError}
        onChange={setQuery}
        onSubmit={() => runQuery(query)}
        onExample={(example) => {
          setQuery(example);
          void runQuery(example);
        }}
      />
    );
  }

  const latestInteractive = [...items].reverse().find((item) => item.kind === "results" || item.kind === "empty");
  const latestId = latestInteractive?.kind === "results" ? latestInteractive.id : undefined;

  return (
    <div className="shell">
      <div>
      <header className="topbar">
        <div>
          <p className="mark">Sourcing</p>
          <p className="mark-sub">{frozen ? "Search frozen" : "One search, refined in conversation"}</p>
        </div>
        <div className="topbar-actions">
          {frozen && (
            <button type="button" className="restart" onClick={restart}>
              Restart
            </button>
          )}
          <button type="button" className="freeze" disabled={locked} onClick={() => setFrozen(true)}>
            {frozen ? "Frozen" : "Freeze search"}
          </button>
        </div>
      </header>
      {frozen && (
        <div className="frozen-banner">
          <strong>This search is frozen.</strong>
          <span>The filters, the rubric, and the shortlist below are the final result. Click Restart to begin a new search.</span>
        </div>
      )}
      </div>
      <div className="workspace">
        <section className="thread-wrap">
          <div className="thread">
            {items.map((item) => (
              <ThreadItem
                key={item.id}
                item={item}
                active={item.id === latestId && !frozen}
                votes={votes}
                onVote={(id, vote) => {
                  setVotes((current) => {
                    const next = { ...current };
                    if (next[id] === vote) delete next[id];
                    else next[id] = vote;
                    return next;
                  });
                }}
              />
            ))}
            {busy && (
              <div className="status">
                <span className="dots" aria-hidden="true" />
                {STATUS[busy]}
              </div>
            )}
            <div ref={endRef} />
          </div>
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendFeedback(draft);
            }}
          >
            <input
              value={draft}
              disabled={locked}
              placeholder={frozen ? "This search is frozen" : "1 is too junior, 2 and 4 are right"}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="Feedback"
            />
            <button type="submit" disabled={locked || (!draft.trim() && Object.keys(votes).length === 0)}>
              Send
            </button>
          </form>
        </section>
        <Panel
          filters={filters}
          rubric={rubric}
          locked={locked}
          dirty={dirty}
          frozen={frozen}
          onFilters={setFilters}
          onRubric={setRubric}
          onRun={() => void runEdited()}
        />
      </div>
    </div>
  );
}

function messageOf(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return "Something went wrong. Try again.";
}

function Landing({
  query,
  busy,
  error,
  onChange,
  onSubmit,
  onExample,
}: {
  query: string;
  busy: boolean;
  error: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onExample: (value: string) => void;
}) {
  return (
    <main className="landing">
      <div className="landing-inner">
        <p className="mark">Sourcing</p>
        <h1>Who are you looking for?</h1>
        <p className="lede">One sentence is enough. We’ll turn it into filters and a rubric you can edit.</p>
        <form
          className="search"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <input
            value={query}
            autoFocus
            disabled={busy}
            placeholder="RDS developers with 4–7 years at startups in Bangalore"
            aria-label="Search"
            onChange={(event) => onChange(event.target.value)}
          />
          <button type="submit" disabled={busy || !query.trim()}>
            {busy ? "Reading" : "Search"}
          </button>
        </form>
        {busy && (
          <div className="status landing-status">
            <span className="dots" aria-hidden="true" />
            {STATUS.interpreting}
          </div>
        )}
        {error && <p className="banner bad">{error}</p>}
        <div className="examples">
          {EXAMPLES.map((example) => (
            <button key={example} type="button" disabled={busy} onClick={() => onExample(example)}>
              {example}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}

function Panel({
  filters,
  rubric,
  locked,
  dirty,
  frozen,
  onFilters,
  onRubric,
  onRun,
}: {
  filters: Filters;
  rubric: string;
  locked: boolean;
  dirty: boolean;
  frozen: boolean;
  onFilters: (filters: Filters) => void;
  onRubric: (rubric: string) => void;
  onRun: () => void;
}) {
  function patch(partial: Partial<Filters>) {
    onFilters({ ...filters, ...partial });
  }

  return (
    <aside className="panel">
      <div className="panel-head">
        <h2>{frozen ? "Frozen search" : "This search"}</h2>
        {dirty && !frozen && (
          <button type="button" className="run" disabled={locked} onClick={onRun}>
            Run search
          </button>
        )}
      </div>
      <section>
        <h3>Filters</h3>
        <ChipField label="Must have every skill" values={filters.skills_all} disabled={locked} onChange={(skills_all) => patch({ skills_all })} />
        <ChipField label="Must have one of" values={filters.skills_any} disabled={locked} onChange={(skills_any) => patch({ skills_any })} />
        <div className="years">
          <YearField label="Min years" value={filters.min_years} disabled={locked} onChange={(min_years) => patch({ min_years })} />
          <YearField label="Max years" value={filters.max_years} disabled={locked} onChange={(max_years) => patch({ max_years })} />
        </div>
        <ToggleField label="Location" options={LOCATIONS} values={filters.locations} disabled={locked} onChange={(locations) => patch({ locations })} />
        <ToggleField label="Company type" options={COMPANY_TYPES} values={filters.company_types} disabled={locked} onChange={(company_types) => patch({ company_types })} />
        <label className="field">
          <span>Company match</span>
          <select value={filters.company_scope} disabled={locked} onChange={(event) => patch({ company_scope: event.target.value as Filters["company_scope"] })}>
            <option value="any">Current or past company</option>
            <option value="current">Current company only</option>
          </select>
        </label>
        <ChipField label="Role family" values={filters.title_keywords} disabled={locked} onChange={(title_keywords) => patch({ title_keywords })} />
      </section>
      <section>
        <h3>Rubric</h3>
        <label className="field">
          <span>What good looks like</span>
          <textarea rows={5} value={rubric} disabled={locked} onChange={(event) => onRubric(event.target.value)} />
        </label>
      </section>
    </aside>
  );
}

function ChipField({ label, values, disabled, onChange }: { label: string; values: string[]; disabled: boolean; onChange: (values: string[]) => void }) {
  const [draft, setDraft] = useState("");

  function add() {
    const value = draft.trim();
    if (!value || values.some((item) => item.toLowerCase() === value.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...values, value]);
    setDraft("");
  }

  return (
    <div className="field">
      <span>{label}</span>
      <div className="chips">
        {values.map((value) => (
          <button key={value} type="button" className="chip" disabled={disabled} onClick={() => onChange(values.filter((item) => item !== value))}>
            {value}
            <span aria-hidden="true">×</span>
          </button>
        ))}
        <input
          value={draft}
          disabled={disabled}
          placeholder="Add"
          aria-label={label}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
      </div>
    </div>
  );
}

function YearField({ label, value, disabled, onChange }: { label: string; value: number | null; disabled: boolean; onChange: (value: number | null) => void }) {
  return (
    <label className="year">
      <span>{label}</span>
      <input
        type="number"
        min={0}
        max={40}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
      />
    </label>
  );
}

function ToggleField({
  label,
  options,
  values,
  disabled,
  onChange,
}: {
  label: string;
  options: string[];
  values: string[];
  disabled: boolean;
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="toggles">
        {options.map((option) => {
          const on = values.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={on}
              className={on ? "on" : ""}
              disabled={disabled}
              onClick={() => onChange(on ? values.filter((item) => item !== option) : [...values, option])}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ThreadItem({
  item,
  active,
  votes,
  onVote,
}: {
  item: Item;
  active: boolean;
  votes: Record<string, Vote>;
  onVote: (id: string, vote: Vote) => void;
}) {
  if (item.kind === "user") return <p className="bubble user">{item.text}</p>;
  if (item.kind === "change") {
    return (
      <div className="change">
        <span>What changed</span>
        <p>{item.text}</p>
      </div>
    );
  }
  if (item.kind === "error") return <p className="banner bad">{item.message} Your filters are still on the right.</p>;
  if (item.kind === "empty") {
    return (
      <div className="empty">
        <strong>No matches</strong>
        <p>{emptyCopy(item.result.trace)}</p>
      </div>
    );
  }
  return (
    <div className="results">
      <div className="result-head">
        <strong>{resultHeading(item.result)}</strong>
        <span>
          {item.result.scored
            ? `Scored the closest ${item.result.scored_count}.`
            : "Showing a simple rank. The model did not score this set."}
        </span>
      </div>
      {item.result.warning && <p className="banner warn">{item.result.warning.message}</p>}
      {item.result.profiles.map((profile, index) => (
        <ProfileCard key={profile.id} profile={profile} index={index + 1} active={active} vote={votes[profile.id]} onVote={onVote} />
      ))}
    </div>
  );
}

function ProfileCard({
  profile,
  index,
  active,
  vote,
  onVote,
}: {
  profile: Profile;
  index: number;
  active: boolean;
  vote?: Vote;
  onVote: (id: string, vote: Vote) => void;
}) {
  return (
    <article className="card">
      <div className="card-top">
        <span className="rank">{index}</span>
        <div>
          <h3>{profile.name}</h3>
          <p>
            {profile.current_title} · {profile.current_company}
            <em> {profile.current_company_type}</em>
          </p>
          <p className="meta">
            {profile.location} · {profile.years_experience} years
          </p>
        </div>
        <span className="score">{profile.score === null ? "—" : profile.score}</span>
      </div>
      <p className="why">{profile.explanation}</p>
      <div className="skill-row">
        {profile.skills.map((skill) => (
          <span key={skill} className={profile.matched_skills.includes(skill) ? "skill on" : "skill"}>
            {skill}
          </span>
        ))}
      </div>
      {active && (
        <div className="votes">
          <button type="button" className={vote === "yes" ? "yes on" : "yes"} onClick={() => onVote(profile.id, "yes")}>
            Yes
          </button>
          <button type="button" className={vote === "no" ? "no on" : "no"} onClick={() => onVote(profile.id, "no")}>
            No
          </button>
        </div>
      )}
    </article>
  );
}

export { App };
