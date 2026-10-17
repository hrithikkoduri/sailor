// buggy on purpose: negative numbers are silently dropped
function add(...numbers) {
  return numbers.filter((n) => n >= 0).reduce((a, b) => a + b, 0);
}

module.exports = { add };
