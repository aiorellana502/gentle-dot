const assert = require("node:assert/strict");
const test = require("node:test");

const { identityMatches } = require("./index.js");

test("matches only when both pid and creation time agree", () => {
	assert.equal(identityMatches(100, 5000, 100, 5000), true);
	assert.equal(identityMatches(100, 5000, 101, 5000), false);
	assert.equal(identityMatches(100, 5000, 100, 5001), false);
});

test("rejects non-numeric arguments at the binding boundary", () => {
	assert.throws(() => identityMatches("1", 1, 1, 1), { code: "NumberExpected" });
	assert.throws(() => identityMatches(1, 1, 1), { code: "NumberExpected" });
});
