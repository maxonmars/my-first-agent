export type HistoryMessage = { role: "user"; content: string } | { role: "assistant"; content: string };

export interface HistoryState {
  summary: string | null;
  messages: HistoryMessage[];
}

export interface HistoryRepository {
  load(): HistoryState;
  save(state: HistoryState): void;
}
