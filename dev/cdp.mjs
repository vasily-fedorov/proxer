export class Cdp {
  #ws;
  #nextId = 0;
  #pending = new Map();
  #waiters = [];
  #closed = false;

  constructor(ws) {
    this.#ws = ws;

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);

      if (message.id && this.#pending.has(message.id)) {
        const { resolve, reject } = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result || {});
        return;
      }

      if (!message.method) return;
      const index = this.#waiters.findIndex(
        (waiter) => waiter.method === message.method && (!waiter.sessionId || waiter.sessionId === message.sessionId)
      );
      if (index < 0) return;
      const [waiter] = this.#waiters.splice(index, 1);
      waiter.resolve(message.params || {});
    });

    ws.addEventListener("close", () => {
      this.#closed = true;
      for (const { reject } of this.#pending.values()) reject(new Error("CDP-соединение закрыто"));
      this.#pending.clear();
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`Не удалось подключиться к ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(new Error("CDP-соединение закрыто"));
    const id = ++this.#nextId;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify(message));
    });
  }

  waitFor(method, sessionId, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const waiter = { method, sessionId, resolve: null };
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((item) => item !== waiter);
        reject(new Error(`Таймаут ожидания события ${method}`));
      }, timeoutMs);

      waiter.resolve = (params) => {
        clearTimeout(timer);
        resolve(params);
      };
      this.#waiters.push(waiter);
    });
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* уже закрыт */
    }
  }
}
