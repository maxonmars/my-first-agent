export type HistoryMessage = { role: "user"; content: string } | { role: "assistant"; content: string };

export interface HistoryRepository {
  load(): HistoryMessage[];
  save(messages: readonly HistoryMessage[]): void;
}
