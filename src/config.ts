import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export type Transport = "stdio" | "http" | "sse";
type Raw = Record<string, unknown>;

export interface Agent {
  id: string;
  label: string;
  file: string;
  projectFile: string;
  format: "json" | "toml";
}

export const AGENTS: Agent[] = [
  { id: "claude", label: "Claude Code", file: ".claude.json", projectFile: ".mcp.json", format: "json" },
  { id: "codex", label: "Codex", file: ".codex/config.toml", projectFile: ".codex/config.toml", format: "toml" },
  { id: "gemini", label: "Gemini CLI", file: ".gemini/settings.json", projectFile: ".gemini/settings.json", format: "json" },
  { id: "cursor", label: "Cursor", file: ".cursor/mcp.json", projectFile: ".cursor/mcp.json", format: "json" },
];

export function getAgent(id: string): Agent {
  const agent = AGENTS.find((a) => a.id === id);
  if (!agent) throw new Error(`unknown agent "${id}" (one of: ${AGENTS.map((a) => a.id).join(", ")})`);
  return agent;
}

export function configPath(agent: Agent, home: string, project?: string): string {
  return project ? join(project, agent.projectFile) : join(home, agent.file);
}

export interface Server {
  agent: string;
  name: string;
  scope?: string;
  transport: Transport;
  command?: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  extra: string[];
  raw: Raw;
  problems: string[];
}

export interface Config {
  agent: Agent;
  path: string;
  exists: boolean;
  servers: Server[];
  duplicates: string[];
  error?: string;
  localError?: string;
}

export const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const NOT_ENV = new Set(["userHome", "workspaceFolder", "workspaceFolderBasename", "pathSeparator"]);

export function refs(text: string): { name: string; fallback?: string }[] {
  return [...text.matchAll(REF)].filter((m) => !NOT_ENV.has(m[1])).map((m) => ({ name: m[1], fallback: m[2] }));
}

const isObject = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const record = (v: unknown): Record<string, string> =>
  isObject(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : {};
const mapValues = (r: Record<string, string>, f: (s: string) => string) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, f(v)]));

type Parsed = Omit<Server, "agent" | "name" | "extra" | "raw" | "problems"> & { keys: string[]; problems?: string[] };

function typed(raw: Raw, aliases: Record<string, Transport>): Parsed {
  const problems: string[] = [];
  let transport: Transport = raw.url && !raw.command ? "http" : "stdio";
  if (raw.type !== undefined) {
    const t = aliases[String(raw.type)];
    if (t) transport = t;
    else problems.push(`unknown type "${raw.type}"`);
  }
  return {
    transport,
    command: str(raw.command),
    args: list(raw.args),
    env: record(raw.env),
    url: str(raw.url),
    headers: record(raw.headers),
    keys: ["type", "command", "args", "env", "url", "headers"],
    problems,
  };
}

const PARSERS: Record<string, (raw: Raw) => Parsed> = {
  claude(raw) {
    const p = typed(raw, { stdio: "stdio", http: "http", "streamable-http": "http", sse: "sse" });
    if (raw.type === undefined && raw.url !== undefined) {
      p.transport = "stdio";
      p.problems!.push("has url but no type; Claude Code reads it as stdio");
    }
    return p;
  },
  cursor(raw) {
    const p = typed(raw, { stdio: "stdio", http: "http", "streamable-http": "http", sse: "sse" });
    const unwrap = (s: string) => s.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}");
    return {
      ...p,
      command: p.command && unwrap(p.command),
      args: p.args.map(unwrap),
      env: mapValues(p.env, unwrap),
      url: p.url && unwrap(p.url),
      headers: mapValues(p.headers, unwrap),
    };
  },
  gemini(raw) {
    const unwrap = (s: string) =>
      s.replace(/\$(?!\{)([A-Za-z_][A-Za-z0-9_]*)/g, "${$1}").replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, "${$1}");
    return {
      transport: raw.command ? "stdio" : raw.httpUrl ? "http" : "sse",
      command: str(raw.command),
      args: list(raw.args),
      env: mapValues(record(raw.env), unwrap),
      cwd: str(raw.cwd),
      url: str(raw.httpUrl) ?? str(raw.url),
      headers: record(raw.headers),
      keys: ["command", "args", "env", "cwd", "url", "httpUrl", "headers"],
    };
  },
  codex(raw) {
    const env = record(raw.env);
    for (const v of Array.isArray(raw.env_vars) ? raw.env_vars : []) {
      const name = isObject(v) ? str(v.name) : str(v);
      if (name && !(name in env)) env[name] = `\${${name}}`;
    }
    const headers = record(raw.http_headers);
    for (const [k, v] of Object.entries(record(raw.env_http_headers))) headers[k] = `\${${v}}`;
    if (typeof raw.bearer_token_env_var === "string") headers.Authorization = `Bearer \${${raw.bearer_token_env_var}}`;
    return {
      transport: raw.command === undefined && raw.url !== undefined ? "http" : "stdio",
      command: str(raw.command),
      args: list(raw.args),
      env,
      cwd: str(raw.cwd),
      url: str(raw.url),
      headers,
      keys: ["command", "args", "env", "env_vars", "cwd", "url", "http_headers", "env_http_headers", "bearer_token_env_var"],
    };
  },
};

export function parseServer(agent: string, name: string, raw: unknown, scope?: string): Server {
  if (!isObject(raw)) {
    return { agent, name, scope, transport: "stdio", args: [], env: {}, headers: {}, extra: [], raw: {}, problems: ["entry is not an object"] };
  }
  const { keys, problems = [], ...rest } = PARSERS[agent](raw);
  if (!rest.command && !rest.url) problems.push("has neither command nor url");
  return { agent, name, scope, ...rest, extra: Object.keys(raw).filter((k) => !keys.includes(k)), raw, problems };
}

export function parseDocument(agent: Agent, text: string): Raw {
  text = text.replace(/^﻿/, "");
  if (agent.format === "toml") {
    try {
      return parseToml(text) as Raw;
    } catch (e) {
      throw new Error(`invalid TOML: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (!text.trim()) return {};
  try {
    const doc = JSON.parse(text);
    if (!isObject(doc)) throw new Error("top level is not an object");
    return doc;
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as Error).message}`);
  }
}

export const serversKey = (agent: Agent) => (agent.format === "toml" ? "mcp_servers" : "mcpServers");

const samePath = (a: string, b: string) => {
  const norm = (p: string) => resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

function localServers(doc: Raw, project?: string): Server[] {
  if (!isObject(doc.projects)) return [];
  return Object.entries(doc.projects).flatMap(([dir, p]) =>
    (project && !samePath(dir, project)) || !isObject(p) || !isObject(p.mcpServers)
      ? []
      : Object.entries(p.mcpServers).map(([name, raw]) => parseServer("claude", name, raw, dir)),
  );
}

export function readConfig(agent: Agent, home: string, project?: string): Config {
  const path = configPath(agent, home, project);
  const config: Config = { agent, path, exists: existsSync(path), servers: [], duplicates: [] };
  if (config.exists) {
    const text = readFileSync(path, "utf8");
    try {
      const doc = parseDocument(agent, text);
      const servers = doc[serversKey(agent)] ?? {};
      if (!isObject(servers)) throw new Error(`${serversKey(agent)} is not an object`);
      config.servers = Object.entries(servers).map(([name, raw]) => parseServer(agent.id, name, raw));
      if (agent.format === "json") config.duplicates = duplicateKeys(text.replace(/^﻿/, ""), serversKey(agent));
      if (agent.id === "claude" && !project) config.servers.push(...localServers(doc));
    } catch (e) {
      config.error = (e as Error).message;
    }
  }
  const user = join(home, agent.file);
  if (agent.id === "claude" && project && existsSync(user)) {
    try {
      config.servers.push(...localServers(parseDocument(agent, readFileSync(user, "utf8")), project));
    } catch (e) {
      config.localError = `${user}: ${(e as Error).message}`;
    }
  }
  return config;
}

export function effective(config: Config, project?: string): { servers: Server[]; ambiguous: string[] } {
  const servers: Server[] = [];
  const ambiguous: string[] = [];
  for (const [name, copies] of Map.groupBy(config.servers, (s) => s.name)) {
    const local = copies.filter((s) => s.scope);
    const plain = copies.filter((s) => !s.scope);
    if (project) servers.push([...local, ...plain][0]);
    else if (plain.length) servers.push(plain[0]);
    else if (new Set(local.map(canonical)).size > 1) ambiguous.push(name);
    else servers.push(local[0]);
  }
  return { servers, ambiguous };
}

export const where = (s: Server) => (s.scope ? `${s.agent}:local ${s.scope}` : s.agent);

export function readAll(home: string, agents: Agent[] = AGENTS, project?: string): Config[] {
  return agents.map((a) => readConfig(a, home, project));
}

export function duplicateKeys(text: string, parent: string): string[] {
  let i = 0;
  const dupes: string[] = [];
  const ws = () => {
    while (/\s/.test(text[i] ?? "")) i++;
  };
  const string = () => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    return JSON.parse(text.slice(start, ++i)) as string;
  };
  const value = (path: string[]): void => {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      i++;
      const seen = new Set<string>();
      for (ws(); text[i] !== (c === "{" ? "}" : "]"); ws()) {
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (c === "[") {
          value(path);
          continue;
        }
        const key = string();
        ws();
        i++;
        if (seen.has(key) && path.length === 1 && path[0] === parent) dupes.push(key);
        seen.add(key);
        value([...path, key]);
      }
      i++;
    } else if (c === '"') string();
    else while (i < text.length && !/[,\]}\s]/.test(text[i])) i++;
  };
  value([]);
  return dupes;
}

export function canonical(s: Server): string {
  const sorted = (r: Record<string, string>) => Object.entries(r).sort(([a], [b]) => a.localeCompare(b));
  const remote = s.transport !== "stdio";
  return JSON.stringify([s.transport, remote ? null : s.command, remote ? [] : s.args, sorted(s.env), s.cwd ?? null, remote ? s.url : null, sorted(s.headers)]);
}

function mapStrings(s: Server, f: (v: string) => string): Server {
  return {
    ...s,
    command: s.command && f(s.command),
    args: s.args.map(f),
    env: mapValues(s.env, f),
    url: s.url && f(s.url),
    headers: mapValues(s.headers, f),
  };
}

const compact = (r: Raw) =>
  Object.fromEntries(
    Object.entries(r).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length) && !(isObject(v) && !Object.keys(v).length)),
  );

const RENDERERS: Record<string, (s: Server, warn: (m: string) => void) => Raw> = {
  claude(s, warn) {
    if (s.cwd) warn("cwd is not supported by Claude Code, dropped");
    return s.transport === "stdio"
      ? { type: "stdio", command: s.command, args: s.args, env: s.env }
      : { type: s.transport, url: s.url, headers: s.headers };
  },
  cursor(s, warn) {
    if (s.cwd) warn("cwd is not supported by Cursor, dropped");
    const c = mapStrings(s, (v) => v.replace(REF, (m, name) => (NOT_ENV.has(name) ? m : `\${env:${name}}`)));
    return c.transport === "stdio"
      ? { type: "stdio", command: c.command, args: c.args, env: c.env }
      : { url: c.url, headers: c.headers };
  },
  gemini(s, warn) {
    const outside = [s.command ?? "", ...s.args, s.url ?? "", ...Object.values(s.headers)];
    if (outside.some((v) => refs(v).length)) warn("Gemini CLI documents variable expansion only in env; check command, args, url and headers");
    if (s.transport === "stdio") return { command: s.command, args: s.args, env: s.env, cwd: s.cwd };
    return { [s.transport === "http" ? "httpUrl" : "url"]: s.url, headers: s.headers };
  },
  codex(s, warn) {
    const literal = (what: string, v: string) => {
      if (refs(v).length) warn(`${what}: Codex does not expand variables here, value kept as written`);
      return v;
    };
    if (s.transport === "stdio") {
      const env: Record<string, string> = {};
      const envVars: string[] = [];
      for (const [k, v] of Object.entries(s.env)) {
        if (v === `\${${k}}`) envVars.push(k);
        else env[k] = literal(`env ${k}`, v);
      }
      return { command: s.command, args: s.args, env, env_vars: envVars, cwd: s.cwd };
    }
    if (s.transport === "sse") warn("Codex has no SSE transport, written as streamable HTTP");
    const http: Record<string, string> = {};
    const fromEnv: Record<string, string> = {};
    let bearer: string | undefined;
    for (const [k, v] of Object.entries(s.headers)) {
      const b = v.match(/^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
      const whole = v.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
      if (b && k.toLowerCase() === "authorization") bearer = b[1];
      else if (whole) fromEnv[k] = whole[1];
      else http[k] = literal(`header ${k}`, v);
    }
    return { url: literal("url", s.url ?? ""), bearer_token_env_var: bearer, http_headers: http, env_http_headers: fromEnv };
  },
};

export function render(server: Server, target: string): { value: Raw; warnings: string[] } {
  if (server.agent === target) return { value: server.raw, warnings: [] };
  const warnings: string[] = [];
  if (server.extra.length) warnings.push(`dropped keys: ${server.extra.join(", ")}`);
  const s =
    target === "claude"
      ? server
      : mapStrings(server, (v) =>
          v.replace(REF, (m, name, fallback) => {
            if (fallback === undefined) return m;
            warnings.push(`default for \${${name}} dropped, ${getAgent(target).label} has no fallback syntax`);
            return `\${${name}}`;
          }),
        );
  return { value: compact(RENDERERS[target](s, (m) => warnings.push(m))), warnings };
}

export function snippet(agent: Agent, name: string, value: Raw): string {
  return agent.format === "toml"
    ? stringifyToml({ mcp_servers: { [name]: value } })
    : JSON.stringify({ mcpServers: { [name]: value } }, null, 2);
}
