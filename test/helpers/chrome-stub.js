export function createChromeStub(initial = {}) {
  const storage = new Map(Object.entries(initial));
  const calls = { set: [], clear: [], remove: [], get: 0 };
  let setError = null;
  let setErrorTimes = 0;
  let levelOfControl = "controllable_by_this_extension";

  const session = new Map();

  const chrome = {
    storage: {
      session: {
        async get(key) {
          return session.has(key) ? { [key]: structuredClone(session.get(key)) } : {};
        },
        async set(entries) {
          for (const [key, value] of Object.entries(entries)) session.set(key, structuredClone(value));
        },
        async remove(key) {
          session.delete(key);
        }
      },
      local: {
        async get(key) {
          calls.get += 1;
          return storage.has(key) ? { [key]: structuredClone(storage.get(key)) } : {};
        },
        async set(entries) {
          for (const [key, value] of Object.entries(entries)) storage.set(key, structuredClone(value));
        },
        async remove(key) {
          calls.remove.push(key);
          storage.delete(key);
        }
      }
    },
    proxy: {
      settings: {
        async get() {
          return { levelOfControl };
        },
        async set({ value, scope }) {
          if (setErrorTimes > 0) {
            setErrorTimes -= 1;
            throw new Error(setError);
          }
          calls.set.push({ value: structuredClone(value), scope });
        },
        async clear({ scope }) {
          calls.clear.push({ scope });
        }
      }
    }
  };

  return {
    chrome,
    calls,
    storage,
    session,
    failNextSet(message) {
      setError = message;
      setErrorTimes = 1;
    },
    setLevelOfControl(level) {
      levelOfControl = level;
    }
  };
}
