# Verification

Version 0.1.0, 2026-10-18.

- Independent review reproduced three defects: a stale read could resend an accepted answer, a rejection could have an empty reason, and packaging could retain an old file. Each is corrected with a regression test before publication.
- The Codex plugin CLI accepted the generated marketplace and installed version 0.1.0 in an isolated configuration. This is an installation check, not a native conversation or pixel check.
- Final local suite: `npm run check` passes 26 tests, builds the server/hook/UI, and passes the public-content scan. `npm run package` produces the clean marketplace. The duplicate-send regression was first reproduced failing with two sends, then passed with one send after the fix.

- Engine tests cover task kinds, five-open limit, normalized-title deduplication, restarts, transactional responses, private file mode, scope isolation, UI token, explicit ended-session adoption, CAS, idempotence and concurrent process writes.
- MCP tests connect a real client to the bundled stdio server and inspect the tool list, UI metadata, hidden token, response acknowledgement and rendered-resource HTML.
- Hook tests cover exact identity, compact/resume scope, busy/idle state, subagent exclusion and the Stop recursion guard.
- DOM tests exercise response workflows, pending/accepted/unknown delivery, draft preservation, late result isolation and unavailable host messaging.
- Native placement and receipt of a message by an actual Codex conversation have not yet been certified. A demo capture proves only the local web rendering shown.

Run `npm run check` from a clean checkout to reproduce local checks. The generated marketplace is tested separately with the Codex plugin CLI in an isolated configuration directory; that is an installation check, not an end-to-end native UI check.
