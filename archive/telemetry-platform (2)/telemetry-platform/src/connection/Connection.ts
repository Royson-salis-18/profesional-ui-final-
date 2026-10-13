import type { RemoteCommand, RemoteCommandResult } from "./RemoteCommand.js";

/**
 * Transport-agnostic connection interface. SSHConnection is the real
 * implementation; tests use an in-memory FakeConnection instead of
 * requiring live AWS/SSH access (spec section 53).
 */
export interface Connection {
  readonly targetId: string;
  connect(): Promise<void>;
  isConnected(): boolean;
  execute<T>(cmd: RemoteCommand<T>): Promise<RemoteCommandResult<T>>;
  disconnect(): Promise<void>;
}
