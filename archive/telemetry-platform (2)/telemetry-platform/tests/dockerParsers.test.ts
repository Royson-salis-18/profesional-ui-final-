import { describe, it, expect } from "vitest";
import { parseDockerPs, parseLabelsString, parsePortsString } from "../src/discovery/parsers/dockerPs.js";
import { parseDockerInspect } from "../src/discovery/parsers/dockerInspect.js";

describe("parseDockerPs", () => {
  it("parses JSON-lines output into entries", () => {
    const stdout = [
      JSON.stringify({
        ID: "abc123",
        Image: "weaveworksdemos/orders",
        Names: "sockshop_orders_1",
        Ports: "0.0.0.0:80->80/tcp",
        Status: "Up 2 hours",
        Labels: "com.docker.compose.project=sockshop,com.docker.compose.service=orders",
      }),
      JSON.stringify({
        ID: "def456",
        Image: "mongo:4",
        Names: "sockshop_orders-db_1",
        Ports: "27017/tcp",
        Status: "Up 2 hours",
      }),
    ].join("\n");

    const { entries, skippedLines } = parseDockerPs(stdout);
    expect(entries).toHaveLength(2);
    expect(skippedLines).toBe(0);
    expect(entries[0]?.Names).toBe("sockshop_orders_1");
  });

  it("skips unparseable or incomplete lines without losing the rest", () => {
    const stdout = [
      "not json at all",
      JSON.stringify({ ID: "abc123", Image: "x", Names: "y" }),
      JSON.stringify({ ID: "missing-fields-only" }),
    ].join("\n");

    const { entries, skippedLines } = parseDockerPs(stdout);
    expect(entries).toHaveLength(1);
    expect(skippedLines).toBe(2);
  });
});

describe("parseLabelsString", () => {
  it("parses comma-separated key=value pairs", () => {
    const labels = parseLabelsString("com.docker.compose.project=sockshop,com.docker.compose.service=orders");
    expect(labels["com.docker.compose.project"]).toBe("sockshop");
    expect(labels["com.docker.compose.service"]).toBe("orders");
  });

  it("returns empty object for undefined input", () => {
    expect(parseLabelsString(undefined)).toEqual({});
  });
});

describe("parsePortsString", () => {
  it("parses mapped and unmapped ports", () => {
    const ports = parsePortsString("0.0.0.0:80->8080/tcp, 8080/tcp");
    expect(ports).toEqual([
      { containerPort: 8080, hostPort: 80, protocol: "tcp" },
      { containerPort: 8080, hostPort: undefined, protocol: "tcp" },
    ]);
  });

  it("returns empty array for undefined input", () => {
    expect(parsePortsString(undefined)).toEqual([]);
  });
});

describe("parseDockerInspect", () => {
  it("extracts state, networks, labels, and restart count", () => {
    const stdout = JSON.stringify([
      {
        Id: "abc123",
        Name: "/sockshop_orders_1",
        RestartCount: 2,
        State: { Status: "running", StartedAt: "2026-01-01T00:00:00Z" },
        Config: {
          Image: "weaveworksdemos/orders",
          Labels: { "com.docker.compose.service": "orders" },
          Env: ["FOO=bar"],
        },
        NetworkSettings: {
          Networks: {
            sockshop_default: { IPAddress: "172.18.0.5", Aliases: ["orders"] },
          },
        },
        Mounts: [{ Source: "/data", Destination: "/var/lib/data" }],
      },
    ]);

    const result = parseDockerInspect(stdout);
    expect(result).not.toBeNull();
    expect(result?.name).toBe("sockshop_orders_1");
    expect(result?.state).toBe("running");
    expect(result?.restartCount).toBe(2);
    expect(result?.networks[0]?.networkName).toBe("sockshop_default");
    expect(result?.networks[0]?.ipAddress).toBe("172.18.0.5");
    expect(result?.labels["com.docker.compose.service"]).toBe("orders");
  });

  it("returns null for unparseable JSON", () => {
    expect(parseDockerInspect("not json")).toBeNull();
  });
});
