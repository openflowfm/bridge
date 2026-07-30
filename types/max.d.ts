// Ambient declarations for Max's [v8] JavaScript environment.
//
// This is NOT Node. There is no module system, no require, no fs. Message
// handlers are discovered by Max as top-level global function declarations,
// which is why lom.ts compiles with `module: "none"`.

/** Set to 1 to make Max reload the script when the file changes. */
declare var autowatch: number;
declare var inlets: number;
declare var outlets: number;
/** Arguments after the script name in the object box. */
declare var jsarguments: unknown[];
/** Name of the message currently being handled — set inside `anything()`. */
declare var messagename: string;

declare function outlet(index: number, ...args: unknown[]): void;
declare function post(...args: unknown[]): void;
declare function error(...args: unknown[]): void;
declare function cpost(...args: unknown[]): void;

/**
 * A cursor into the Live Object Model.
 *
 * `get` returns Max atoms: almost always an array, even for single values, and
 * a multi-word symbol may arrive either as one element or several. Never trust
 * the shape — go through the gstr/gnum helpers in lom.ts.
 */
declare class LiveAPI {
  constructor(callback?: ((args: unknown[]) => void) | null, path?: string);
  /** `0` (or `"0"`) when the current path resolves to nothing. */
  readonly id: string | number;
  path: string;
  /** Assign a property name to start observing it; assign `''` to stop. */
  property: string;
  mode: number;
  goto(path: string): void;
  get(property: string): unknown;
  set(property: string, ...value: unknown[]): void;
  call(fn: string, ...args: unknown[]): unknown;
  getcount(child: string): number;
}

/** Max dictionary — how large payloads cross between v8 and Node for Max. */
declare class Dict {
  constructor(name?: string);
  name: string;
  parse(json: string): void;
  stringify(): string;
  clear(): void;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** Max's scheduler. Used to chunk LOM writes so Live's main thread breathes. */
declare class Task {
  constructor(fn: () => void, context?: unknown);
  interval: number;
  repeat(count?: number): void;
  cancel(): void;
  schedule(ms?: number): void;
}
