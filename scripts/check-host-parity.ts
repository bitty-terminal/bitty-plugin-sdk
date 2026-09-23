/**
 * Host-parity sync check for the SDK generation freeze (CTX-0053).
 *
 * The SDK owns regen-sync: whenever the bitty host changes parity (a
 * namespace flips between WIRED and DEFERRED) or the accepted contract
 * revision moves, `surface/bitty-plugin-api-v1.json` and the generated
 * `lua/bitty.d.lua` must be re-synced. This script is the executable half of
 * that trigger (the procedure is documented in `docs/lua-defs.md`): it fails
 * when the surface table, the `src/host-surface.ts` wiring model, the
 * generated definitions, or the mock-host behavior disagree about host
 * parity. It runs as `just host-parity-check`, which is part of `just check`.
 *
 * Usage:
 *   bun scripts/check-host-parity.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HostError } from "../src/host-diagnostics.js";
import {
  DEFERRED_NAMESPACES,
  HOST_PARITY_SOURCE,
  NAMESPACE_HOST_PARITY,
} from "../src/host-surface.js";
import { MockHost } from "../src/mock-host.js";
import { loadSurface } from "./generate-lua-defs.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFERRED_ANNOTATION =
  "Host status: deferred - always fails with E_NOT_IMPLEMENTED (runtime) until the host backend lands.";

function denialOf(run: () => unknown): { code: string; class: string } {
  try {
    run();
  } catch (cause) {
    if (cause instanceof HostError) {
      return { code: cause.diagnostic.code, class: cause.diagnostic.class };
    }
    throw cause;
  }
  throw new Error("expected a HostError denial");
}

export function main(): number {
  const problems: string[] = [];
  const surface = loadSurface();

  if (surface.hostParity.repository !== HOST_PARITY_SOURCE.repository) {
    problems.push(
      `surface hostParity.repository ${surface.hostParity.repository} != ${HOST_PARITY_SOURCE.repository}`,
    );
  }
  if (surface.hostParity.commit !== HOST_PARITY_SOURCE.commit) {
    problems.push(
      "surface hostParity.commit drifts from src/host-surface.ts HOST_PARITY_SOURCE",
    );
  }
  if (surface.hostParity.pr !== HOST_PARITY_SOURCE.pr) {
    problems.push(
      `surface hostParity.pr ${surface.hostParity.pr} != ${HOST_PARITY_SOURCE.pr}`,
    );
  }

  const fromSurface = new Map(Object.entries(surface.hostParity.namespaces));
  const fromCode = new Map(
    NAMESPACE_HOST_PARITY.map((entry) => [entry.namespace, entry.status]),
  );
  for (const [namespace, status] of fromSurface) {
    if (fromCode.get(namespace) !== status) {
      problems.push(
        `namespace ${namespace}: surface says ${status}, host-surface.ts says ${String(fromCode.get(namespace))}`,
      );
    }
  }
  for (const namespace of fromCode.keys()) {
    if (!fromSurface.has(namespace)) {
      problems.push(`namespace ${namespace}: missing from surface hostParity`);
    }
  }
  const deferredFromCode = new Set([...DEFERRED_NAMESPACES].sort());
  const deferredFromSurface = new Set(
    [...fromSurface.entries()]
      .filter(([, status]) => status === "deferred")
      .map(([namespace]) => namespace)
      .sort(),
  );
  if (
    JSON.stringify([...deferredFromCode]) !==
    JSON.stringify([...deferredFromSurface])
  ) {
    problems.push(
      `DEFERRED_NAMESPACES [${[...deferredFromCode].join(", ")}] disagrees with surface [${[...deferredFromSurface].join(", ")}]`,
    );
  }

  const defs = readFileSync(join(REPO_ROOT, "lua/bitty.d.lua"), "utf8");
  const deferredFunctions = surface.functions.filter(
    (fn) => fromSurface.get(fn.path.split(".")[0] ?? "") === "deferred",
  );
  const annotationCount = defs.split(DEFERRED_ANNOTATION).length - 1;
  if (annotationCount !== deferredFunctions.length) {
    problems.push(
      `bitty.d.lua carries ${annotationCount} deferred annotations for ${deferredFunctions.length} deferred functions; run just lua-defs-write`,
    );
  }
  const wiredFunctions = surface.functions.filter(
    (fn) => fromSurface.get(fn.path.split(".")[0] ?? "") === "wired",
  );
  if (wiredFunctions.length === 0) {
    problems.push("expected at least one wired function");
  }

  const fullManifest = readFileSync(
    join(REPO_ROOT, "conformance/manifests/full.toml"),
    "utf8",
  );
  const envManifest = readFileSync(
    join(REPO_ROOT, "conformance/manifests/env-declared.toml"),
    "utf8",
  );
  try {
    const host = new MockHost({ manifestSource: fullManifest });
    for (const [label, run] of [
      [
        "services.provide",
        () =>
          host.bitty.services.provide("conformance.greet", {
            hello: () => null,
          }),
      ],
      [
        "services.get",
        () =>
          host.bitty.services.get("conformance.greet", {
            version: ">=1.0.0",
          }),
      ],
    ] as const) {
      const denial = denialOf(run);
      if (denial.code !== "E_NOT_IMPLEMENTED" || denial.class !== "runtime") {
        problems.push(
          `mock ${label}: got ${denial.class}/${denial.code}, want runtime/E_NOT_IMPLEMENTED`,
        );
      }
    }
    host.beginActivation();
    const task = host.bitty.tasks.spawn(() => null);
    if (typeof task !== "number" || task <= 0) {
      problems.push(
        "mock tasks.spawn: WIRED namespace must still issue a handle",
      );
    }
    host.endActivation();
    host.dispose();

    const envHost = new MockHost({
      manifestSource: envManifest,
      environment: { FIXTURE_KEY_ONE: "value-one" },
    });
    if (envHost.bitty.env === undefined) {
      problems.push("mock bitty.env: must stay present when declared");
    } else {
      envHost.grant("env:FIXTURE_KEY_ONE");
      envHost.beginActivation();
      for (const [label, run] of [
        ["env.get", () => envHost.bitty.env?.get("FIXTURE_KEY_ONE")],
        ["env.has", () => envHost.bitty.env?.has("FIXTURE_KEY_ONE")],
      ] as const) {
        const denial = denialOf(run);
        if (denial.code !== "E_NOT_IMPLEMENTED" || denial.class !== "runtime") {
          problems.push(
            `mock ${label}: got ${denial.class}/${denial.code}, want runtime/E_NOT_IMPLEMENTED`,
          );
        }
      }
      envHost.endActivation();
      envHost.dispose();
    }
  } catch (cause) {
    problems.push(
      `mock probe failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (problems.length > 0) {
    console.error(`error: host parity has ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `host parity agrees with ${surface.hostParity.repository}#${surface.hostParity.pr} ` +
      `(${deferredFunctions.length} deferred, ${wiredFunctions.length} wired)`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
