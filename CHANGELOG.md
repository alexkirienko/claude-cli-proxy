# Changelog

## [0.10.0](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.9.6...v0.10.0) (2026-02-18)


### Features

* recover session context from JSONL on resume failure ([3f90e32](https://github.com/alexkirienko/claude-cli-proxy/commit/3f90e329f52ce6c0e2194a1a9739c5ff685ae84a))

## [0.9.6](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.9.5...v0.9.6) (2026-02-18)


### Bug Fixes

* use dynamic identityMap lookup instead of static mergeTargets Set ([a2502aa](https://github.com/alexkirienko/claude-cli-proxy/commit/a2502aae66e79dc2e649ad81350933c9ea468421))

## [0.9.5](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.9.4...v0.9.5) (2026-02-18)


### Bug Fixes

* remove SESSION_TTL_MS to prevent session eviction overnight ([06bb723](https://github.com/alexkirienko/claude-cli-proxy/commit/06bb723a91eae615f1d4417375aedcba73a122c2))

## [0.9.4](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.9.3...v0.9.4) (2026-02-17)


### Bug Fixes

* persist sessions Map to disk to survive service restarts ([889da4b](https://github.com/alexkirienko/claude-cli-proxy/commit/889da4b0a255bd4ebe6b1edcf89831afa1b08b88))

## [0.9.3](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.9.2...v0.9.3) (2026-02-17)


### Bug Fixes

* harden security and robustness from code review findings ([76cc5c5](https://github.com/alexkirienko/claude-cli-proxy/commit/76cc5c51703700c6ff7c349b7b99dfc1e1983116))

## [0.9.2](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.9.1...v0.9.2) (2026-02-17)


### Bug Fixes

* generate fresh UUID on resume fallback to avoid "Session ID already in use" ([43ac91f](https://github.com/alexkirienko/claude-cli-proxy/commit/43ac91fb3a871e29b74fd9b52f2641b9e5045aee))
* include CLI stderr in error event when process exits without content ([8ac6f15](https://github.com/alexkirienko/claude-cli-proxy/commit/8ac6f15a07096ba92f0faf02af05bb1ebe89be81))
* prevent silent failures when CLI retries exhaust and forward metadata on resume ([73acb80](https://github.com/alexkirienko/claude-cli-proxy/commit/73acb80c111bca20d98946327af737a2bcddada0))

## [0.9.1](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.9.0...v0.9.1) (2026-02-17)


### Bug Fixes

* cross-channel session merging when system prompts differ per channel ([678f2c4](https://github.com/alexkirienko/claude-cli-proxy/commit/678f2c4d0f47d856589c139cd3b34f7724c4eb40))

## [0.9.0](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.8.3...v0.9.0) (2026-02-17)


### Features

* identity alias map for cross-channel session merging ([2efe8c2](https://github.com/alexkirienko/claude-cli-proxy/commit/2efe8c293163ef6d8fc84eeef5c029e3d03edf01))

## [0.8.3](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.8.2...v0.8.3) (2026-02-17)


### Bug Fixes

* forward channel identity on resumed sessions ([63174cd](https://github.com/alexkirienko/claude-cli-proxy/commit/63174cd6bb4fad2f3994c867cd5dafa3cc2e5d78))

## [0.8.2](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.8.1...v0.8.2) (2026-02-16)


### Bug Fixes

* stop implicit preemption of same-session requests ([d768c45](https://github.com/alexkirienko/claude-cli-proxy/commit/d768c45a31d7d8cd0d855bce128c788d657dd1ac))

## [0.8.1](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.8.0...v0.8.1) (2026-02-16)


### Bug Fixes

* strip entire JSON metadata block for stable session keys ([37ae739](https://github.com/alexkirienko/claude-cli-proxy/commit/37ae7393137f06c264bd8f78ff8d8929d018bc88))

## [0.8.0](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.7.8...v0.8.0) (2026-02-16)


### Features

* add E2E session continuity test suite ([45026f8](https://github.com/alexkirienko/claude-cli-proxy/commit/45026f8a2cdbd63836aeded39d58334f3ca8825d))

## [0.7.8](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.7.7...v0.7.8) (2026-02-16)


### Bug Fixes

* use chat_id from OpenClaw metadata for stable session keys ([be8ce29](https://github.com/alexkirienko/claude-cli-proxy/commit/be8ce2970f1323daea23debb9fb8b1aca0856332))

## [0.7.7](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.7.6...v0.7.7) (2026-02-16)


### Bug Fixes

* allow sender tag matching anywhere in message ([9350c45](https://github.com/alexkirienko/claude-cli-proxy/commit/9350c45c582ab4c17b68a05753093a645e393fcc))

## [0.7.6](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.7.5...v0.7.6) (2026-02-16)


### Bug Fixes

* use sender identity for session key to preserve conversation context ([5bf358b](https://github.com/alexkirienko/claude-cli-proxy/commit/5bf358b9145af1351c80a561c7e53579a611ee84))

## [0.7.5](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.7.4...v0.7.5) (2026-02-16)


### Bug Fixes

* stop deleting session JSONL files on retry (preserves conversation history) ([6ad4ae4](https://github.com/alexkirienko/claude-cli-proxy/commit/6ad4ae4ade38b9fac195fcef9e2c4b8e3ad9626d))

## [0.7.4](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.7.3...v0.7.4) (2026-02-16)


### Bug Fixes

* make system-prompt-extraction tests portable across CI ([a67b15d](https://github.com/alexkirienko/claude-cli-proxy/commit/a67b15d04bdd10f034284dac6e7c51264c9f7063))

## [0.7.3](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.7.2...v0.7.3) (2026-02-16)


### Bug Fixes

* resolve 10 bugs found by deep code review ([d43f1e2](https://github.com/alexkirienko/claude-cli-proxy/commit/d43f1e2c80c9675a127de204f0c6111b4fee87a7))

## [0.7.2](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.7.1...v0.7.2) (2026-02-15)


### Bug Fixes

* define cleanupImages in streaming/non-streaming handler scope ([cd87a34](https://github.com/alexkirienko/claude-cli-proxy/commit/cd87a349a850eb5af5ac4e4167e2144090d17e25))

## [0.7.1](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.7.0...v0.7.1) (2026-02-15)


### Bug Fixes

* clean up temp image files on early exit and catch unhandled exceptions in router ([68f5aa3](https://github.com/alexkirienko/claude-cli-proxy/commit/68f5aa370bd43423afbf97b3580e63b744c4c04d))

## [0.7.0](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.6.0...v0.7.0) (2026-02-15)


### Features

* add /deploy webhook endpoint for GitHub-triggered auto-deploy ([bd65cb0](https://github.com/alexkirienko/claude-cli-proxy/commit/bd65cb04ae9952238660204893b05150a7ace153))

## [0.6.0](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.5.9...v0.6.0) (2026-02-15)


### Features

* add multimodal image support and session regeneration ([aaa7852](https://github.com/alexkirienko/claude-cli-proxy/commit/aaa78522fbdfd3eeaadb88b582dc22deaf343fb5))

## [0.5.9](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.5.8...v0.5.9) (2026-02-15)


### Bug Fixes

* const-to-let for delta reassignment in streaming handler ([96c365b](https://github.com/alexkirienko/claude-cli-proxy/commit/96c365b4d6ae2ccc239944bfc49def6333aa9cf4))

## [0.5.8](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.5.7...v0.5.8) (2026-02-15)


### Bug Fixes

* strip gateway metadata tags from responses too ([834f352](https://github.com/alexkirienko/claude-cli-proxy/commit/834f3525e1d3ee04c8c669d40b26a7f980a22b1e))

## [0.5.7](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.5.6...v0.5.7) (2026-02-15)


### Bug Fixes

* strip [[reply_to_message_id: N]] tags from prompts ([f24eab4](https://github.com/alexkirienko/claude-cli-proxy/commit/f24eab424f017ac455f20423b477e414eaeaf638))

## [0.5.6](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.5.5...v0.5.6) (2026-02-15)


### Bug Fixes

* remove CLAUDE_CONFIG_DIR override that broke CLI authentication ([d7e9cc6](https://github.com/alexkirienko/claude-cli-proxy/commit/d7e9cc62efaf6f5473b9896b4f59dcc92febc68b))

## [0.5.5](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.5.4...v0.5.5) (2026-02-15)


### Bug Fixes

* clear JSONL before retry to prevent "already in use" loop ([a38e62b](https://github.com/alexkirienko/claude-cli-proxy/commit/a38e62b3421b80f056716d0ac723e6bfe895c4b9))

## [0.5.4](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.5.3...v0.5.4) (2026-02-15)


### Bug Fixes

* add tests for session isolation and CLAUDE_CONFIG_DIR ([e3eb6f5](https://github.com/alexkirienko/claude-cli-proxy/commit/e3eb6f5fd24b7c3c91870b683d91bb63c7ccf175))

## [0.5.3](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.5.2...v0.5.3) (2026-02-15)


### Bug Fixes

* stop manually tracking version in CLAUDE.md ([f5be5f9](https://github.com/alexkirienko/claude-cli-proxy/commit/f5be5f9ec940cb65a86ffce2c61b1e29d3ead974))

## [0.5.2](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.5.1...v0.5.2) (2026-02-15)


### Bug Fixes

* create release in same workflow run as PR merge ([85daf58](https://github.com/alexkirienko/claude-cli-proxy/commit/85daf588a76495733d458d64bffef752be2bb8a9))

## [0.5.1](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.5.0...v0.5.1) (2026-02-15)


### Bug Fixes

* use direct merge instead of --auto for release-please PRs ([342f2b7](https://github.com/alexkirienko/claude-cli-proxy/commit/342f2b7cae2907119ae67cc885a4d90ad0d770f3))

## [0.5.0](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.4.0...v0.5.0) (2026-02-15)


### Features

* session isolation and self-update ([b86ae9a](https://github.com/alexkirienko/claude-cli-proxy/commit/b86ae9a7c2a6126ff87781e79572fd885fdbab8d))

## [0.4.0](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.3.1...v0.4.0) (2026-02-15)


### Features

* add comprehensive test suite with 104 tests (93% coverage) ([a026a2f](https://github.com/alexkirienko/claude-cli-proxy/commit/a026a2fd9f1e5dfec48e61e75a5d91f5293e18cc))
* append system prompt on resume to nudge re-reading project instructions ([1481c96](https://github.com/alexkirienko/claude-cli-proxy/commit/1481c961f05109ba7a66c3e41f8436c606761a64))


### Bug Fixes

* bump package.json version to 0.3.6 to match changelog ([fdd6c84](https://github.com/alexkirienko/claude-cli-proxy/commit/fdd6c844a89c6d8f9d9ed7da059c6b106a450d58))
* detect existing session JSONL on disk to survive proxy restarts ([454d0e0](https://github.com/alexkirienko/claude-cli-proxy/commit/454d0e007482f5b7ac867e4b9170f9eb243e0a49))
* kill zombie CLI processes when gateway aborts a run ([6830e90](https://github.com/alexkirienko/claude-cli-proxy/commit/6830e902f9c66bda04dee939510dbaf8f2f4405c))
* read version from package.json instead of hardcoded "v2.0" ([6af9068](https://github.com/alexkirienko/claude-cli-proxy/commit/6af9068f96445f7eb2791ad825e2b13a31ba67e0))
* skip --system-prompt on --resume to preserve session context ([6172c2c](https://github.com/alexkirienko/claude-cli-proxy/commit/6172c2ce1e6445b4a33ed868d73c49e1c5709fdc))
* use --resume for session continuity, only clear JSONL on lock error ([e32429a](https://github.com/alexkirienko/claude-cli-proxy/commit/e32429a288176efe88c11643e800b80dd1f6c597))

## [0.3.6](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.3.5...v0.3.6) (2026-02-13)


### Features

* append system prompt on resume to nudge re-reading project instructions after context compaction ([1481c96](https://github.com/alexkirienko/claude-cli-proxy/commit/1481c96))

## [0.3.5](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.3.4...v0.3.5) (2026-02-06)


### Bug Fixes

* kill zombie CLI processes when gateway aborts a run — new requests for the same session now preempt the active CLI instead of queuing behind it
* listen on both req and res for client disconnect to improve socket closure detection

## [0.3.4](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.3.3...v0.3.4) (2026-02-06)


### Bug Fixes

* skip --system-prompt on --resume to preserve conversation context — system prompt was overriding stored prompt and destroying session history

## [0.3.3](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.3.2...v0.3.3) (2026-02-06)


### Bug Fixes

* detect existing session JSONL on disk to survive proxy restarts — sessions now resume with context even after service restart

## [0.3.2](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.3.1...v0.3.2) (2026-02-06)


### Bug Fixes

* use --resume for session continuity, only clear JSONL on lock error — preserves conversation context across requests instead of wiping it on every spawn

## [0.3.1](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.3.0...v0.3.1) (2026-02-06)


### Bug Fixes

* clear stale session JSONL to prevent "already in use" errors ([b389a8e](https://github.com/alexkirienko/claude-cli-proxy/commit/b389a8e))


### Features

* session queuing with priority preemption for human messages
* `/stop` command to kill active CLI runs
* graceful shutdown — kill tracked CLI children on SIGTERM/SIGINT

## [0.3.0](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.2.1...v0.3.0) (2026-02-06)


### Features

* handle context compaction events with extended timeout ([900b559](https://github.com/alexkirienko/claude-cli-proxy/commit/900b559a4973322a598100e300364ed659803bf7))


### Bug Fixes

* filter tool_use events from SSE and add dynamic idle timeout ([d19cea3](https://github.com/alexkirienko/claude-cli-proxy/commit/d19cea37ce2495023a5c3e2a4b9c02053f380730))
* handle concatenated JSON objects in streaming response ([4963ed5](https://github.com/alexkirienko/claude-cli-proxy/commit/4963ed5f35d78264cac7a0dcd91fe32b7c3ea3bb))
* prevent SSE event merging from TCP buffering ([2b5349b](https://github.com/alexkirienko/claude-cli-proxy/commit/2b5349b444c93b9b446e20e4a423bc10704e856b))
* session key collision, log leak, dead code cleanup ([b7b8969](https://github.com/alexkirienko/claude-cli-proxy/commit/b7b89698af3d32ca7b26335578707ece3cf3a059))
* use --resume for session continuity to prevent message fabrication ([c6eb9ce](https://github.com/alexkirienko/claude-cli-proxy/commit/c6eb9ce4f7a40699da3fac13a05118b6149e53ac))
* use brace-counting JSON parser for robust streaming ([94784a5](https://github.com/alexkirienko/claude-cli-proxy/commit/94784a571cfac4ebec85da35634de003ed3fc0b8))
* use XML tags in prompt to prevent model fabricating user messages ([6581926](https://github.com/alexkirienko/claude-cli-proxy/commit/6581926895b7eadf0762c154669c712c07cd864d))

## [0.2.1](https://github.com/alexkirienko/claude-cli-proxy/compare/v0.2.0...v0.2.1) (2026-02-05)


### Bug Fixes

* remove ping event from system_event handler ([8ebcd53](https://github.com/alexkirienko/claude-cli-proxy/commit/8ebcd53207159b5e70d8ff344dd59c149daf927e))
