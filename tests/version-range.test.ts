/**
 * Version-range agreement matrix (P1-2).
 *
 * Proves the manifest linter (`versionReqProblem`) and the mock-host resolver
 * (`versionSatisfies`, reached through `bitty.services.get`) share one
 * structural grammar: for every probe input, lint-accept is exactly
 * runtime-accept. The explicit `accepted` column also pins the intended
 * verdict for whitespace, missing operators, shorthand segments, and
 * prerelease/build forms, so a regression cannot hide behind a self-consistent
 * but wrong parser.
 */

import { describe, expect, test } from "bun:test";

import { HostError } from "../src/host-diagnostics.js";
import { MockHost } from "../src/mock-host.js";
import { versionReqProblem } from "../src/manifest.js";
import { versionSatisfies } from "../src/version-range.js";

interface RangeCase {
  readonly range: string;
  readonly accepted: boolean;
  readonly note: string;
}

const RANGE_CASES: readonly RangeCase[] = [
  { range: "1.0.0", accepted: true, note: "missing operator means exact" },
  { range: "=1.0.0", accepted: true, note: "single equals" },
  { range: "==1.0.0", accepted: true, note: "double equals" },
  { range: ">=1.0.0", accepted: true, note: "greater-or-equal" },
  { range: ">1.0.0", accepted: true, note: "greater-than" },
  { range: "<=2.0.0", accepted: true, note: "less-or-equal" },
  { range: "<2.0.0", accepted: true, note: "less-than" },
  { range: "^1.0.0", accepted: true, note: "caret" },
  { range: "~1.2.0", accepted: true, note: "tilde" },
  { range: ">=0.5,<1.0", accepted: true, note: "two-segment shorthand pair" },
  { range: ">=1.0.0, <2.0.0", accepted: true, note: "space after comma" },
  { range: ">= 1.0.0", accepted: true, note: "space after operator" },
  { range: " ^1.0.0\t", accepted: true, note: "surrounding whitespace" },
  { range: "^1.0", accepted: true, note: "registry-style caret shorthand" },
  { range: ">=2.30", accepted: true, note: "two-segment shorthand" },
  { range: ">=13", accepted: true, note: "one-segment shorthand" },
  { range: "", accepted: false, note: "empty" },
  { range: "   ", accepted: false, note: "whitespace only" },
  { range: ",", accepted: false, note: "empty clause" },
  { range: "1.0.0,", accepted: false, note: "trailing comma" },
  { range: ">=1.0.0 2.0.0", accepted: false, note: "missing comma" },
  { range: "1.0.0 || 2.0.0", accepted: false, note: "disjunction" },
  {
    range: "==1.0.0 & 2.0.0",
    accepted: false,
    note: "unsupported conjunction",
  },
  { range: ">=1.0.0-beta", accepted: false, note: "prerelease range segment" },
  { range: "1.0.0+build", accepted: false, note: "build range segment" },
  { range: "~>1.0.0", accepted: false, note: "invalid operator" },
  { range: ">=1.0.0.0", accepted: false, note: "four segments" },
  { range: "abc", accepted: false, note: "not a version" },
  { range: "1.0.0!", accepted: false, note: "illegal character" },
  { range: "1".repeat(140), accepted: false, note: "over the byte bound" },
];

describe("version-range agreement", () => {
  test("the explicit matrix matches the expected verdicts", () => {
    for (const entry of RANGE_CASES) {
      const lintAccepted = versionReqProblem(entry.range) === undefined;
      const runtimeAccepted =
        versionSatisfies("1.2.3", entry.range) !== undefined;
      expect({ range: entry.range, note: entry.note, lintAccepted }).toEqual({
        range: entry.range,
        note: entry.note,
        lintAccepted: entry.accepted,
      });
      expect({ range: entry.range, note: entry.note, runtimeAccepted }).toEqual(
        {
          range: entry.range,
          note: entry.note,
          runtimeAccepted: entry.accepted,
        },
      );
    }
  });

  test("lint-reject is exactly runtime-reject for every probe input", () => {
    for (const entry of RANGE_CASES) {
      const lintAccepted = versionReqProblem(entry.range) === undefined;
      const runtimeAccepted =
        versionSatisfies("1.2.3", entry.range) !== undefined;
      expect({ range: entry.range, lintAccepted, runtimeAccepted }).toEqual({
        range: entry.range,
        lintAccepted,
        runtimeAccepted: lintAccepted,
      });
    }
  });
});

describe("caret range semantics", () => {
  interface CaretCase {
    readonly range: string;
    readonly version: string;
    readonly satisfies: boolean;
    readonly note: string;
  }

  // The host resolver's `expand_caret` (bitty-package `requirement.rs`) pins
  // `^0.0.z` exactly, caps `^0.x.y` at the next minor, and keeps the
  // next-major cap for major >= 1. These cases discriminate the previous
  // same-major matching, where `^0.1` matched `0.9.9` (PX-0141).
  const CARET_CASES: readonly CaretCase[] = [
    { range: "^0.1", version: "0.1.0", satisfies: true, note: "lower bound" },
    {
      range: "^0.1",
      version: "0.1.9",
      satisfies: true,
      note: "same zero-major minor",
    },
    {
      range: "^0.1",
      version: "0.9.9",
      satisfies: false,
      note: "zero-major caret does not cross the minor",
    },
    {
      range: "^0.1",
      version: "0.2.0",
      satisfies: false,
      note: "next minor is the upper bound",
    },
    {
      range: "^0.1",
      version: "0.0.9",
      satisfies: false,
      note: "below the lower bound",
    },
    { range: "^0.1", version: "1.1.0", satisfies: false, note: "major past 0" },
    { range: "^0.2.3", version: "0.2.3", satisfies: true, note: "lower bound" },
    {
      range: "^0.2.3",
      version: "0.2.9",
      satisfies: true,
      note: "patch updates inside 0.2",
    },
    { range: "^0.2.3", version: "0.3.0", satisfies: false, note: "next minor" },
    {
      range: "^0.2.3",
      version: "0.2.2",
      satisfies: false,
      note: "below the lower bound",
    },
    {
      range: "^0.0.3",
      version: "0.0.3",
      satisfies: true,
      note: "zero-minor caret pins exactly",
    },
    { range: "^0.0.3", version: "0.0.4", satisfies: false, note: "no drift" },
    { range: "^0.0.3", version: "0.0.2", satisfies: false, note: "below pin" },
    {
      range: "^0",
      version: "0.0.0",
      satisfies: true,
      note: "one-segment zero pin",
    },
    {
      range: "^0",
      version: "0.0.1",
      satisfies: false,
      note: "one-segment zero pin is exact",
    },
    { range: "^1.0", version: "1.0.0", satisfies: true, note: "lower bound" },
    {
      range: "^1.0",
      version: "1.9.9",
      satisfies: true,
      note: "major caret spans minor and patch",
    },
    { range: "^1.0", version: "2.0.0", satisfies: false, note: "next major" },
    { range: "^1.0", version: "0.9.9", satisfies: false, note: "other major" },
  ];

  test("caret matches the host resolver's zero-major tightening", () => {
    for (const entry of CARET_CASES) {
      expect({
        range: entry.range,
        version: entry.version,
        note: entry.note,
        satisfies: versionSatisfies(entry.version, entry.range),
      }).toEqual({
        range: entry.range,
        version: entry.version,
        note: entry.note,
        satisfies: entry.satisfies,
      });
    }
  });
});

describe("mock host uses the shared grammar", () => {
  const MANIFEST = `
[plugin]
id = "conformance.range"
name = "Range"
version = "1.0.0"
description = "Version-range matrix fixture."

[services.provided]
"conformance.greet" = "1.2.3"
`;

  const ZERO_MAJOR_MANIFEST = `
[plugin]
id = "conformance.range-zero"
name = "Range Zero"
version = "0.9.9"
description = "Zero-major version-range fixture."

[services.provided]
"conformance.greet" = "0.9.9"
`;

  function hostWithProvider(): MockHost {
    const host = new MockHost({ manifestSource: MANIFEST });
    host.beginActivation();
    host.bitty.services.provide("conformance.greet", { greet: () => "ok" });
    host.endActivation();
    return host;
  }

  test("shorthand ranges the linter accepts resolve at runtime", () => {
    const host = hostWithProvider();
    for (const range of ["^1.0", ">=1.2", ">=1", "~1.2", ">=1.0,<2.0"]) {
      expect(
        versionReqProblem(range),
        `linter should accept ${range}`,
      ).toBeUndefined();
      expect(
        host.bitty.services.get("conformance.greet", { version: range }),
        `runtime should accept ${range}`,
      ).toBeDefined();
    }
  });

  test("zero-major caret does not resolve across a minor boundary", () => {
    const host = new MockHost({ manifestSource: ZERO_MAJOR_MANIFEST });
    host.beginActivation();
    host.bitty.services.provide("conformance.greet", { greet: () => "ok" });
    host.endActivation();
    expect(
      host.bitty.services.get("conformance.greet", { version: "^0.9" }),
      "same-minor caret should resolve",
    ).toBeDefined();
    expect(
      () => host.bitty.services.get("conformance.greet", { version: "^0.1" }),
      "next-minor caret should fail closed",
    ).toThrow(HostError);
  });

  test("ranges the linter rejects fail closed at runtime", () => {
    const host = hostWithProvider();
    for (const range of [
      "1.2.3 4.5.6",
      ">=1.0.0 || <2.0.0",
      ">=1.0.0-rc.1",
      "",
    ]) {
      expect(
        versionReqProblem(range),
        `linter should reject ${range}`,
      ).toBeDefined();
      expect(() =>
        host.bitty.services.get("conformance.greet", { version: range }),
      ).toThrow(HostError);
    }
  });
});
