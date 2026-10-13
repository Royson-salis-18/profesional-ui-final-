import type { Connection } from "./Connection.js";
import type { RemoteCommand, RemoteCommandResult } from "./RemoteCommand.js";

/**
 * Deterministic in-memory connection for tests (spec section 53:
 * "Do NOT require AWS to run unit tests").
 *
 * Register canned responses per command name; execute() looks them up.
 */
export class FakeConnection implements Connection {
  readonly targetId: string;
  private connected = false;
  private responses = new Map<string, { stdout: string; exitCode: number }>();

  constructor(targetId: string) {
    this.targetId = targetId;
  }

  setResponse(commandName: string, stdout: string, exitCode = 0): void {
    this.responses.set(commandName, { stdout, exitCode });
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async execute<T>(cmd: RemoteCommand<T>): Promise<RemoteCommandResult<T>> {
    if (!this.connected) {
      throw new Error(`Not connected to target ${this.targetId}`);
    }
    const canned = this.responses.get(cmd.name);
    const stdout = canned?.stdout ?? "";
    const exitCode = canned?.exitCode ?? 0;

    let parsed: T | undefined;
    let error: string | undefined;
    if (cmd.parser) {
      try {
        parsed = cmd.parser(stdout);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }

    return {
      name: cmd.name,
      command: cmd.command,
      exitCode,
      stdout,
      stderr: "",
      durationMs: 0,
      truncated: false,
      parsed,
      error,
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}
