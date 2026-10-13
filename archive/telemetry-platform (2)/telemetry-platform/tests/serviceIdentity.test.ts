import { describe, it, expect } from "vitest";
import { deriveServiceName, buildServiceId } from "../src/discovery/serviceIdentity.js";
import { classifyService } from "../src/discovery/classifyService.js";

describe("deriveServiceName", () => {
  it("prefers the compose service label", () => {
    expect(
      deriveServiceName("sockshop_orders_1", { "com.docker.compose.service": "orders" }),
    ).toBe("orders");
  });

  it("strips compose project underscore prefix and replica suffix", () => {
    expect(
      deriveServiceName("sockshop_orders_1", { "com.docker.compose.project": "sockshop" }),
    ).toBe("orders");
  });

  it("strips compose project hyphen prefix", () => {
    expect(
      deriveServiceName("sockshop-orders-1", { "com.docker.compose.project": "sockshop" }),
    ).toBe("orders");
  });

  it("falls back to the raw container name when no compose evidence exists", () => {
    expect(deriveServiceName("standalone-service", {})).toBe("standalone-service");
  });
});

describe("buildServiceId", () => {
  it("is stable and deterministic for the same inputs", () => {
    const id1 = buildServiceId("sockshop-aws", "orders");
    const id2 = buildServiceId("sockshop-aws", "orders");
    expect(id1).toBe(id2);
    expect(id1).toBe("sockshop-aws:orders");
  });

  it("normalizes unsafe characters", () => {
    expect(buildServiceId("target", "Orders DB!")).toBe("target:orders-db-");
  });
});

describe("classifyService", () => {
  it("classifies a database by image", () => {
    const result = classifyService({
      name: "orders-db",
      image: "mongo:4",
      ports: [27017],
      labels: {},
    });
    expect(result.type).toBe("database");
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("classifies a queue by image and name", () => {
    const result = classifyService({
      name: "rabbitmq",
      image: "rabbitmq:3-management",
      ports: [5672],
      labels: {},
    });
    expect(result.type).toBe("queue");
  });

  it("classifies a gateway from name pattern", () => {
    const result = classifyService({
      name: "edge-router",
      image: "weaveworksdemos/edge-router",
      ports: [80],
      labels: {},
    });
    expect(result.type).toBe("gateway");
  });

  it("falls back to backend when nothing matches", () => {
    const result = classifyService({
      name: "orders",
      image: "weaveworksdemos/orders",
      ports: [8080],
      labels: {},
    });
    expect(result.type).toBe("backend");
  });
});
