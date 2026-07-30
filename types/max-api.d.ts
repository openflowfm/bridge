// Node for Max injects this module; it ships no types of its own.
// Only the surface we actually use is declared.

declare module 'max-api' {
  interface MaxAPI {
    /** Writes to the Max console. */
    post(...args: unknown[]): void;
    /** Registers a handler for a message arriving at the node.script inlet. */
    addHandler(name: string, fn: (...args: any[]) => void): void;
    /** Sends a message out of the node.script object's left outlet. */
    outlet(...args: unknown[]): void;
    setDict(name: string, value: unknown): Promise<void>;
    getDict(name: string): Promise<any>;
  }
  const api: MaxAPI;
  export = api;
}
