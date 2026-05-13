"use strict";

const { parse } = require("./parse.js");
const { normalize } = require("./normalize.js");
const { render } = require("./render.js");

/** Wire the three stages together: parse -> normalize -> render. */
function pipeline(line, rate) {
  return render(normalize(parse(line), rate));
}

module.exports = { pipeline };
