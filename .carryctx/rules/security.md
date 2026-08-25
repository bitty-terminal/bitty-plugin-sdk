# Security rules

1. SDK convenience never grants authority. Filesystem, process, network,
   clipboard, terminal input, host management, and sensitive reads require
   explicit fine-grained host capabilities.
2. Plugins may alter presentation but not Terminal Truth. Do not expose parser,
   render, or input hot-path hooks through helpers, types, mocks, or examples.
3. Per-plugin isolation, restricted libraries, resource budgets, safe mode, and
   fail-closed capability checks remain mandatory host gates; the SDK must model
   their denial behavior accurately.
4. Mocks and fixtures must default to least privilege and reject unknown or
   ungranted capabilities. Tests may grant authority only explicitly.
5. Validate and bound attacker-controlled values, structured content, paths,
   identifiers, manifests, and generated data.
6. Installation executes no package code. Examples must not add install scripts,
   native in-process escape hatches, or unsafe-by-default setup.
7. Minimize and redact secrets, environment values, terminal data, paths, and
   diagnostics in fixtures, logs, and snapshots.
8. Security-sensitive changes require canonical threat/risk synchronization,
   adversarial tests, and independent security review before completion.
9. Exact mechanisms and thresholds may remain open only when the normative
   control itself remains mandatory.
