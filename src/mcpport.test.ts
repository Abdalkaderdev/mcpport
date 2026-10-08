import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import { parse as parseToml } from "smol-toml";
import { run } from "./cli.ts";
import { duplicateKeys, getAgent, readAll, readConfig, render } from "./config.ts";
import { lint } from "./lint.ts";
import { redact, redactArgs, redactUrl } from "./secrets.ts";

const SECRET = "sk-live-0123456789abcdef";
let home: string;
let bin: string;

function file(rel: string, text: string) {
  const path = join(home, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const json = (servers: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ ...extra, mcpServers: servers }, null, 2);

function cli(...argv: string[]) {
  const lines: string[] = [];
  const code = run(argv, home, (l) => lines.push(l), { PATH: bin, PATHEXT: ".CMD", GITHUB_TOKEN: "set" });
  return { code, text: lines.join("\n") };
}

const read = (rel: string) => readFileSync(join(home, rel), "utf8");
const server = (agent: string, name: string) => readConfig(getAgent(agent), home).servers.find((s) => s.name === name)!;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mcpport-"));
  bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npx"), "");
});

test("normalizes all four formats to one shape", () => {
  file(".claude.json", json({
    gh: { type: "stdio", command: "npx", args: ["-y", "gh"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } },
    api: { type: "streamable-http", url: "https://a.dev/mcp", headers: { Authorization: "Bearer ${API_KEY}" } },
  }, { projects: { "/x": { mcpServers: { local: { command: "x" } } } } }));
  file(".cursor/mcp.json", json({
    gh: { command: "npx", args: ["-y", "gh"], env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}" } },
    api: { url: "https://a.dev/mcp", headers: { Authorization: "Bearer ${env:API_KEY}" } },
  }));
  file(".gemini/settings.json", json({
    gh: { command: "npx", args: ["-y", "gh"], env: { GITHUB_TOKEN: "$GITHUB_TOKEN" } },
    api: { httpUrl: "https://a.dev/mcp", headers: { Authorization: "Bearer ${API_KEY}" } },
    old: { url: "https://a.dev/sse" },
  }));
  file(".codex/config.toml", [
    "[mcp_servers.gh]", 'command = "npx"', 'args = ["-y", "gh"]', 'env_vars = ["GITHUB_TOKEN"]', "",
    "[mcp_servers.api]", 'url = "https://a.dev/mcp"', 'bearer_token_env_var = "API_KEY"', "startup_timeout_sec = 20", "",
  ].join("\n"));

  const configs = readAll(home);
  assert.deepEqual(configs.map((c) => c.servers.map((s) => s.name).join(",")), ["gh,api", "gh,api", "gh,api,old", "gh,api"]);
  assert.equal(server("gemini", "old").transport, "sse");
  assert.equal(server("codex", "api").transport, "http");
  assert.deepEqual(server("codex", "api").extra, ["startup_timeout_sec"]);

  const out = cli("list");
  assert.match(out.text, /^gh\s+stdio\s+npx -y gh\s+yes\s+yes\s+yes\s+yes$/m);
  assert.match(out.text, /^api\s+http\s+https:\/\/a\.dev\/mcp\s+yes\s+yes\s+yes\s+yes$/m);
  assert.match(out.text, /^old\s+sse/m);
  assert.doesNotMatch(out.text, /local/);
});

test("list marks drift between agents", () => {
  file(".claude.json", json({ gh: { type: "stdio", command: "npx", args: ["gh@1"] } }));
  file(".cursor/mcp.json", json({ gh: { command: "npx", args: ["gh@1"] } }));
  file(".gemini/settings.json", json({ gh: { command: "npx", args: ["gh@2"] } }));
  assert.match(cli("list").text, /^gh .*differs: gemini$/m);
});

test("reports invalid JSON and TOML, and duplicate keys", () => {
  file(".claude.json", "{ \"mcpServers\": { ");
  file(".codex/config.toml", "[mcp_servers.a\ncommand = 1");
  file(".cursor/mcp.json", '{"mcpServers": {"a": {"command": "npx"}, "b": {"args": [{"a": 1, "a": 2}]}, "a": {"command": "npx"}}}');
  assert.deepEqual(duplicateKeys('{"x": {"a": 1}, "mcpServers": {"a": {}, "b": "a\\"", "a": {}}}', "mcpServers"), ["a"]);
  const configs = readAll(home);
  assert.match(configs[0].error!, /^invalid JSON/);
  assert.match(configs[1].error!, /^invalid TOML/);
  assert.deepEqual(configs[3].duplicates, ["a"]);
  const out = cli("lint");
  assert.equal(out.code, 1);
  assert.match(out.text, /error\s+cursor\/a\s+defined more than once/);
});

test("lint flags missing commands, secrets, unset vars and bad entries", () => {
  file(".claude.json", json({
    ok: { type: "stdio", command: "npx", env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } },
    gone: { type: "stdio", command: "not-installed" },
    leak: { type: "http", url: "https://a.dev/mcp?api_key=" + SECRET, headers: { Authorization: `Bearer ${SECRET}` } },
    unset: { type: "http", url: "https://a.dev/mcp", headers: { "X-Key": "${NOPE}", "X-Other": "${ALSO:-fallback}" } },
    notype: { url: "https://a.dev/mcp" },
    GitHub: { type: "stdio", command: "npx" },
    github: { type: "stdio", command: "npx" },
  }));
  file(".cursor/mcp.json", json({ argv: { command: "npx", args: ["--api-key", SECRET], env: { DB_PASSWORD: SECRET } } }));
  const messages = lint(readAll(home), { PATH: bin, GITHUB_TOKEN: "x" }).map((i) => `${i.level} ${i.agent}/${i.server} ${i.message}`);
  assert.ok(!messages.some((m) => m.includes("/ok ")));
  assert.ok(messages.includes('warn claude/gone command "not-installed" not found on PATH'));
  assert.ok(messages.includes('warn claude/leak plaintext secret in header "Authorization"; reference an environment variable instead'));
  assert.ok(messages.some((m) => m.startsWith("warn claude/leak plaintext secret in url")));
  assert.ok(messages.includes("warn claude/unset references ${NOPE}, which is not set"));
  assert.ok(!messages.some((m) => m.includes("ALSO")));
  assert.ok(messages.includes("error claude/notype has url but no type; Claude Code reads it as stdio"));
  assert.ok(messages.includes("warn claude/GitHub names differ only by case: GitHub, github"));
  assert.ok(messages.some((m) => m.startsWith("warn cursor/argv plaintext secret in env \"DB_PASSWORD\"")));
  assert.ok(messages.some((m) => m.startsWith("warn cursor/argv plaintext secret in args")));
  assert.ok(!messages.join("\n").includes(SECRET));
});

test("finds commands with Windows extensions", () => {
  writeFileSync(join(bin, "uvx.cmd"), "");
  file(".cursor/mcp.json", json({ a: { command: "uvx" } }));
  const issues = lint(readAll(home), { PATH: bin, PATHEXT: ".CMD" });
  assert.equal(issues.some((i) => i.message.includes("not found")), process.platform !== "win32");
});

test("redacts env, headers, secret args and url credentials", () => {
  assert.deepEqual(redactArgs(["--token", SECRET, "--api-key=" + SECRET, "--verbose", "x", "--token", "${T}"]), ["--token", "***", "--api-key=***", "--verbose", "x", "--token", "${T}"]);
  assert.equal(redactUrl(`postgres://user:${SECRET}@db/x?sslmode=require&access_token=${SECRET}`), "postgres://user:***@db/x?sslmode=require&access_token=***");
  assert.deepEqual(redact({ env: { A: SECRET, B: "${B}" }, headers: { Authorization: "Bearer ${T}" }, httpUrl: `https://x?key=${SECRET}` }), {
    env: { A: "***", B: "${B}" },
    headers: { Authorization: "Bearer ${T}" },
    httpUrl: "https://x?key=***",
  });
});

test("list, lint and convert never print secret values", () => {
  file(".claude.json", json({ leak: { type: "http", url: `https://u:${SECRET}@a.dev/mcp`, headers: { Authorization: `Bearer ${SECRET}` } } }));
  file(".cursor/mcp.json", json({ leak: { command: "npx", args: ["--token", SECRET], env: { LOG: SECRET } } }));
  for (const argv of [["list"], ["list", "--json"], ["lint"], ["lint", "--json"], ["convert", "leak", "--to", "codex"], ["convert", "leak", "--to", "gemini", "--from", "cursor"]]) {
    const out = cli(...argv).text;
    assert.ok(!out.includes(SECRET), `${argv.join(" ")} leaked: ${out}`);
  }
  assert.match(cli("convert", "leak", "--to", "codex").text, /"Bearer \*\*\*"/);
});

test("converts references and transports between formats", () => {
  file(".claude.json", json({
    gh: { type: "stdio", command: "npx", args: ["-y", "gh"], env: { GITHUB_TOKEN: "${GITHUB_TOKEN}", MODE: "${MODE:-dev}" } },
    api: { type: "http", url: "https://a.dev/mcp", headers: { Authorization: "Bearer ${API_KEY}", "X-Team": "${TEAM}", "X-Plain": "v" }, oauth: { x: 1 } },
    stream: { type: "sse", url: "https://a.dev/sse" },
  }));
  const gh = server("claude", "gh");
  const api = server("claude", "api");
  assert.deepEqual(render(gh, "codex").value, { command: "npx", args: ["-y", "gh"], env_vars: ["GITHUB_TOKEN", "MODE"] });
  assert.ok(render(gh, "codex").warnings.some((w) => w.startsWith("default for ${MODE} dropped")));
  assert.deepEqual(render(api, "codex").value, { url: "https://a.dev/mcp", bearer_token_env_var: "API_KEY", http_headers: { "X-Plain": "v" }, env_http_headers: { "X-Team": "TEAM" } });
  assert.deepEqual(render(api, "codex").warnings, ["dropped keys: oauth"]);
  assert.deepEqual(render(gh, "cursor").value.env, { GITHUB_TOKEN: "${env:GITHUB_TOKEN}", MODE: "${env:MODE}" });
  assert.deepEqual(render(api, "gemini").value.httpUrl, "https://a.dev/mcp");
  assert.deepEqual(render(server("claude", "stream"), "gemini").value, { url: "https://a.dev/sse" });
  assert.deepEqual(render(server("claude", "stream"), "codex").warnings, ["Codex has no SSE transport, written as streamable HTTP"]);

  file(".codex/config.toml", '[mcp_servers.api]\nurl = "https://a.dev/mcp"\nbearer_token_env_var = "API_KEY"\n[mcp_servers.api.env_http_headers]\nX-Team = "TEAM"\n');
  assert.deepEqual(render(server("codex", "api"), "claude").value, {
    type: "http",
    url: "https://a.dev/mcp",
    headers: { "X-Team": "${TEAM}", Authorization: "Bearer ${API_KEY}" },
  });
});

test("sync is a dry run by default, skips conflicts and backs up before writing", () => {
  file(".claude.json", json({
    fresh: { type: "stdio", command: "npx", args: ["fresh"] },
    clash: { type: "stdio", command: "npx", args: ["new"] },
    same: { type: "stdio", command: "npx" },
    broken: { type: "stdio" },
  }));
  const cursor = file(".cursor/mcp.json", json({ clash: { command: "npx", args: ["old"] }, same: { command: "npx" }, mine: { url: "https://x" } }, { other: true }));
  const before = readFileSync(cursor, "utf8");

  let out = cli("sync", "claude", "cursor");
  assert.match(out.text, /^new\s+fresh$/m);
  assert.match(out.text, /^conflict\s+clash$/m);
  assert.match(out.text, /^invalid\s+broken/m);
  assert.match(out.text, /1 new, 0 overwrite, 1 conflicts \(use --force\), 1 invalid, 1 already in sync/);
  assert.match(out.text, /Dry run/);
  assert.equal(readFileSync(cursor, "utf8"), before);

  out = cli("sync", "claude", "cursor", "--apply");
  const doc = JSON.parse(readFileSync(cursor, "utf8"));
  assert.deepEqual(doc.mcpServers.fresh, { type: "stdio", command: "npx", args: ["fresh"] });
  assert.deepEqual(doc.mcpServers.clash.args, ["old"]);
  assert.equal(doc.other, true);
  assert.ok(doc.mcpServers.mine);
  const backups = readdirSync(join(home, ".cursor")).filter((f) => f.endsWith(".bak"));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(home, ".cursor", backups[0]), "utf8"), before);
  assert.match(out.text, /backup .*\.bak/);

  cli("sync", "claude", "cursor", "--apply", "--force");
  assert.deepEqual(JSON.parse(readFileSync(cursor, "utf8")).mcpServers.clash.args, ["new"]);
  assert.match(cli("sync", "claude", "cursor").text, /0 new, 0 overwrite, 0 conflicts/);
});

test("sync into codex keeps comments and other tables", () => {
  file(".claude.json", json({ gh: { type: "stdio", command: "npx", env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" } } }));
  const toml = '# my settings\nmodel = "gpt-5"\n\n[mcp_servers.gh]\ncommand = "old"\n\n[mcp_servers.gh.env]\nA = "1"\n\n# keep me\n[profiles.fast]\nmodel = "mini"\n';
  file(".codex/config.toml", toml);
  assert.equal(cli("sync", "claude", "codex", "--apply").code, 0);
  assert.match(read(".codex/config.toml"), /command = "old"/);
  cli("sync", "claude", "codex", "--apply", "--force");
  const text = read(".codex/config.toml");
  assert.match(text, /^# my settings$/m);
  assert.match(text, /^# keep me$/m);
  const doc = parseToml(text) as any;
  assert.equal(doc.profiles.fast.model, "mini");
  assert.deepEqual({ ...doc.mcp_servers.gh }, { command: "npx", env_vars: ["GITHUB_TOKEN"] });
});

test("sync creates a missing target and refuses a broken one", () => {
  file(".claude.json", json({ gh: { type: "stdio", command: "npx" } }));
  cli("sync", "claude", "gemini", "--apply");
  assert.deepEqual(JSON.parse(read(".gemini/settings.json")), { mcpServers: { gh: { command: "npx" } } });
  file(".cursor/mcp.json", "{ broken");
  assert.throws(() => cli("sync", "claude", "cursor", "--apply"), /invalid JSON/);
  assert.equal(read(".cursor/mcp.json"), "{ broken");
});

test("convert writes to a file or into an agent config", () => {
  file(".claude.json", json({ api: { type: "http", url: "https://a.dev/mcp", headers: { "X-Key": SECRET } } }));
  const out = join(home, "api.toml");
  assert.equal(cli("convert", "api", "--to", "codex", "--out", out).code, 0);
  assert.deepEqual({ ...(parseToml(readFileSync(out, "utf8")) as any).mcp_servers.api.http_headers }, { "X-Key": SECRET });
  assert.equal(cli("convert", "api", "--to", "codex", "--out", out).code, 1);

  assert.equal(cli("convert", "api", "--to", "cursor", "--apply").code, 0);
  assert.deepEqual(JSON.parse(read(".cursor/mcp.json")).mcpServers.api, { url: "https://a.dev/mcp", headers: { "X-Key": SECRET } });
  assert.match(cli("convert", "api", "--to", "cursor", "--apply").text, /already up to date/);
  assert.throws(() => cli("convert", "nope", "--to", "cursor"), /not found/);
});

test("project mode reads .mcp.json and project agent dirs", () => {
  const project = join(home, "repo");
  mkdirSync(project);
  writeFileSync(join(project, ".mcp.json"), json({ shared: { type: "http", url: "https://s.dev/mcp" } }));
  assert.match(cli("list", "--project", project).text, /^shared\s+http/m);
  cli("sync", "claude", "cursor", "--project", project, "--apply");
  assert.ok(existsSync(join(project, ".cursor/mcp.json")));
  assert.ok(!existsSync(join(home, ".cursor/mcp.json")));
});
