declare const Netlify:
  | { env?: { get(name: string): string | undefined } }
  | undefined;

export function env(name: string, fallback?: string): string | undefined {
  const fromNetlify =
    typeof Netlify !== "undefined" ? Netlify.env?.get(name) : undefined;
  return fromNetlify ?? process.env[name] ?? fallback;
}

export function requireEnv(name: string): string {
  const value = env(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function envFlag(name: string, fallback = false): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  return /^(?:1|true|yes|on)$/i.test(value.trim());
}

export function appTimezone(): string {
  return env("APP_TIMEZONE", "Europe/Paris")!;
}
