"use strict";
/** Left-pad to a width with a fill char. */
module.exports = (s, width, fill = " ") => String(s).padStart(width, fill);
