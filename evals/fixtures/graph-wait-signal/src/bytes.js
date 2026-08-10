"use strict";

// formatBytes() never escalates past KB and rounds to whole kilobytes, so
// 1536 becomes "2 KB" instead of "1.5 KB" and a megabyte becomes "1024 KB".
// `npm test` stays RED until the unit ladder and the one-decimal rule land.
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} KB`;
}

module.exports = { formatBytes };
