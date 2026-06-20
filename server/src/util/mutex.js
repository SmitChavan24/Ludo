// A tiny async mutex: serializes async operations so money-touching code can
// never interleave (no double-spend from two concurrent withdrawals/bets).
// Every `run` waits for the previous one to finish before executing.
export class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  run(fn) {
    const result = this._tail.then(() => fn());
    // Keep the chain alive even if `fn` rejects, so one failure can't wedge it.
    this._tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
