import { createHash } from "node:crypto";
import { join } from "node:path";
import { type Agent, AgentBusyError, type AgentResult, type ContextStatus } from "./agent.ts";
import type { ContextStrategy } from "./history.ts";
import { JsonHistoryRepository } from "./json-history-repository.ts";
import { JsonMemoryRepository } from "./json-memory-repository.ts";
import type { MemoryLayer, MemorySnapshot, WritableMemoryLayer } from "./memory.ts";
import {
  normalizeUserId,
  PROFILE_FIELDS,
  ProfileError,
  type ProfileField,
  type ProfilesRepository,
  type ProfilesState,
  USER_ID_RULE,
  type UserProfile,
} from "./profile.ts";

export type AgentFactory = (userId: string | null, profileProvider: (() => UserProfile) | undefined) => Agent;

export interface AgentSessionOptions {
  profilesRepository?: ProfilesRepository;
  createAgent: AgentFactory;
}

const NO_USER_MESSAGE = "Пользователь не выбран. Запустите /profile-init.";

/** Каталог данных пользователя: SHA-256 от идентификатора, чтобы имя не зависело от допустимых символов ФС. */
export function userDirectory(root: string, userId: string): string {
  return join(root, ".agent-users", createHash("sha256").update(userId, "utf8").digest("hex"));
}

/** Репозитории истории и памяти: корень рабочего каталога без пользователя или его личный каталог. */
export function jsonAgentRepositories(root: string, userId: string | null, contextStrategy: ContextStrategy) {
  const directory = userId === null ? root : userDirectory(root, userId);
  return {
    historyRepository: new JsonHistoryRepository(
      join(
        directory,
        contextStrategy === null || contextStrategy === "compression"
          ? ".agent-history.json"
          : `.agent-history.${contextStrategy}.json`,
      ),
    ),
    workingMemoryRepository: new JsonMemoryRepository(join(directory, ".agent-memory.working.json"), "working"),
    longTermMemoryRepository: new JsonMemoryRepository(join(directory, ".agent-memory.long-term.json"), "long"),
  };
}

export class AgentSession {
  private readonly profilesRepository: ProfilesRepository | undefined;
  private readonly createAgent: AgentFactory;
  private state: ProfilesState;
  private agent: Agent;
  private responding = false;

  constructor(options: AgentSessionOptions) {
    this.profilesRepository = options.profilesRepository;
    this.createAgent = options.createAgent;
    this.state = structuredClone(this.profilesRepository?.load() ?? { activeUserId: null, profiles: {} });
    this.agent = this.agentFor(this.state.activeUserId);
  }

  getActiveUserId(): string | null {
    return this.state.activeUserId;
  }

  loadProfile(userId: string): UserProfile | null {
    return Object.hasOwn(this.state.profiles, userId) ? structuredClone(this.state.profiles[userId]!) : null;
  }

  saveProfile(userId: string, profile: UserProfile): void {
    this.assertIdle();
    const id = requireUserId(userId);
    this.commit({ ...this.state, profiles: { ...this.state.profiles, [id]: cleanProfile(profile) } });
  }

  /** Сохраняет профиль и выбирает пользователя одной записью каталога. */
  initProfile(userId: string, profile: UserProfile): void {
    this.assertIdle();
    const id = requireUserId(userId);
    const candidate = { activeUserId: id, profiles: { ...this.state.profiles, [id]: cleanProfile(profile) } };
    const agent = id === this.state.activeUserId ? this.agent : this.agentFor(id);
    this.commit(candidate);
    this.agent = agent;
  }

  switchUser(userId: string): void {
    this.assertIdle();
    const id = requireUserId(userId);
    if (!Object.hasOwn(this.state.profiles, id)) {
      throw new ProfileError(`Профиль «${id}» не найден. Создайте его командой /profile-init.`);
    }
    if (id === this.state.activeUserId) return;
    const agent = this.agentFor(id);
    this.commit({ ...this.state, activeUserId: id });
    this.agent = agent;
  }

  setProfileField(field: ProfileField, value: string): void {
    const userId = this.requireActiveUser();
    this.saveProfile(userId, { ...this.state.profiles[userId], [requireField(field)]: value });
  }

  deleteProfileField(field: ProfileField): boolean {
    const userId = this.requireActiveUser();
    const profile = { ...this.state.profiles[userId] };
    if (!Object.hasOwn(profile, requireField(field))) return false;
    delete profile[field];
    this.saveProfile(userId, profile);
    return true;
  }

  clearProfile(): void {
    this.saveProfile(this.requireActiveUser(), {});
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

  private agentFor(userId: string | null): Agent {
    if (userId === null) return this.createAgent(null, undefined);
    // Источник читает текущее состояние сессии, поэтому правки профиля видны без пересоздания агента.
    return this.createAgent(userId, () => this.loadProfile(userId) ?? {});
  }

  private commit(state: ProfilesState): void {
    this.profilesRepository?.save(structuredClone(state));
    this.state = state;
  }

  private assertIdle(): void {
    if (this.responding) {
      throw new AgentBusyError("Нельзя менять профили или пользователя во время обработки запроса.");
    }
  }

  private requireActiveUser(): string {
    if (this.state.activeUserId === null) throw new ProfileError(NO_USER_MESSAGE);
    return this.state.activeUserId;
  }
}

function requireUserId(value: string): string {
  const userId = normalizeUserId(value);
  if (userId === null) throw new ProfileError(`Неверный ${USER_ID_RULE}.`);
  return userId;
}

function requireField(field: string): ProfileField {
  const known = PROFILE_FIELDS.find((name) => name === field);
  if (known === undefined)
    throw new ProfileError(`Неизвестная группа профиля «${field}»: style, constraints или context.`);
  return known;
}

/** Обрезает значения и упорядочивает группы как PROFILE_FIELDS — в том же порядке профиль читается из файла. */
function cleanProfile(profile: UserProfile): UserProfile {
  for (const field of Object.keys(profile)) requireField(field);
  const result: UserProfile = {};
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
