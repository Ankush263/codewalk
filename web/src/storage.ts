// Where predictions live: this browser only (spec Decision 3). localStorage can throw (private mode,
// blocked site data), so every access is guarded and the page works without it.

export interface PredictionStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function browserStorage(): PredictionStore {
  return {
    get: (key) => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Not persisted; the prediction still shows for this page view.
      }
    },
  };
}

export function memoryStorage(): PredictionStore {
  const values = new Map<string, string>();
  return { get: (key) => values.get(key) ?? null, set: (key, value) => void values.set(key, value) };
}
