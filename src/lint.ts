import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { refs, type Config, type Server } from "./config.ts";
import { plaintextSecrets } from "./secrets.ts";

export interface Issue {
  level: "error" | "warn";
  agent: string;
  server: string;
  message: string;
}

export function onPath(command: string, env: NodeJS.ProcessEnv, platform = process.platform): boolean | undefined {
  if (isAbsolute(command)) return existsSync(command);
  if (/[\\/]/.test(command)) return undefined;
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  return dirs.some((dir) => exts.some((ext) => existsSync(join(dir, command + ext))));
}

function strings(s: Server): string[] {
  return [s.command ?? "", ...s.args, ...Object.values(s.env), s.url ?? "", ...Object.values(s.headers), s.cwd ?? ""];
}

export function lint(configs: Config[], env: NodeJS.ProcessEnv = process.env): Issue[] {
  const issues: Issue[] = [];
  for (const c of configs) {
    const add = (level: Issue["level"], server: string, message: string) => issues.push({ level, agent: c.agent.id, server, message });
    if (c.error) add("error", "*", `${c.path}: ${c.error}`);
    for (const name of new Set(c.duplicates)) add("error", name, `defined more than once in ${c.path}; only the last one is used`);
    for (const s of c.servers) {
      for (const p of s.problems) add("error", s.name, p);
      if (s.transport === "stdio" && s.command && !refs(s.command).length && onPath(s.command, env) === false) {
        add("warn", s.name, `command "${s.command}" not found${isAbsolute(s.command) ? "" : " on PATH"}`);
      }
      for (const where of plaintextSecrets(s)) {
        add("warn", s.name, `plaintext secret in ${where}; reference an environment variable instead`);
      }
      const unset = new Set(strings(s).flatMap(refs).filter((r) => r.fallback === undefined && env[r.name] === undefined).map((r) => r.name));
      for (const name of unset) add("warn", s.name, `references \${${name}}, which is not set`);
    }
    for (const group of Map.groupBy(c.servers, (s) => s.name.toLowerCase()).values()) {
      if (group.length > 1) add("warn", group[0].name, `names differ only by case: ${group.map((s) => s.name).join(", ")}`);
    }
  }
  return issues;
}
