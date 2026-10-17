const assert = require("node:assert");
const { add } = require("./src/sum");

assert.strictEqual(add(1, 2), 3, "adds positives");
assert.strictEqual(add(-1, -2), -3, "adds negatives");
assert.strictEqual(add(5, -2), 3, "adds mixed signs");
assert.strictEqual(add(0, 0), 0, "adds zeros");

console.log("all tests passed");
