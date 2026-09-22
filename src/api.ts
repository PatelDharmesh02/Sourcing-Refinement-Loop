import type { Filters, SearchResult } from "./types";

// Deployed URL from VITE_API_BASE_URL; empty falls back to Vite's /api → local :8000 proxy.
const API_BASE = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";

export class ApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data.error ?? { code: "upstream", message: "Something went wrong. Try again." };
    throw new ApiError(error.code, error.message);
  }
  return data as T;
}

export function interpret(query: string) {
  return post<{ filters: Filters; rubric: string }>("/api/interpret", { query });
}

export function search(filters: Filters, rubric: string) {
  return post<SearchResult>("/api/search", { filters, rubric });
}

export function refine(body: {
  filters: Filters;
  rubric: string;
  feedback: string;
  shown: Array<{
    index: number;
    id: string;
    name: string;
    current_title: string;
    years_experience: number;
    location: string;
    current_company: string;
    current_company_type: string;
    skills: string[];
    score: number | null;
    explanation: string;
    verdict: "yes" | "no" | null;
  }>;
}) {
  return post<SearchResult>("/api/refine", body);
}
