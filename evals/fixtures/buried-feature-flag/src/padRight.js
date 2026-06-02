"use strict";
/** Right-pad to a width with a fill char. */
module.exports = (s, width, fill = " ") => String(s).padEnd(width, fill);
