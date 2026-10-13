import type { Connection } from "./Connection.js";
import { SSHConnection } from "./SSHConnection.js";
import type { TargetConfig } from "../types/target.js";

export interface ConnectionManagerOptions {
  maxRetries?: number;
  backoffMs?: number;
}

/**
 * Owns the lifecycle of a Connection for a given target. Does NOT
 * permanently depend on an interactive terminal — connect() can be
 * called repeatedly by a background collection loop.
 */
export class ConnectionManager {
  private connection: Connection | null = null;

  constructor(
    private readonly target: TargetConfig,
    private readonly options: ConnectionManagerOptions = {},
  ) {}

  async getConnection(): Promise<Connection> {
    if (this.connection?.isConnected()) {
      return this.connection;
    }

    const maxRetries = this.options.maxRetries ?? 3;
    const backoffMs = this.options.backoffMs ?? 2_000;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const conn = this.buildConnection();
        await conn.connect();
        this.connection = conn;
        return conn;
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          await sleep(backoffMs * attempt);
        }
      }
    }
    throw new Error(
      `Failed to connect to target ${this.target.id} after ${maxRetries} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  private buildConnection(): Connection {
    switch (this.target.connection.type) {
      case "ssh":
        return new SSHConnection(this.target.id, this.target.connection);
      default:
        throw new Error(
          `Unsupported connection type: ${(this.target.connection as { type: string }).type}`,
        );
    }
  }

  async close(): Promise<void> {
    await this.connection?.disconnect();
    this.connection = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
