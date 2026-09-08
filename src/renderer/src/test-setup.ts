// vitest 4.1.10 + jsdom 30.0.1: localStorage/sessionStorage
// are not auto-exposed as globals. Polyfill with in-memory store.

function createStorage(): Storage {
  const store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    clear() {
      Object.keys(store).forEach((k) => delete store[k]);
    },
    getItem(k: string) {
      return Object.hasOwn(store, k) ? store[k] : null;
    },
    key(i: number) {
      return Object.keys(store)[i] ?? null;
    },
    removeItem(k: string) {
      delete store[k];
    },
    setItem(k: string, v: string) {
      store[k] = String(v);
    },
  };
}

if (typeof (globalThis as any).localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: createStorage(),
    writable: true,
    configurable: true,
  });
}
if (typeof (globalThis as any).sessionStorage === "undefined") {
  Object.defineProperty(globalThis, "sessionStorage", {
    value: createStorage(),
    writable: true,
    configurable: true,
  });
}
