'use strict';
const Session = require('./session');
const { EditManager } = require('./editor');

/**
 * Several servers connected at the same time - FileZilla's tabs.
 * Each tab owns a Session (its own control + transfer connections, its own
 * queue) and its own set of files being edited. Events are tagged with the
 * session id so the UI knows which tab they belong to.
 */
class SessionManager {
  constructor(emit, getSettings) {
    this.rawEmit = emit;
    this.getSettings = getSettings;
    this.entries = new Map();   // id -> { id, session, edits }
    this.order = [];
    this.activeId = null;
    this.seq = 0;
  }

  create() {
    this.seq += 1;
    const id = 'tab' + this.seq;
    const emit = (msg) => this.rawEmit(Object.assign({ sessionId: id }, msg));

    const session = new Session(emit, id);
    session.settings = this.getSettings();
    const edits = new EditManager(session, emit, this.getSettings);

    this.entries.set(id, { id, session, edits });
    this.order.push(id);
    if (!this.activeId) this.activeId = id;
    this.announce();
    return id;
  }

  get(id) {
    const wanted = id || this.activeId;
    const entry = this.entries.get(wanted);
    if (!entry) throw new Error('No such tab: ' + wanted);
    return entry;
  }

  has(id) {
    return this.entries.has(id);
  }

  /** The tab used when a call does not name one. */
  ensureDefault() {
    if (!this.order.length) this.create();
    if (!this.activeId || !this.entries.has(this.activeId)) this.activeId = this.order[0];
    return this.activeId;
  }

  activate(id) {
    if (!this.entries.has(id)) throw new Error('No such tab: ' + id);
    this.activeId = id;
    this.announce();
    return this.list();
  }

  busy(id) {
    const { session } = this.get(id);
    return session.queue.some((q) => q.status === 'active' || q.status === 'queued');
  }

  async close(id, force) {
    const entry = this.get(id);
    if (!force && this.busy(id)) {
      const err = new Error('Cannot close tab while busy.');
      err.code = 'TAB_BUSY';
      throw err;
    }
    entry.session.cancelQueued();
    entry.edits.stopAll();
    await entry.session.disconnect().catch(() => {});

    this.entries.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.activeId === id) this.activeId = this.order[0] || null;
    if (!this.order.length) this.create();     // always keep one tab open
    this.announce();
    return this.list();
  }

  title(entry) {
    const { info } = entry.session;
    if (!info) return 'Not connected';
    return info.siteName || `${info.user}@${info.host}`;
  }

  list() {
    return {
      activeId: this.activeId,
      tabs: this.order.map((id) => {
        const entry = this.entries.get(id);
        const status = entry.session.status();
        return {
          id,
          title: this.title(entry),
          connected: status.connected,
          connections: status.connections,
          host: status.info ? status.info.host : '',
          path: status.info ? status.info.home : '',
          busy: entry.session.queue.some((q) => q.status === 'active'),
          queued: entry.session.queue.filter((q) => q.status === 'queued' || q.status === 'active').length,
          editing: entry.edits.list().length,
        };
      }),
    };
  }

  announce() {
    this.rawEmit({ type: 'tabs', tabs: this.list() });
  }

  applySettings(settings) {
    for (const entry of this.entries.values()) entry.session.settings = settings;
  }

  async shutdown() {
    for (const entry of this.entries.values()) {
      entry.edits.stopAll();
      await entry.session.disconnect().catch(() => {});
    }
    this.entries.clear();
    this.order = [];
    this.activeId = null;
  }
}

module.exports = SessionManager;
