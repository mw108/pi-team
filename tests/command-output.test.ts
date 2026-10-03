import test from "node:test";
import assert from "node:assert/strict";
import { CommandOutputCollector } from "../src/agents/command-output.ts";

test("command streams reconstruct split UTF-8 independently", () => {
  const collector = new CommandOutputCollector();
  const stdout = Buffer.from("ä€😀漢");
  const stderr = Buffer.from("錯😀€ä");
  for (let index = 0; index < Math.max(stdout.length, stderr.length); index++) {
    if (index < stdout.length)
      collector.write("stdout", stdout.subarray(index, index + 1));
    if (index < stderr.length)
      collector.write("stderr", stderr.subarray(index, index + 1));
  }
  const result = collector.finish();
  assert.equal(result.stdout, "ä€😀漢");
  assert.equal(result.stderr, "錯😀€ä");
  assert.doesNotMatch(result.output, /�/);
});

test("large stdout and stderr keep bounded tails with one marker", () => {
  const collector = new CommandOutputCollector();
  for (let index = 0; index < 200; index++) {
    collector.write("stdout", Buffer.from("a".repeat(1000)));
    collector.write("stderr", Buffer.from("b".repeat(1000)));
  }
  const result = collector.finish();
  for (const value of Object.values(result)) {
    assert.ok(value.length <= 50_000);
    assert.equal(value.match(/\[output truncated\]/g)?.length, 1);
  }
  assert.match(result.stdout, /a+$/);
  assert.match(result.stderr, /b+$/);
  assert.match(result.stdout, /^\[output truncated\]\na+$/);
  assert.match(result.stderr, /^\[output truncated\]\nb+$/);
});

test("exactly 50,000 characters do not claim truncation", () => {
  const collector = new CommandOutputCollector();
  collector.write("stdout", Buffer.from("x".repeat(50_000)));
  const result = collector.finish();
  assert.equal(result.stdout, "x".repeat(50_000));
  assert.equal(result.output, result.stdout);
});

test("tail trimming never exposes half an emoji", () => {
  const collector = new CommandOutputCollector();
  collector.write("stdout", Buffer.from("😀".repeat(30_000)));
  const result = collector.finish();
  assert.equal(result.stdout.match(/\[output truncated\]/g)?.length, 1);
  assert.doesNotMatch(result.stdout, /�/);
  assert.equal(
    [...result.stdout.slice("[output truncated]\n".length)].every(
      (char) => char === "😀",
    ),
    true,
  );
});
