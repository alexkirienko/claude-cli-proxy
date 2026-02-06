# Changelog

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
