import { describe, it, expect } from "vitest";
import { FakeConnection } from "../src/connection/FakeConnection.js";
import { DiscoveryEngine } from "../src/discovery/DiscoveryEngine.js";

function makeContainer(
  id: string,
  name: string,
  image: string,
  network = "sockshop_default",
) {
  const serviceName = name.replace(/^sockshop_/, "").replace(/_1$/, "");
  return {
    ps: JSON.stringify({
      ID: id,
      Image: image,
      Names: name,
      Ports: "",
      Status: "Up 1 hour",
      Labels: `com.docker.compose.project=sockshop,com.docker.compose.service=${serviceName}`,
    }),
    inspect: JSON.stringify([
      {
        Id: id,
        Name: `/${name}`,
        RestartCount: 0,
        State: { Status: "running" },
        Config: { Image: image, Labels: {}, Env: [] },
        NetworkSettings: { Networks: { [network]: { IPAddress: "172.18.0.2", Aliases: [] } } },
        Mounts: [],
      },
    ]),
  };
}

describe("DiscoveryEngine", () => {
  it("discovers services and network-candidate dependencies end-to-end", async () => {
    const conn = new FakeConnection("sockshop-aws");
    conn.setResponse("hostname", "ip-10-0-0-1\n");
    conn.setResponse("date.utc", "2026-09-14T00:00:00.000Z\n");
    conn.setResponse("uname.all", "Linux ip-10-0-0-1 5.15.0\n");
    conn.setResponse("docker.version", '{"Client":{"Version":"24.0"}}');

    const orders = makeContainer("c1", "sockshop_orders_1", "weaveworksdemos/orders");
    const ordersDb = makeContainer("c2", "sockshop_orders-db_1", "mongo:4");
    const payment = makeContainer("c3", "sockshop_payment_1", "weaveworksdemos/payment");

    conn.setResponse("docker.ps", [orders.ps, ordersDb.ps, payment.ps].join("\n"));

    // docker.inspect is keyed only by command *name* in FakeConnection, but
    // each call targets a different container id — wrap execute() to pick
    // the right canned inspect payload based on the actual command string.
    const inspectByContainer: Record<string, string> = {
      c1: orders.inspect,
      c2: ordersDb.inspect,
      c3: payment.inspect,
    };
    const originalExecute = conn.execute.bind(conn);
    conn.execute = (async (cmd: { name: string; command: string }) => {
      if (cmd.name === "docker.inspect") {
        const match = cmd.command.match(/docker inspect (\S+)/);
        const id = match?.[1] ?? "";
        conn.setResponse("docker.inspect", inspectByContainer[id] ?? "");
      }
      return originalExecute(cmd as never);
    }) as typeof conn.execute;

    await conn.connect();
    const engine = new DiscoveryEngine("sockshop-aws", conn);
    const result = await engine.discover();

    expect(result.architecture.target.dockerAvailable).toBe(true);
    expect(result.services).toHaveLength(3);

    const names = result.services.map((s) => s.name).sort();
    expect(names).toEqual(["orders", "orders-db", "payment"]);

    const ordersService = result.services.find((s) => s.name === "orders");
    expect(ordersService?.serviceId).toBe("sockshop-aws:orders");
    expect(ordersService?.type).toBe("backend");

    const ordersDbService = result.services.find((s) => s.name === "orders-db");
    expect(ordersDbService?.type).toBe("database");

    expect(result.dependencies.length).toBeGreaterThan(0);
    for (const dep of result.dependencies) {
      expect(dep.declared).toBe(false);
      expect(dep.observed).toBe(false);
      expect(dep.evidenceSources).toContain("docker-network");
    }
  });

  it("returns empty services/dependencies but still reports host metadata when Docker is unavailable", async () => {
    const conn = new FakeConnection("broken-target");
    conn.setResponse("hostname", "broken-host\n");
    conn.setResponse("date.utc", "2026-09-14T00:00:00.000Z\n");
    conn.setResponse("uname.all", "Linux broken-host\n");
    conn.setResponse("docker.version", "", 1);

    await conn.connect();
    const engine = new DiscoveryEngine("broken-target", conn);
    const result = await engine.discover();

    expect(result.architecture.target.dockerAvailable).toBe(false);
    expect(result.architecture.target.hostname).toBe("broken-host");
    expect(result.services).toEqual([]);
    expect(result.dependencies).toEqual([]);
    expect(result.architecture.warnings.length).toBeGreaterThan(0);
  });
});
