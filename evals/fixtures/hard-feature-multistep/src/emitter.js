"use strict";

// A minimal event emitter. It supports on/off/emit but NOT once yet.
class EventEmitter {
  constructor() {
    this._map = new Map(); // event -> array of listener functions
  }
  on(event, fn) {
    const a = this._map.get(event) || [];
    a.push(fn);
    this._map.set(event, a);
    return this;
  }
  off(event, fn) {
    const a = this._map.get(event);
    if (!a) return this;
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
    return this;
  }
  emit(event, ...args) {
    const a = this._map.get(event);
    if (!a) return false;
    for (const fn of a.slice()) fn(...args);
    return a.length > 0;
  }
}

module.exports = { EventEmitter };
