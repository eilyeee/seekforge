"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("../src/emitter.js");

test("on + emit calls listeners in order with args (regression)", () => {
  const e = new EventEmitter();
  const seen = [];
  e.on("x", (a) => seen.push("first:" + a));
  e.on("x", (a) => seen.push("second:" + a));
  e.emit("x", 7);
  assert.deepStrictEqual(seen, ["first:7", "second:7"]);
});

test("off removes an on listener (regression)", () => {
  const e = new EventEmitter();
  let n = 0;
  const fn = () => { n++; };
  e.on("x", fn); e.off("x", fn); e.emit("x");
  assert.strictEqual(n, 0);
});

test("once fires at most once", () => {
  const e = new EventEmitter();
  let n = 0;
  e.once("x", () => { n++; });
  e.emit("x"); e.emit("x"); e.emit("x");
  assert.strictEqual(n, 1);
});

test("a once listener can be removed by off BEFORE it fires", () => {
  const e = new EventEmitter();
  let n = 0;
  const fn = () => { n++; };
  e.once("x", fn);
  e.off("x", fn);
  e.emit("x");
  assert.strictEqual(n, 0);
});

test("a once listener removing itself mid-emit does not skip the next listener", () => {
  const e = new EventEmitter();
  const seen = [];
  e.once("x", () => seen.push("once"));
  e.on("x", () => seen.push("on"));
  e.emit("x");
  assert.deepStrictEqual(seen, ["once", "on"]);
});

test("once and on preserve registration order across emits", () => {
  const e = new EventEmitter();
  const seen = [];
  e.on("x", () => seen.push("A"));
  e.once("x", () => seen.push("B-once"));
  e.on("x", () => seen.push("C"));
  e.emit("x");
  e.emit("x");
  assert.deepStrictEqual(seen, ["A", "B-once", "C", "A", "C"]);
});
