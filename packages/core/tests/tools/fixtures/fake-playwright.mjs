/**
 * A scriptable stand-in for `playwright-core`.
 *
 * The browser tools import Playwright through the `SEEKFORGE_PLAYWRIGHT`
 * specifier override, which exists so a user can point at an installation
 * outside this package. The tests reuse that same door to point at this file:
 * no test-only seam in the production code, and everything from the navigation
 * capture reset to the permission level derived from the page's own URL runs
 * for real.
 *
 * Tests drive it through `globalThis.__fakePlaywright`, which they reset first.
 */

function state() {
  globalThis.__fakePlaywright ??= {};
  const s = globalThis.__fakePlaywright;
  s.url ??= "about:blank";
  s.actions ??= [];
  s.failures ??= {};
  s.navigateTo ??= {};
  s.emitErrorOn ??= {};
  s.selectResult ??= ["default-value"];
  s.snapshot ??= {
    title: "Fake",
    url: s.url,
    headings: [],
    links: [],
    buttons: [],
    inputs: [],
    text: "",
  };
  s.handlers ??= { console: [], pageerror: [], requestfailed: [] };
  return s;
}

/** Fail the next call for `selector` with a scripted error, if one was staged. */
function maybeFail(kind, selector) {
  const staged = state().failures[selector];
  if (!staged) return;
  delete state().failures[selector];
  const error = new Error(staged.message);
  if (staged.name) error.name = staged.name;
  error.kind = kind;
  throw error;
}

/** Apply the side effects a selector was scripted to have. */
function applyEffects(selector) {
  const s = state();
  const next = s.navigateTo[selector];
  if (next) s.url = next;
  // One-shot: a scripted page error fires on the FIRST action against the
  // selector, so a two-step tool (fill + submit) can be tested for reporting
  // errors from each step separately.
  const message = s.emitErrorOn[selector];
  if (message) {
    delete s.emitErrorOn[selector];
    for (const cb of s.handlers.pageerror) cb(new Error(message));
  }
}

function createPage() {
  const s = state();
  return {
    on(event, cb) {
      s.handlers[event] ??= [];
      s.handlers[event].push(cb);
    },
    async goto(url) {
      s.actions.push({ type: "goto", url });
      maybeFail("goto", url);
      s.url = url;
      for (const cb of s.handlers.console) cb({ type: () => "log", text: () => `navigated to ${url}` });
      return { status: () => s.status ?? 200 };
    },
    async title() {
      maybeFail("title", "title");
      return s.snapshot.title;
    },
    url() {
      return s.url;
    },
    async screenshot({ path } = {}) {
      s.actions.push({ type: "screenshot", path });
      maybeFail("screenshot", "screenshot");
      if (path) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(path, "fake-png");
      }
    },
    async evaluate(fn, arg) {
      // With a `dom` script, run the tool's own extraction function against a
      // minimal document so the real snapshot logic is exercised rather than
      // replaced by a canned answer. querySelectorAll answers by exact selector
      // string, which is all the extraction uses.
      if (!s.dom) return { ...s.snapshot, url: s.url };
      const doc = {
        title: s.snapshot.title,
        body: { innerText: s.bodyText ?? "" },
        querySelectorAll: (selector) => s.dom[selector] ?? [],
      };
      const restore = [];
      for (const [key, value] of [
        ["document", doc],
        ["location", { href: s.url }],
      ]) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
        restore.push(() => {
          if (previous) Object.defineProperty(globalThis, key, previous);
          else delete globalThis[key];
        });
      }
      try {
        return await fn(arg);
      } finally {
        for (const undo of restore) undo();
      }
    },
    async click(selector, opts) {
      s.actions.push({ type: "click", selector, opts });
      maybeFail("click", selector);
      applyEffects(selector);
    },
    async fill(selector, value, opts) {
      s.actions.push({ type: "fill", selector, value, opts });
      maybeFail("fill", selector);
      applyEffects(selector);
    },
    async selectOption(selector, values, opts) {
      s.actions.push({ type: "selectOption", selector, values, opts });
      maybeFail("selectOption", selector);
      applyEffects(selector);
      return s.selectResult;
    },
    async press(selector, key, opts) {
      s.actions.push({ type: "press", selector, key, opts });
      maybeFail("press", selector);
      applyEffects(selector);
    },
    async waitForSelector(selector, opts) {
      s.actions.push({ type: "waitForSelector", selector, opts });
      maybeFail("waitForSelector", selector);
      applyEffects(selector);
    },
    keyboard: {
      async press(key) {
        s.actions.push({ type: "keyboardPress", key });
      },
    },
  };
}

export const chromium = {
  async launch(opts) {
    const s = state();
    s.launched = (s.launched ?? 0) + 1;
    s.launchOptions = opts;
    return {
      async newContext() {
        return {
          async newPage() {
            return createPage();
          },
          async route(pattern, handler) {
            // Exposed so a test can replay the SSRF re-check the real browser
            // would trigger on every request.
            s.routePattern = pattern;
            s.routeHandler = handler;
          },
        };
      },
      async close() {
        s.closed = (s.closed ?? 0) + 1;
      },
      process() {
        return null;
      },
    };
  },
};
