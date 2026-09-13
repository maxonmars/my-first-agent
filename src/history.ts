export const CONTEXT_STRATEGIES = ["compression", "sliding", "facts", "branching"] as const;
export type ContextStrategy = (typeof CONTEXT_STRATEGIES)[number] | null;
export type HistoryMessage = { role: "user"; content: string } | { role: "assistant"; content: string };
export type Facts = Record<string, string>;

export interface BranchingHistory {
  kind: "branching";
  activeBranch: string;
  branches: Record<string, HistoryMessage[]>;
  checkpoint: HistoryMessage[] | null;
}

export type HistoryState =
  | { kind: "compression"; summary: string | null; messages: HistoryMessage[] }
  | { kind: "sliding"; messages: HistoryMessage[] }
  | { kind: "facts"; messages: HistoryMessage[]; facts: Facts }
  | BranchingHistory;

export interface HistoryRepository {
  load(): HistoryState | null;
  save(state: HistoryState): void;
}

export function emptyHistory(strategy: ContextStrategy): HistoryState {
  switch (strategy) {
    case null:
    case "compression":
      return { kind: "compression", summary: null, messages: [] };
    case "sliding":
      return { kind: strategy, messages: [] };
    case "facts":
      return { kind: strategy, messages: [], facts: {} };
    case "branching":
      return { kind: strategy, activeBranch: "main", branches: { main: [] }, checkpoint: null };
  }
}
