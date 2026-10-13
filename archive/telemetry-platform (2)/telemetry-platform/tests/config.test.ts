import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTargetConfig, validateTargetConfig } from "../src/config/loadTarget.js";

describe("loadTargetConfig", () => {
  it("loads a valid target.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "target-"));
    const path = join(dir, "target.yaml");
    writeFileSync(
      path,
      `
target:
  id: test-target
  name: "Test Target"
  environment: test
connection:
  type: ssh
  host: 10.0.0.1
  username: ubuntu
  privateKeyPath: /tmp/fake-key.pem
collector:
  intervalSeconds: 5
  logLookbackSeconds: 30
  windowSeconds: 5
storage:
  outputDirectory: ./data/test-target
`,
    );

    const config = loadTargetConfig(path);
    expect(config.id).toBe("test-target");
    expect(config.connection.type).toBe("ssh");
    expect(config.connection.host).toBe("10.0.0.1");
    expect(config.connection.port).toBe(22); // default applied
    expect(config.collector.windowSeconds).toBe(5);
  });

  it("rejects config missing required fields", () => {
    expect(() => validateTargetConfig({ target: {} }, "bad.yaml")).toThrow(
      /target.id is required/,
    );
  });

  it("rejects non-ssh connection types", () => {
    expect(() =>
      validateTargetConfig(
        {
          target: { id: "x", name: "x" },
          connection: { type: "telnet" },
          collector: {},
          storage: { outputDirectory: "./data" },
        },
        "bad.yaml",
      ),
    ).toThrow(/connection.type must be "ssh"/);
  });
});
