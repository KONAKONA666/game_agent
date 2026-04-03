export default class Network {
  name = 'network';

  _handlers = new Map();
  _sessionId = null;
  _room = null;
  _offline = false;
  _connected = false;
  _ctx = null;

  async build(ctx) {
    this._ctx = ctx;
    ctx.modules.network = this;

    try {
      const client = new ColyseusClient(ctx.wsUrl);
      const connectPromise = client.joinOrCreate('game');
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3000)
      );
      const room = await Promise.race([connectPromise, timeoutPromise]);
      this._room = room;

      // Listen for session ID from server
      room.onMessage('__sessionId', (payload) => {
        this._sessionId = payload.sessionId;
        this._invokeHandlers('__sessionId', payload);
      });

      // If room already has a sessionId property
      if (room.sessionId) {
        this._sessionId = room.sessionId;
      }

      // Forward all registered message types through room
      room.onMessage('*', (type, payload) => {
        // Colyseus wildcard: type is the message type, payload is the data
        if (type === '__sessionId') return; // already handled above
        this._invokeHandlers(type, payload);
      });

      this._connected = true;
    } catch (e) {
      console.warn('Network: WebSocket connection failed, switching to singleplayer fallback.', e.message);
      this._offline = true;
      this._sessionId = 'solo_' + this._generateUUID();
      this._connected = true;
    }
  }

  start() {
    if (this._ctx) {
      this._ctx.eventBus.dispatchEvent(new CustomEvent('network:connected', {
        detail: { sessionId: this._sessionId, offline: this._offline }
      }));
    }
  }

  update(dt) {}

  dispose() {
    if (this._room) {
      this._room.leave();
      this._room = null;
    }
    this._handlers.clear();
  }

  send(type, payload) {
    if (this._offline) {
      // Loopback: invoke local handlers directly
      this._invokeHandlers(type, payload);
      return;
    }
    if (this._room) {
      this._room.send(type, payload);
    }
  }

  onMessage(type, cb) {
    if (!this._handlers.has(type)) {
      this._handlers.set(type, new Set());
    }
    this._handlers.get(type).add(cb);

    // If online and room exists, also register on room for this specific type
    // (wildcard handler above covers this, so no extra registration needed)
  }

  getSessionId() {
    return this._sessionId;
  }

  _invokeHandlers(type, payload) {
    const handlers = this._handlers.get(type);
    if (handlers) {
      for (const cb of handlers) {
        try {
          cb(payload);
        } catch (e) {
          console.error(`Network handler error [${type}]:`, e);
        }
      }
    }
  }

  _generateUUID() {
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}
