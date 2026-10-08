import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { AGENTS, canonical, effective, getAgent, readAll, readConfig, render, snippet, where, type Config, type Server } from "./config.ts";
import { lint } from "./lint.ts";
import { redact, redactArgs, redactUrl } from "./secrets.ts";
import { plan, writeServers, type Action } from "./write.ts";

const HELP = `mcpport - list, lint, sync and convert MCP server configs

Usage:
  mcpport list [--agent <id>] [--json]
  mcpport lint [--agent <id>] [--json]
  mcpport sync <from> <to> [--apply] [--force]
  mcpport convert <server> --to <id> [--from <id>] [--apply | --out <file>] [--force]

Options:
  --project <dir>  use project configs in <dir> instead of user configs

Agents: ${AGENTS.map((a) => `${a.id} (${a.label})`).join(", ")}
`;

function target(s: Server): string {
  const t = s.transport === "stdio" ? [s.command ?? "", ...redactArgs(s.args)].join(" ") : redactUrl(s.url ?? "");
  return t.length > 48 ? `${t.slice(0, 45)}...` : t;
}

export function run(argv: string[], home = homedir(), print = console.log, env: NodeJS.ProcessEnv = process.env): number {
  const out = (line: string) => print(line.split(home).join("~"));
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      json: { type: "boolean" },
      apply: { type: "boolean" },
      force: { type: "boolean" },
      to: { type: "string" },
      from: { type: "string" },
      out: { type: "string" },
      project: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [cmd, ...args] = positionals;
  const agents = values.agent ? [getAgent(values.agent)] : AGENTS;
  const project = values.project;

  if (values.version) {
    out(createRequire(import.meta.url)("../package.json").version);
    return 0;
  }

  switch (cmd) {
    case "list": {
      const configs = readAll(home, agents, project);
      if (values.json) {
        print(JSON.stringify(configs.map((c) => ({
          agent: c.agent.id,
          path: c.path,
          exists: c.exists,
          error: c.error,
          localError: c.localError,
          servers: c.servers.map(({ name, scope, transport, command, args, env, cwd, url, headers, extra, problems }) =>
            redact({ name, scope, transport, command, args, env, cwd, url, headers, extra, problems })),
        })), null, 2));
        return 0;
      }
      const present = configs.filter((c) => c.exists || c.servers.length).map((c) => c.agent);
      const servers = configs.flatMap((c) => c.servers);
      const groups = Map.groupBy(servers, (s) => (s.scope ? `${s.name}\0${s.scope}` : s.name));
      const keys = [...groups.keys()].sort();
      const rows = keys.map((key) => {
        const copies = groups.get(key)!;
        const variants = [...Map.groupBy(copies, canonical).values()].sort((a, b) => b.length - a.length);
        const drift = variants.slice(1).flat().map((s) => s.agent);
        const first = variants[0][0];
        const cells = present.map((a) => {
          const s = copies.find((c) => c.agent === a.id);
          return (s ? (s.scope ? "local" : s.raw.enabled === false ? "off" : "yes") : "-").padEnd(7);
        });
        const note = first.scope ? where(first) : drift.length ? `differs: ${drift.join(", ")}` : "";
        return [first.name, first.transport, target(first), cells.join(""), note];
      });
      const w = [4, 9, 6].map((min, i) => Math.max(min, ...rows.map((r) => r[i].length)));
      const line = (r: string[]) => `${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2].padEnd(w[2])}  ${r[3]}${r[4]}`.trimEnd();
      out(line(["name", "transport", "target", present.map((a) => a.id.padEnd(7)).join(""), "notes"]));
      for (const r of rows) out(line(r));
      const count = (c: Config) => {
        if (!c.exists && !c.servers.length) return "no config";
        const local = c.servers.filter((s) => s.scope).length;
        return `${c.servers.length - local}${local ? ` + ${local} local` : ""}`;
      };
      out(`\n${new Set(servers.map((s) => s.name)).size} servers. ${configs.map((c) => `${c.agent.id}: ${count(c)}`).join(", ")}`);
      for (const c of configs) for (const e of [c.error && `${c.path}: ${c.error}`, c.localError]) if (e) out(`${c.agent.id}: ${e}`);
      return 0;
    }

    case "lint": {
      const configs = readAll(home, agents, project);
      const issues = lint(configs, env);
      if (values.json) print(JSON.stringify(issues, null, 2));
      else {
        for (const i of issues) out(`${i.level.padEnd(5)}  ${i.agent}${i.scope ? `:local ${i.scope} ` : "/"}${i.server}  ${i.message}`);
        const errors = issues.filter((i) => i.level === "error").length;
        const count = configs.reduce((n, c) => n + c.servers.length, 0);
        out(`${issues.length ? "\n" : ""}${count} servers checked: ${errors} errors, ${issues.length - errors} warnings`);
      }
      return issues.some((i) => i.level === "error") ? 1 : 0;
    }

    case "sync": {
      const [from, to] = args;
      if (!from || !to) throw new Error("usage: mcpport sync <from> <to> [--apply] [--force]");
      if (from === to) throw new Error("source and target are the same agent");
      const source = readConfig(getAgent(from), home, project);
      const dest = readConfig(getAgent(to), home, project);
      for (const c of [source, dest]) if (c.error) throw new Error(`${c.path}: ${c.error}`);
      const counts: Record<Action, number> = { new: 0, same: 0, conflict: 0, overwrite: 0, invalid: 0 };
      const writes: [string, Record<string, unknown>][] = [];
      const { servers, ambiguous } = effective(source, project);
      for (const name of ambiguous) out(`${"skip".padEnd(9)}  ${name}  (local in several projects with different settings)`);
      for (const s of servers) {
        const action = plan(s, dest, !!values.force);
        counts[action]++;
        if (action === "same") continue;
        const why = action === "invalid" ? s.problems.join("; ") : s.scope ? `from ${where(s)}` : "";
        out(`${action.padEnd(9)}  ${s.name}${why ? `  (${why})` : ""}`);
        if (action !== "new" && action !== "overwrite") continue;
        const { value, warnings } = render(s, to);
        for (const w of warnings) out(`           ${w}`);
        writes.push([s.name, value]);
      }
      out(`\n${counts.new} new, ${counts.overwrite} overwrite, ${counts.conflict} conflicts (use --force), ${counts.invalid} invalid, ${counts.same} already in sync`);
      if (!writes.length) return 0;
      if (!values.apply) {
        out(`Dry run. Re-run with --apply to write ${dest.path}.`);
        return 0;
      }
      const backup = writeServers(dest, writes);
      out(`wrote ${dest.path}${backup ? `\nbackup ${backup}` : ""}`);
      return 0;
    }

    case "convert": {
      const [name] = args;
      if (!name || !values.to) throw new Error("usage: mcpport convert <server> --to <id> [--from <id>] [--apply | --out <file>] [--force]");
      const to = getAgent(values.to);
      const sources = readAll(home, values.from ? [getAgent(values.from)] : AGENTS.filter((a) => a !== to), project);
      const resolved = sources.map((c) => effective(c, project));
      if (resolved.some((r) => r.ambiguous.includes(name))) throw new Error(`"${name}" is local in several projects with different settings; use --project <dir>`);
      const server = resolved.flatMap((r) => r.servers).find((s) => s.name === name);
      if (!server) throw new Error(`server "${name}" not found`);
      if (server.problems.length) throw new Error(`${where(server)}/${name}: ${server.problems.join("; ")}`);
      const { value, warnings } = render(server, to.id);
      const notes = () => {
        for (const w of [`from ${where(server)}`, ...warnings]) out(`note: ${w}`);
      };

      if (values.apply) {
        const dest = readConfig(to, home, project);
        const action = plan(server, dest, !!values.force);
        if (action === "conflict") {
          out(`"${name}" already exists in ${dest.path} and differs. Use --force to overwrite.`);
          return 1;
        }
        notes();
        if (action === "same") {
          out(`already up to date in ${dest.path}`);
          return 0;
        }
        const backup = writeServers(dest, [[name, value]]);
        out(`wrote ${dest.path}${backup ? `\nbackup ${backup}` : ""}`);
        return 0;
      }
      if (values.out) {
        if (existsSync(values.out) && !values.force) {
          out(`${values.out} already exists. Use --force to overwrite.`);
          return 1;
        }
        writeFileSync(values.out, `${snippet(to, name, value).trimEnd()}\n`);
        notes();
        out(`wrote ${values.out}`);
        return 0;
      }
      out(snippet(to, name, redact(value) as Record<string, unknown>).trimEnd());
      notes();
      out("note: secret values are redacted, use --out <file> or --apply to write them");
      return 0;
    }

    default:
      out(HELP);
      return cmd ? 1 : 0;
  }
}
