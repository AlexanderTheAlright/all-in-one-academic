import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";

export function useVaultRoot(): string | undefined {
  return useApi(() => api.vaultPath(), [], 0).data?.vaultPath;
}

export const homePath = (p?: string | null): string => (p || "").replace(/^\/home\/[^/]+(?=\/|$)/, "~");

/** The task board, relative to the vault (the server setting `tasks_board`). */
export const TASKS_BOARD = "Planning/Tasks.md";

/** The folder prefix of a live paper or grant (the server setting `project_prefix`; empty by default). */
export const PROJECT_PREFIX: string = "";

/** Primary sources, relative to the vault (the server setting `primary_sources_dir`). */
export const PRIMARY_SOURCES_DIR = "Preparation/Reading/Primary";

/** A project folder name without the live-project prefix. */
export const stripProjectPrefix = (name: string): string =>
  PROJECT_PREFIX && name.startsWith(PROJECT_PREFIX) ? name.slice(PROJECT_PREFIX.length) : name;

/** A paper board's vault path (Projects/papers/<folder>/PATH.md) as the project's name. */
export const boardProjectName = (p: string): string =>
  stripProjectPrefix(p.replace(/^Projects\/papers\//, "").replace(/\/PATH\.md$/, ""));
