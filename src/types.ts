export type Filters = {
  skills_all: string[];
  skills_any: string[];
  min_years: number | null;
  max_years: number | null;
  locations: string[];
  company_types: string[];
  company_scope: "current" | "any";
  title_keywords: string[];
};

export type TraceStep = {
  label: string;
  remaining: number;
};

export type Profile = {
  id: string;
  name: string;
  current_title: string;
  years_experience: number;
  location: string;
  current_company: string;
  current_company_type: string;
  skills: string[];
  matched_skills: string[];
  score: number | null;
  explanation: string;
};

export type Warning = {
  code: string;
  message: string;
};

export type SearchResult = {
  filters: Filters;
  rubric: string;
  profiles: Profile[];
  pool_size: number;
  scored_count: number;
  trace: TraceStep[];
  scored: boolean;
  warning: Warning | null;
  change_summary?: string;
};

export const LOCATIONS = [
  "Bangalore",
  "Chennai",
  "Mumbai",
  "Hyderabad",
  "Delhi NCR",
  "Pune",
  "Amsterdam",
  "Berlin",
  "Remote - India",
];

export const COMPANY_TYPES = ["startup", "scaleup", "enterprise", "agency"];

export function emptyFilters(): Filters {
  return {
    skills_all: [],
    skills_any: [],
    min_years: null,
    max_years: null,
    locations: [],
    company_types: [],
    company_scope: "any",
    title_keywords: [],
  };
}
