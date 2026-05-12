"use strict";

/** INPUT stage: parse a raw "name,price" CSV line into a record. Correct. */
function parse(line) {
  const [name, price] = line.split(",");
  return { name: name.trim(), price: Number(price) };
}

module.exports = { parse };
