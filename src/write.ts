import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { canonical, parseDocument, type Config, type Server } from "./config.ts";

export type Action = "new" | "same" | "conflict" | "overwrite" | "invalid";

export function plan(server: Server, target: Config, force: boolean): Action {
  if (server.problems.length) return "invalid";
  const current = target.servers.find((s) => s.name === server.name && !s.scope);
  if (!current) return "new";
  if (canonical(current) === canonical(server)) return "same";
  return force ? "overwrite" : "conflict";
}

function tablePath(header: string): string[] {
  const path: string[] = [];
  let node: unknown = parseToml(`[${header}]`);
  while (typeof node === "object" && node !== null && Object.keys(node).length === 1) {
    const [key] = Object.keys(node);
    path.push(key);
    node = (node as Record<string, unknown>)[key];
  }
  return path;
}

export function removeTomlServer(text: string, name: string): string {
  const kept: string[] = [];
  let skipping = false;
  let trailing: string[] = [];
  for (const line of text.split(/(?<=\n)/)) {
    const header = line.match(/^\s*\[\s*([^[\]]+?)\s*\]\s*(?:#.*)?$/);
    if (header || /^\s*\[\[/.test(line)) {
      if (skipping) kept.push(...trailing);
      const path = header ? tablePath(header[1]) : [];
      skipping = path[0] === "mcp_servers" && path[1] === name;
      trailing = [];
    }
    if (!skipping) kept.push(line);
    else trailing = /^\s*(#.*)?\s*$/.test(line) ? [...trailing, line] : [];
  }
  return kept.join("");
}

export function writeServers(target: Config, entries: [string, Record<string, unknown>][], now = new Date()): string | undefined {
  if (target.error) throw new Error(`refusing to write ${target.path}: ${target.error}`);
  const text = target.exists ? readFileSync(target.path, "utf8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let next: string;
  if (target.agent.format === "json") {
    const doc = parseDocument(target.agent, text);
    const servers = (doc.mcpServers ??= {}) as Record<string, unknown>;
    for (const [name, value] of entries) servers[name] = value;
    next = JSON.stringify(doc, null, 2) + "\n";
  } else {
    next = text.replace(/\r\n/g, "\n");
    for (const [name, value] of entries) {
      next = removeTomlServer(next, name);
      const left = (parseToml(next).mcp_servers ?? {}) as Record<string, unknown>;
      if (name in left) throw new Error(`cannot replace "${name}" in ${target.path}: it is defined inline, edit it by hand`);
      next = `${next.trimEnd()}${next.trim() ? "\n\n" : ""}${stringifyToml({ mcp_servers: { [name]: value } }).trim()}\n`;
    }
    const written = (parseToml(next).mcp_servers ?? {}) as Record<string, unknown>;
    for (const [name] of entries) if (!(name in written)) throw new Error(`failed to write "${name}" to ${target.path}`);
  }
  let backup: string | undefined;
  if (target.exists) {
    backup = `${target.path}.${now.toISOString().replace(/[:.]/g, "-")}.bak`;
    copyFileSync(target.path, backup);
  } else mkdirSync(dirname(target.path), { recursive: true });
  const tmp = `${target.path}.mcpport-tmp`;
  writeFileSync(tmp, eol === "\n" ? next : next.replace(/\n/g, "\r\n"));
  renameSync(tmp, target.path);
  return backup;
}
