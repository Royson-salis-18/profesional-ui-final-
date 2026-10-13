import { mkdirSync, appendFileSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Layered dataset storage: raw / normalized / cleaned / features / graph / analytics.
 * Each logical dataset (services, dependencies, metrics, logs, interactions, ...)
 * is kept in its own JSONL file — never immediately flattened into one table
 * (spec section 23).
 */
export type StorageLayer =
  | "raw"
  | "normalized"
  | "cleaned"
  | "features"
  | "graph"
  | "analytics";

export class StorageManager {
  constructor(private readonly outputDirectory: string) {
    for (const layer of [
      "raw",
      "normalized",
      "cleaned",
      "features",
      "graph",
      "analytics",
    ] satisfies StorageLayer[]) {
      mkdirSync(join(outputDirectory, layer), { recursive: true });
    }
  }

  private pathFor(layer: StorageLayer, dataset: string): string {
    return join(this.outputDirectory, layer, `${dataset}.jsonl`);
  }

  /** Append one record as a JSONL line. Never overwrites prior evidence. */
  appendRecord(layer: StorageLayer, dataset: string, record: unknown): void {
    const line = JSON.stringify(record) + "\n";
    appendFileSync(this.pathFor(layer, dataset), line, "utf8");
  }

  appendRecords(layer: StorageLayer, dataset: string, records: unknown[]): void {
    if (records.length === 0) return;
    const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    appendFileSync(this.pathFor(layer, dataset), lines, "utf8");
  }

  /** Read all records from a JSONL dataset (used by later pipeline phases / tests). */
  readRecords<T = unknown>(layer: StorageLayer, dataset: string): T[] {
    const path = this.pathFor(layer, dataset);
    if (!existsSync(path)) return [];
    const content = readFileSync(path, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  }

  /** Write a single JSON document (e.g. architecture.json, graph.json, metadata). */
  writeJson(layer: StorageLayer, filename: string, data: unknown): void {
    const path = join(this.outputDirectory, layer, filename);
    writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  }

  readJson<T = unknown>(layer: StorageLayer, filename: string): T | null {
    const path = join(this.outputDirectory, layer, filename);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }

  resolvePath(layer: StorageLayer, filename: string): string {
    return join(this.outputDirectory, layer, filename);
  }
}
