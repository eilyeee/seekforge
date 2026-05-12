"use strict";

/** OUTPUT stage: format a normalized record for display. Correct — do not change. */
function render(record) {
  return `${record.name} $${record.price.toFixed(2)}`;
}

module.exports = { render };
