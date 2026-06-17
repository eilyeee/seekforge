# API package rules

- Never re-implement string utilities in this package. Reuse the shared helpers
  from the `utils` root (e.g. `require("../../utils/src/slugify.js")`).
