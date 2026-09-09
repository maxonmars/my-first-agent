import { resolve } from "node:path";
import { stderr, stdin, stdout } from "node:process";
import OpenAI from "openai";
import { Agent } from "./agent.ts";
import { runCli } from "./cli.ts";
import { DEEPSEEK_BASE_URL, readConfig } from "./config.ts";
import { JsonHistoryRepository } from "./json-history-repository.ts";

try {
  const config = readConfig();
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: DEEPSEEK_BASE_URL,
    maxRetries: 2,
    timeout: 600_000,
  });
  const agent = new Agent({
    client: client.chat.completions,
    config: config.agent,
    historyRepository: new JsonHistoryRepository(resolve(process.cwd(), ".agent-history.json")),
  });

  process.exitCode = await runCli(agent, process.argv.slice(2), { input: stdin, output: stdout, error: stderr });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
