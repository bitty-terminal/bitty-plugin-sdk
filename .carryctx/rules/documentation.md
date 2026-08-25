# Documentation rules

1. English is the only canonical documentation language. Translations, locale
   directories, and multilingual routing remain deferred.
2. `bitty-docs` owns plugin architecture, API, security, package, compatibility,
   decision, and public-behavior contracts. This repository owns implementation
   evidence and repository-local contributor guidance.
3. Distinguish normative, accepted, candidate, open, implemented, and verified
   statements. Types, examples, mocks, and proposed helpers are not host evidence.
4. Keep Lua helpers, LuaLS declarations, mocks, tests, examples, and versioned
   reference synchronized from one accepted contract.
5. Examples are safe by default, capability-aware, minimal, version-aware, and
   tested. Label pseudocode and incomplete snippets explicitly.
6. Document public types, errors, capabilities, limits, lifecycle, compatibility,
   deprecation, and security impact with the surface they govern.
7. Preserve provenance and inspected revisions for implementation and
   compatibility claims.
8. A public SDK change must update canonical `bitty-docs` in a linked change
   before completion.
9. Validate language, links, formatting, examples, repository hygiene, and
   factual status before review.
