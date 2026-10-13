import { describe, it, expect } from "vitest";
import { REMOTE_COMMANDS } from "../src/connection/RemoteCommand.js";
import { FakeConnection } from "../src/connection/FakeConnection.js";

describe("RemoteCommand sanitizers", () => {
  it("builds a docker.inspect command for a safe container id", () => {
    const cmd = REMOTE_COMMANDS.dockerInspect("orders_abc123");
    expect(cmd.command).toBe("docker inspect orders_abc123");
  });

  it("refuses to build a command from an unsafe identifier", () => {
    expect(() => REMOTE_COMMANDS.dockerInspect("orders; rm -rf /")).toThrow(
      /unsafe identifier/,
    );
  });

  it("refuses an invalid ISO timestamp for docker logs --since", () => {
    expect(() =>
      REMOTE_COMMANDS.dockerLogs("orders_abc123", "not-a-timestamp", 100),
    ).toThrow(/invalid ISO timestamp/);
  });

  it("refuses an unsafe tail line count", () => {
    expect(() =>
      REMOTE_COMMANDS.dockerLogs("orders_abc123", new Date().toISOString(), -5),
    ).toThrow(/unsafe tail line count/);
  });

  it("applies timeout and output-size bounds on every zero-arg command", () => {
    const zeroArgBuilders = [
      REMOTE_COMMANDS.unameAll,
      REMOTE_COMMANDS.hostname,
      REMOTE_COMMANDS.dateUtc,
      REMOTE_COMMANDS.dockerVersion,
      REMOTE_COMMANDS.dockerPs,
      REMOTE_COMMANDS.dockerStats,
      REMOTE_COMMANDS.ssLtnp,
    ];
    for (const build of zeroArgBuilders) {
      const cmd = build();
      expect(cmd.timeoutMs).toBeGreaterThan(0);
      expect(cmd.maxOutputBytes).toBeGreaterThan(0);
    }
  });
});

describe("FakeConnection", () => {
  it("requires connect() before execute()", async () => {
    const conn = new FakeConnection("test-target");
    await expect(conn.execute(REMOTE_COMMANDS.hostname())).rejects.toThrow(
      /Not connected/,
    );
  });

  it("returns canned output and runs the parser", async () => {
    const conn = new FakeConnection("test-target");
    conn.setResponse("hostname", "orders-host\n");
    await conn.connect();
    const result = await conn.execute(REMOTE_COMMANDS.hostname());
    expect(result.parsed).toBe("orders-host");
    expect(result.exitCode).toBe(0);
  });

  it("surfaces a parser error without throwing", async () => {
    const conn = new FakeConnection("test-target");
    conn.setResponse("docker.ps", "not json{{{");
    await conn.connect();
    const badParser = {
      name: "docker.ps",
      command: "docker ps",
      timeoutMs: 1000,
      maxOutputBytes: 1000,
      parser: (out: string) => JSON.parse(out),
    };
    const result = await conn.execute(badParser);
    expect(result.parsed).toBeUndefined();
    expect(result.error).toBeDefined();
  });
});
