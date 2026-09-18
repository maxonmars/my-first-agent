import { join } from "node:path";
import { type Agent, AgentBusyError, type AgentResult, type ContextStatus } from "./agent.ts";
import type { ContextStrategy } from "./history.ts";
import type { InvariantInfo } from "./invariants.ts";
import { JsonHistoryRepository } from "./json-history-repository.ts";
import { JsonMemoryRepository } from "./json-memory-repository.ts";
import { JsonTaskRepository } from "./json-task-repository.ts";
import type { MemoryLayer, MemorySnapshot, WritableMemoryLayer } from "./memory.ts";
import {
  type AgentProfile,
  normalizeProfileId,
  PROFILE_FIELDS,
  PROFILE_ID_RULE,
  ProfileError,
  type ProfileField,
  type ProfilesRepository,
  type ProfilesState,
} from "./profile.ts";
import type { TaskView } from "./task.ts";

export type AgentFactory = (profileProvider: () => AgentProfile) => Agent;

export interface AgentSessionOptions {
  profilesRepository?: ProfilesRepository;
  createAgent: AgentFactory;
}

const NO_PROFILE_MESSAGE = "Профиль не выбран. Запустите /profile-init.";

/** Репозитории истории, памяти и задачи в рабочем каталоге; общие для всех профилей. */
export function jsonAgentRepositories(root: string, contextStrategy: ContextStrategy) {
  return {
    historyRepository: new JsonHistoryRepository(
      join(
        root,
        contextStrategy === null || contextStrategy === "compression"
          ? ".agent-history.json"
          : `.agent-history.${contextStrategy}.json`,
      ),
    ),
    workingMemoryRepository: new JsonMemoryRepository(join(root, ".agent-memory.working.json"), "working"),
    longTermMemoryRepository: new JsonMemoryRepository(join(root, ".agent-memory.long-term.json"), "long"),
    taskRepository: new JsonTaskRepository(join(root, ".agent-task.json")),
  };
}

export class AgentSession {
  private readonly profilesRepository: ProfilesRepository | undefined;
  private state: ProfilesState;
  private readonly agent: Agent;
  private responding = false;

  constructor(options: AgentSessionOptions) {
    this.profilesRepository = options.profilesRepository;
    this.state = structuredClone(this.profilesRepository?.load() ?? { activeProfileId: null, profiles: {} });
    // Источник читает текущее состояние сессии: выбор и правка профиля видны без пересоздания агента.
    this.agent = options.createAgent(() => {
      const id = this.state.activeProfileId;
      return id === null ? {} : (this.loadProfile(id) ?? {});
    });
  }

  getActiveProfileId(): string | null {
    return this.state.activeProfileId;
  }

  /** Идентификаторы по кодам символов — порядок не зависит от файла и локали. */
  listProfileIds(): readonly string[] {
    return Object.keys(this.state.profiles).sort();
  }

  loadProfile(profileId: string): AgentProfile | null {
    return Object.hasOwn(this.state.profiles, profileId) ? structuredClone(this.state.profiles[profileId]!) : null;
  }

  saveProfile(profileId: string, profile: AgentProfile): void {
    this.assertIdle();
    const id = requireProfileId(profileId);
    this.commit({ ...this.state, profiles: { ...this.state.profiles, [id]: cleanProfile(profile) } });
  }

  /** Сохраняет профиль и выбирает его одной записью каталога. */
  initProfile(profileId: string, profile: AgentProfile): void {
    this.assertIdle();
    const id = requireProfileId(profileId);
    this.commit({ activeProfileId: id, profiles: { ...this.state.profiles, [id]: cleanProfile(profile) } });
  }

  switchProfile(profileId: string): void {
    this.assertIdle();
    const id = requireProfileId(profileId);
    if (!Object.hasOwn(this.state.profiles, id)) {
      throw new ProfileError(`Профиль «${id}» не найден. Создайте его командой /profile-init.`);
    }
    if (id === this.state.activeProfileId) return;
    this.commit({ ...this.state, activeProfileId: id });
  }

  setProfileField(field: ProfileField, value: string): void {
    const profileId = this.requireActiveProfile();
    this.saveProfile(profileId, { ...this.state.profiles[profileId], [requireField(field)]: value });
  }

  deleteProfileField(field: ProfileField): boolean {
    const profileId = this.requireActiveProfile();
    const profile = { ...this.state.profiles[profileId] };
    if (!Object.hasOwn(profile, requireField(field))) return false;
    delete profile[field];
    this.saveProfile(profileId, profile);
    return true;
  }

  clearProfile(): void {
    this.saveProfile(this.requireActiveProfile(), {});
  }

  async respond(input: string): Promise<AgentResult> {
    if (this.responding) throw new AgentBusyError("Агент уже обрабатывает другой запрос.");
    this.responding = true;
    try {
      return await this.agent.respond(input);
    } finally {
      this.responding = false;
    }
  }

  reset(): void {
    this.agent.reset();
  }

  getContextStatus(): ContextStatus {
    return this.agent.getContextStatus();
  }

  getInvariants(): InvariantInfo[] {
    return this.agent.getInvariants();
  }

  getMemory(): MemorySnapshot {
    return this.agent.getMemory();
  }

  setMemory(layer: WritableMemoryLayer, key: string, value: string): void {
    this.agent.setMemory(layer, key, value);
  }

  deleteMemory(layer: WritableMemoryLayer, key: string): boolean {
    return this.agent.deleteMemory(layer, key);
  }

  clearMemory(layer: MemoryLayer): void {
    this.agent.clearMemory(layer);
  }

  createCheckpoint(): void {
    this.agent.createCheckpoint();
  }

  createBranch(name: string): void {
    this.agent.createBranch(name);
  }

  switchBranch(name: string): void {
    this.agent.switchBranch(name);
  }

  listBranches(): Array<{ name: string; active: boolean; messageCount: number }> {
    return this.agent.listBranches();
  }

  getTask(): TaskView | null {
    return this.agent.getTask();
  }

  startTask(description: string): void {
    this.agent.startTask(description);
  }

  approveTask(): void {
    this.agent.approveTask();
  }

  pauseTask(): boolean {
    return this.agent.pauseTask();
  }

  resumeTask(): boolean {
    return this.agent.resumeTask();
  }

  clearTask(): boolean {
    return this.agent.clearTask();
  }

  private commit(state: ProfilesState): void {
    this.profilesRepository?.save(structuredClone(state));
    this.state = state;
  }

  private assertIdle(): void {
    if (this.responding) {
      throw new AgentBusyError("Нельзя менять или выбирать профили во время обработки запроса.");
    }
  }

  private requireActiveProfile(): string {
    if (this.state.activeProfileId === null) throw new ProfileError(NO_PROFILE_MESSAGE);
    return this.state.activeProfileId;
  }
}

function requireProfileId(value: string): string {
  const profileId = normalizeProfileId(value);
  if (profileId === null) throw new ProfileError(`Неверный ${PROFILE_ID_RULE}.`);
  return profileId;
}

function requireField(field: string): ProfileField {
  const known = PROFILE_FIELDS.find((name) => name === field);
  if (known === undefined)
    throw new ProfileError(`Неизвестная группа профиля «${field}»: style, constraints или context.`);
  return known;
}

/** Обрезает значения и упорядочивает группы как PROFILE_FIELDS — в том же порядке профиль читается из файла. */
function cleanProfile(profile: AgentProfile): AgentProfile {
  for (const field of Object.keys(profile)) requireField(field);
  const result: AgentProfile = {};
  for (const field of PROFILE_FIELDS) {
    if (!Object.hasOwn(profile, field)) continue;
    const value: unknown = profile[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ProfileError(`Значение группы ${field} должно быть непустой строкой.`);
    }
    result[field] = value.trim();
  }
  return result;
}
