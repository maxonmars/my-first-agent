import { resolve } from "node:path";
import { stderr, stdin, stdout } from "node:process";
import OpenAI from "openai";
import { Agent } from "./agent.ts";
import { runCli } from "./cli.ts";
import { DEEPSEEK_BASE_URL, readConfig } from "./config.ts";
import { JsonProfilesRepository } from "./json-profiles-repository.ts";
import { AgentSession, jsonAgentRepositories } from "./session.ts";

try {
  const config = readConfig();
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: DEEPSEEK_BASE_URL,
    maxRetries: 2,
    timeout: 600_000,
  });
  const root = process.cwd();
  const session = new AgentSession({
    profilesRepository: new JsonProfilesRepository(resolve(root, ".agent-profiles.json")),
    createAgent: (userId, profileProvider) =>
      new Agent({
        client: client.chat.completions,
        config: config.agent,
        ...jsonAgentRepositories(root, userId, config.agent.contextStrategy),
        ...(profileProvider === undefined ? {} : { profileProvider }),
      }),
  });

  process.exitCode = await runCli(session, process.argv.slice(2), { input: stdin, output: stdout, error: stderr });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
