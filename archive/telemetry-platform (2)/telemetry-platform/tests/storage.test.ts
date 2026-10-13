import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageManager } from "../src/storage/StorageManager.js";

describe("StorageManager", () => {
  it("creates all layer directories on construction", () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-"));
    new StorageManager(dir);
    for (const layer of ["raw", "normalized", "cleaned", "features", "graph", "analytics"]) {
      expect(() => new StorageManager(join(dir, layer))).not.toThrow();
    }
  });

  it("appends and reads back JSONL records without overwriting", () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-"));
    const storage = new StorageManager(dir);

    storage.appendRecord("raw", "metrics", { serviceId: "orders", cpu: 12.3 });
    storage.appendRecord("raw", "metrics", { serviceId: "orders", cpu: 15.1 });

    const records = storage.readRecords<{ serviceId: string; cpu: number }>(
      "raw",
      "metrics",
    );
    expect(records).toHaveLength(2);
    expect(records[0]?.cpu).toBe(12.3);
    expect(records[1]?.cpu).toBe(15.1);
  });

  it("keeps different datasets in separate files", () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-"));
    const storage = new StorageManager(dir);

    storage.appendRecord("normalized", "metrics", { a: 1 });
    storage.appendRecord("normalized", "logs", { b: 2 });

    expect(storage.readRecords("normalized", "metrics")).toEqual([{ a: 1 }]);
    expect(storage.readRecords("normalized", "logs")).toEqual([{ b: 2 }]);
  });

  it("writes and reads single JSON documents", () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-"));
    const storage = new StorageManager(dir);
    storage.writeJson("graph", "graph.json", { nodes: [], edges: [] });
    expect(storage.readJson("graph", "graph.json")).toEqual({ nodes: [], edges: [] });
  });

  it("returns empty array / null for datasets that do not exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "storage-"));
    const storage = new StorageManager(dir);
    expect(storage.readRecords("raw", "nonexistent")).toEqual([]);
    expect(storage.readJson("raw", "nonexistent.json")).toBeNull();
  });
});
