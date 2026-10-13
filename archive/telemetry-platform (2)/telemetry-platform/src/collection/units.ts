/**
 * Docker's CLI output mixes binary units (KiB/MiB/GiB, used for memory)
 * and decimal units (kB/MB/GB, used for network/block IO) — this parser
 * handles both so downstream code never stores human-formatted strings
 * (spec section 12: "Avoid storing only human-formatted strings").
 */

const UNIT_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

export function parseByteSize(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "--") return null;

  const match = trimmed.match(/^([\d.]+)\s*([a-zA-Z]*)$/);
  if (!match) return null;

  const [, numStr, unitRaw] = match;
  const num = Number(numStr);
  if (!Number.isFinite(num)) return null;

  const unit = (unitRaw || "b").toLowerCase();
  const multiplier = UNIT_MULTIPLIERS[unit];
  if (multiplier === undefined) return null;

  return num * multiplier;
}

/** e.g. "1.4kB / 648B" -> { rx: 1400, tx: 648 } */
export function parseByteSizePair(raw: string | undefined | null): {
  rx: number | null;
  tx: number | null;
} {
  if (!raw) return { rx: null, tx: null };
  const parts = raw.split("/");
  if (parts.length !== 2) return { rx: null, tx: null };
  return {
    rx: parseByteSize(parts[0]),
    tx: parseByteSize(parts[1]),
  };
}

export function parsePercent(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "--") return null;
  const num = Number(trimmed.replace("%", ""));
  return Number.isFinite(num) ? num : null;
}

export function parsePids(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "--") return null;
  const num = Number(trimmed);
  return Number.isInteger(num) ? num : null;
}
