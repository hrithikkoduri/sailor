# buggy-lib

A tiny fixture library used to exercise the coding agent end to end.

**The bug:** `add()` drops negative numbers — `add(-1, -2)` returns `0` instead of `-3`.

Run the tests with `npm test` (or `node test.js`).
