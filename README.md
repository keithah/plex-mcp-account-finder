# Plex MCP Account Finder

Model Context Protocol server that connects to multiple Plex accounts, aggregates server user access, and exposes tools for fuzzy user lookup and login token generation. Built on the official Plex APIs using the `smithery` TypeScript runtime.

## Features
- Discover Plex Media Servers across every configured account token.
- Fuzzy search for users by email, username, or display name across all servers.
- Validate account connectivity and list owned/shared servers with `plex_status`.
- Generate Plex authentication URLs (PIN-based) and poll them to capture new tokens via MCP tools.
- Configurable caching to avoid hammering Plex endpoints when running repeated queries.

## Configuration
`smithery.yaml` already points to `src/index.ts`. Provide a config object that matches `configSchema`:

```json
{
  "log_level": "info",
  "cache_ttl_seconds": 300,
  "accounts": [
    { "label": "primary", "token": "<plex-token>" },
    { "label": "secondary", "token": "<plex-token>" }
  ]
}
```

- `log_level`: `debug`, `info`, `warn`, or `error` (default: `info`).
- `cache_ttl_seconds`: cache duration for server/user lookups (30–3600 seconds, default 300).
- `accounts`: list of Plex account API tokens plus optional client identifiers. Each token should be an account-level token retrieved from Plex Web or the pin flow.

## Tools
- `plex_status` – Summarizes account validity, servers, and optionally user counts.
- `plex_lookup_user` – Fuzzy query across all server users (`query`, optional `max_results`, `refresh`).
- `plex_generate_auth_url` – Produces a PIN-based login URL (`client_identifier` optional) for generating new tokens.
- `plex_check_auth_pin` – Polls a previously issued PIN (`pin_id`, `client_identifier`) and reports whether an auth token is ready.

## Development
```bash
npm install
npm run dev  # runs smithery dev with hot reload
```

Type checking & builds:
```bash
npm run typecheck
npm run build:stdio
npm run build:shttp
```

The generated bundles are stored in `.smithery/` and can be deployed directly to Smithery.

## Notes
- Logging is structured JSON; sensitive values (tokens) are redacted automatically.
- The manager caches server and user snapshots for the configured TTL. Use `refresh: true` in tool inputs to bypass caches when needed.
- Plex PIN URLs expire quickly; poll with `plex_check_auth_pin` until `authToken` is populated, then store that token for future use.
