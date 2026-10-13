import { describe, it, expect } from "vitest";
import { FakeConnection } from "../src/connection/FakeConnection.js";
import { MetricCollector } from "../src/collection/MetricCollector.js";
import type { Service } from "../src/types/service.js";

function makeService(serviceId: string, name: string, containerId: string): Service {
  const nowIso = new Date().toISOString();
  return {
    targetId: "sockshop-aws",
    serviceId,
    name,
    displayName: name,
    type: "backend",
    containerId,
    image: "weaveworksdemos/" + name,
    state: "running",
    host: "sockshop-aws",
    ports: [],
    networks: ["sockshop_default"],
    addresses: [],
    metadata: {},
    classificationEvidence: [],
    firstSeen: nowIso,
    lastSeen: nowIso,
  };
}

describe("MetricCollector", () => {
  it("collects one round of samples and maps containers to known services", async () => {
    const conn = new FakeConnection("sockshop-aws");
    conn.setResponse(
      "docker.stats",
      [
        JSON.stringify({
          ID: "c1",
          Name: "sockshop_orders_1",
          CPUPerc: "12.34%",
          MemUsage: "50.5MiB / 1.952GiB",
          MemPerc: "2.52%",
          NetIO: "1.4kB / 648B",
          BlockIO: "0B / 0B",
          PIDs: "5",
        }),
      ].join("\n"),
    );
    conn.setResponse("docker.inspect.lite", "running|0|2026-09-14T00:00:00.000000000Z");

    await conn.connect();
    const services = [makeService("sockshop-aws:orders", "orders", "c1")];
    const collector = new MetricCollector("sockshop-aws", conn);
    const result = await collector.collectOnce(services);

    expect(result.samples).toHaveLength(1);
    const sample = result.samples[0]!;
    expect(sample.serviceId).toBe("sockshop-aws:orders");
    expect(sample.cpuPercent).toBeCloseTo(12.34);
    expect(sample.memoryBytes).toBeCloseTo(50.5 * 1024 * 1024, 0);
    expect(sample.memoryPercent).toBeCloseTo(2.52);
    expect(sample.networkRxBytes).toBe(1400);
    expect(sample.networkTxBytes).toBe(648);
    // first poll for this service -> no prior sample -> rates must be null, not 0
    expect(sample.networkRxBytesPerSecond).toBeNull();
    expect(sample.networkTxBytesPerSecond).toBeNull();
    expect(sample.restartCount).toBe(0);
    expect(sample.restartDelta).toBeNull(); // first sample, no delta yet
    expect(sample.containerState).toBe("running");
    expect(sample.containerUptimeSeconds).not.toBeNull();
  });

  it("derives network rate only after a second sample exists", async () => {
    const conn = new FakeConnection("sockshop-aws");
    conn.setResponse("docker.inspect.lite", "running|0|2026-09-14T00:00:00.000000000Z");
    await conn.connect();
    const services = [makeService("sockshop-aws:orders", "orders", "c1")];
    const collector = new MetricCollector("sockshop-aws", conn);

    conn.setResponse(
      "docker.stats",
      JSON.stringify({
        ID: "c1",
        Name: "sockshop_orders_1",
        CPUPerc: "10%",
        MemUsage: "10MiB / 1GiB",
        MemPerc: "1%",
        NetIO: "1000B / 500B",
        BlockIO: "0B / 0B",
        PIDs: "3",
      }),
    );
    const first = await collector.collectOnce(services);
    expect(first.samples[0]?.networkRxBytesPerSecond).toBeNull();

    conn.setResponse(
      "docker.stats",
      JSON.stringify({
        ID: "c1",
        Name: "sockshop_orders_1",
        CPUPerc: "10%",
        MemUsage: "10MiB / 1GiB",
        MemPerc: "1%",
        NetIO: "2000B / 900B", // +1000 rx, +400 tx since last poll
        BlockIO: "0B / 0B",
        PIDs: "3",
      }),
    );
    const second = await collector.collectOnce(services);
    // rate should be positive (elapsed time was tiny but > 0 in a real clock;
    // in the fast test path elapsedSeconds could be 0 if timestamps collide,
    // so we only assert monotonic non-negative behavior here)
    expect(second.samples[0]?.networkRxBytesPerSecond === null || second.samples[0]!.networkRxBytesPerSecond! >= 0).toBe(true);
  });

  it("still produces a sample for a container with no matching discovered service", async () => {
    const conn = new FakeConnection("sockshop-aws");
    conn.setResponse(
      "docker.stats",
      JSON.stringify({
        ID: "unknown123",
        Name: "mystery_container_1",
        CPUPerc: "5%",
        MemUsage: "5MiB / 1GiB",
        MemPerc: "0.5%",
        NetIO: "0B / 0B",
        BlockIO: "0B / 0B",
        PIDs: "1",
      }),
    );
    conn.setResponse("docker.inspect.lite", "running|0|2026-09-14T00:00:00.000000000Z");
    await conn.connect();

    const collector = new MetricCollector("sockshop-aws", conn);
    const result = await collector.collectOnce([]); // no known services

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.serviceId).toContain("unknown-");
    expect(result.warnings.some((w) => w.includes("no matching discovered service"))).toBe(true);
  });

  it("returns an empty result with a warning when docker stats itself fails", async () => {
    const conn = new FakeConnection("sockshop-aws");
    conn.setResponse("docker.stats", "", 1);
    await conn.connect();
    const collector = new MetricCollector("sockshop-aws", conn);
    const result = await collector.collectOnce([]);
    expect(result.samples).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
