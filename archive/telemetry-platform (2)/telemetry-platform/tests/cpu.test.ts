import { describe, it, expect } from "vitest";
import { computeCpuPercentFromDelta, CpuDeltaTracker } from "../src/collection/cpu.js";

describe("computeCpuPercentFromDelta", () => {
  it("returns null on the first sample (nothing to diff against)", () => {
    const result = computeCpuPercentFromDelta(
      { totalUsageNs: 1000, systemUsageNs: 10000, onlineCpus: 2 },
      null,
    );
    expect(result).toBeNull();
  });

  it("computes a plausible percentage from two samples", () => {
    const previous = { totalUsageNs: 1_000_000, systemUsageNs: 10_000_000, onlineCpus: 2 };
    const current = { totalUsageNs: 1_500_000, systemUsageNs: 15_000_000, onlineCpus: 2 };
    // cpuDelta=500_000, systemDelta=5_000_000 -> (0.1) * 2 * 100 = 20
    const result = computeCpuPercentFromDelta(current, previous);
    expect(result).toBeCloseTo(20, 5);
  });

  it("returns null when systemDelta is zero or negative (no time elapsed)", () => {
    const previous = { totalUsageNs: 1000, systemUsageNs: 10000, onlineCpus: 2 };
    const current = { totalUsageNs: 1500, systemUsageNs: 10000, onlineCpus: 2 };
    expect(computeCpuPercentFromDelta(current, previous)).toBeNull();
  });

  it("returns null on a counter reset (cpuDelta negative)", () => {
    const previous = { totalUsageNs: 5000, systemUsageNs: 10000, onlineCpus: 2 };
    const current = { totalUsageNs: 100, systemUsageNs: 20000, onlineCpus: 2 }; // restarted, counter reset
    expect(computeCpuPercentFromDelta(current, previous)).toBeNull();
  });

  it("returns null for zero/invalid onlineCpus", () => {
    const previous = { totalUsageNs: 1000, systemUsageNs: 10000, onlineCpus: 2 };
    const current = { totalUsageNs: 2000, systemUsageNs: 20000, onlineCpus: 0 };
    expect(computeCpuPercentFromDelta(current, previous)).toBeNull();
  });
});

describe("CpuDeltaTracker", () => {
  it("tracks previous samples per key independently", () => {
    const tracker = new CpuDeltaTracker();
    expect(tracker.sample("orders", { totalUsageNs: 1000, systemUsageNs: 10000, onlineCpus: 1 })).toBeNull();
    const second = tracker.sample("orders", { totalUsageNs: 1500, systemUsageNs: 15000, onlineCpus: 1 });
    expect(second).toBeCloseTo(10, 5);

    // a different key has its own independent history
    expect(tracker.sample("payment", { totalUsageNs: 500, systemUsageNs: 5000, onlineCpus: 1 })).toBeNull();
  });

  it("reset() clears history for a key, forcing null on the next sample", () => {
    const tracker = new CpuDeltaTracker();
    tracker.sample("orders", { totalUsageNs: 1000, systemUsageNs: 10000, onlineCpus: 1 });
    tracker.reset("orders");
    const result = tracker.sample("orders", { totalUsageNs: 1500, systemUsageNs: 15000, onlineCpus: 1 });
    expect(result).toBeNull();
  });
});
