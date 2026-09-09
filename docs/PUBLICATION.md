# Source publication and validation

This is a source-checkout prototype, not a new binary release or a claim of complete cross-platform acceptance.

## Phase-1 verification

- Root runtime/adapter/real-Clawd integration and POSIX launcher tests: **19 passed** on Linux, Node 24.
- Clawd loader and session-snapshot contract tests: **73 passed**.
- Renderer `cargo test --locked`: **50 passed**; this phase changes renderer documentation, not Rust/JS behavior.
- Runtime TypeScript declarations: strict `tsc --noEmit` passed.
- Root runtime tests and focused Clawd contracts are configured in GitHub Actions for Node 22/24 on Linux and Windows. A configured workflow is not itself evidence of a successful run.
- Windows batch launcher and real desktop/remote-session behavior still need human smoke testing. POSIX launcher tests use a fake npm executable and do not start a GUI or agent.

The full Clawd suite on this checkout reported **9,322 tests: 9,265 passed, 5 failed, 52 skipped**. The same five failures reproduce on the pre-extraction Clawd commit `7fec871a` in a separate source snapshot using the same dependencies:

- `test/recap-settings-contract.test.js`: one main-source wiring assertion.
- `test/remote-ssh-layout.test.js`: three layout/path-set assertions.
- `test/remote-ssh-path-isolation.test.js`: one isolated-layout path-set assertion.

They are pre-existing failures, not a green full-suite result and not proof that the underlying behaviors are safe. In particular, phase 1 does not expand or revalidate remote profile-isolated Pi support; the earlier Remote Pi integration is limited to `account-default`. These failures remain follow-up work rather than being hidden with skips or broad test changes.

`npm audit` on Clawd's existing lockfile reported four inherited transitive dependency findings (three high, one moderate: `@xmldom/xmldom`, `fast-uri`, `js-yaml`, `qs`). Dependencies were not auto-upgraded as part of the boundary extraction. Review and update them separately before distributing production binaries.

## Publication scope and checks

- The root repo and both integration mirrors retain their Git histories. Existing author/committer attribution and historical local-path references are therefore public too; this publication does not rewrite history.
- Recursive submodule clone URLs use HTTPS. The active fork branches are `pi-pet-bridge` and `pi-pet-mvp`; the root pins exact commits rather than following moving branch heads.
- AGPL-3.0 license texts, original notices and explicit fork attribution are retained. No experimental generated character archive is included.
- Local experiments, generation prompts/workflows, runtime files and credentials are excluded from staged publication.
- Gitleaks 8.30.1 was checksum-verified and run with redacted output across all locally fetched Git refs in the three repositories. The root history had no matches. Reviewed inherited matches were Clawd test/documentation fixtures and already-expired GitHub image signed URLs in the renderer's upstream README history. These findings were not used to contact a provider or test credential validity.
- The existing Clawd repository-audit Actions artifact was downloaded and scanned without a secret match. All 13 existing Actions run logs were also downloaded and scanned; the 23 generic-key matches were verified as Cargo cache names containing content hashes, not authentication keys. Forks had no GitHub Releases at the inspection point.

Automated scanning and review reduce risk; they do not prove the absence of every secret, privacy issue, asset-rights issue or vulnerability. Do not commit live auth, remote identity files, user transcripts, or generated private assets to these repositories.

## What was deliberately not published or implemented

No npm package, binary release, model weights, private character pack, provider credentials, new server endpoint, notification tool, TTS implementation, agent input queue or movement tool is introduced by phase 1. `private: true` in root `package.json` prevents accidental npm publication and is independent of GitHub repository visibility.
