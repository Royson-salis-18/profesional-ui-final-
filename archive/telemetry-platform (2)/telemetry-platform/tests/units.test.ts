import { describe, it, expect } from "vitest";
import { parseByteSize, parseByteSizePair, parsePercent, parsePids } from "../src/collection/units.js";

describe("parseByteSize", () => {
  it("parses binary units (memory)", () => {
    expect(parseByteSize("50.5MiB")).toBeCloseTo(50.5 * 1024 * 1024, 0);
    expect(parseByteSize("1.952GiB")).toBeCloseTo(1.952 * 1024 ** 3, 0);
  });

  it("parses decimal units (network/block IO)", () => {
    expect(parseByteSize("1.4kB")).toBeCloseTo(1400, 0);
    expect(parseByteSize("648B")).toBe(648);
  });

  it("returns null for missing/placeholder values", () => {
    expect(parseByteSize(undefined)).toBeNull();
    expect(parseByteSize("-")).toBeNull();
    expect(parseByteSize("")).toBeNull();
  });

  it("returns null for unrecognized units instead of guessing", () => {
    expect(parseByteSize("5furlongs")).toBeNull();
  });
});

describe("parseByteSizePair", () => {
  it("splits rx/tx pairs", () => {
    expect(parseByteSizePair("1.4kB / 648B")).toEqual({ rx: 1400, tx: 648 });
  });

  it("returns nulls for malformed pairs", () => {
    expect(parseByteSizePair("not-a-pair")).toEqual({ rx: null, tx: null });
    expect(parseByteSizePair(undefined)).toEqual({ rx: null, tx: null });
  });
});

describe("parsePercent", () => {
  it("parses a percentage string", () => {
    expect(parsePercent("12.34%")).toBeCloseTo(12.34);
  });
  it("returns null for placeholders", () => {
    expect(parsePercent("--")).toBeNull();
    expect(parsePercent(undefined)).toBeNull();
  });
});

describe("parsePids", () => {
  it("parses an integer pid count", () => {
    expect(parsePids("12")).toBe(12);
  });
  it("returns null for non-integer or placeholder values", () => {
    expect(parsePids("-")).toBeNull();
    expect(parsePids("abc")).toBeNull();
  });
});
