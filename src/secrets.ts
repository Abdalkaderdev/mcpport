import { REF } from "./config.ts";

const SECRET_NAME = /token|secret|passw|api[-_]?key|apikey|auth|credential|cookie|private[-_]?key|access[-_]?key|^key$/i;
const MASK = "***";
const SCHEME = /^(Bearer|Basic|Token)\s+/i;

export function referenceOnly(value: string): boolean {
  return value.replace(REF, "").replace(/\$\{env:[^}]*\}/g, "").replace(SCHEME, "").trim() === "";
}

const mask = (v: string) => (referenceOnly(v) ? v : `${v.match(SCHEME)?.[0] ?? ""}${MASK}`);

export function redactUrl(url: string): string {
  return url
    .replace(/(\/\/[^/:@\s]+:)([^@/\s]+)(@)/, (m, a, pw, b) => (referenceOnly(pw) ? m : `${a}${MASK}${b}`))
    .replace(/([?&])([^=&#]+)=([^&#]*)/g, (m, sep, k, v) => (SECRET_NAME.test(k) ? `${sep}${k}=${mask(v)}` : m));
}

export function redactArgs(args: string[]): string[] {
  return args.map((arg, i) => {
    const eq = arg.match(/^(--?[\w.-]+)=(.*)$/);
    if (eq) return SECRET_NAME.test(eq[1]) ? `${eq[1]}=${mask(eq[2])}` : redactUrl(arg);
    const prev = args[i - 1];
    if (prev && /^--?[\w.-]+$/.test(prev) && SECRET_NAME.test(prev) && !arg.startsWith("-")) return mask(arg);
    return redactUrl(arg);
  });
}

const VALUE_MAPS = new Set(["env", "headers", "http_headers"]);

export function redact(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return key === "args" ? redactArgs(value.map(String)) : value.map((v) => redact(v));
  if (typeof value === "string") return /url$/i.test(key) ? redactUrl(value) : value;
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, VALUE_MAPS.has(key) && typeof v === "string" ? mask(v) : redact(v, k)]),
  );
}

export function plaintextSecrets(s: { args: string[]; env: Record<string, string>; url?: string; headers: Record<string, string> }): string[] {
  const found: string[] = [];
  for (const [k, v] of Object.entries(s.headers)) {
    if (!referenceOnly(v) && (SECRET_NAME.test(k) || /^(Bearer|Basic|Token)\s/i.test(v))) found.push(`header "${k}"`);
  }
  for (const [k, v] of Object.entries(s.env)) if (SECRET_NAME.test(k) && !referenceOnly(v)) found.push(`env "${k}"`);
  if (redactArgs(s.args).join("\0") !== s.args.join("\0")) found.push("args");
  if (s.url && redactUrl(s.url) !== s.url) found.push("url");
  return found;
}
