# OpenSelect

English | [简体中文](README.zh-CN.md)

OpenSelect is a local AI proxy for managing multiple provider accounts. It monitors OpenCode Go usage, routes requests through an account pool, and can retry with another account when an upstream request fails before the response starts. A local dashboard shows account status, usage, requests, and routing information.

Built with Bun and TypeScript. The proxy has no npm runtime dependencies; the dashboard is currently in Chinese.

## Features

- **Usage monitoring and account selection:** poll OpenCode Go usage and switch accounts when configured thresholds are reached. Keep sessions associated with an account when possible.
- **Request-level failover:** retry eligible rate-limit, authentication, server, and network failures before the first response bytes reach the client. Actual behavior depends on the error and available accounts.
- **Local API gateway:** use OpenAI-compatible and Anthropic-compatible endpoints through one local proxy. Some Anthropic requests can be translated to OpenAI chat requests.
- **Multiple providers:** support OpenCode Go and direct integrations including Z.ai, MiniMax, DeepSeek, Command Code, and Ollama Cloud. Capabilities depend on the provider and account.
- **Dashboard and statistics:** inspect accounts, model availability, requests, token usage, estimated cost, and routing information.
- **OpenCode integration:** connect or restore OpenCode configuration with reversible `wire` and `unwire` commands.
- **Backups:** create local backups, verify signatures, and optionally use encrypted remote backups.

For the detailed feature reference, see [FEATURES.md](FEATURES.md) (Chinese).

## Screenshots

The screenshots below show the Chinese interface. Account details and usage data have been redacted.

<details>
<summary>Dashboard</summary>

![Dashboard](docs/screenshots/dashboard.png)

</details>

<details>
<summary>Usage statistics</summary>

![Usage statistics](docs/screenshots/usage-statistics.png)

</details>

<details>
<summary>Model availability</summary>

![Model availability](docs/screenshots/model-availability.png)

</details>

<details>
<summary>Request log</summary>

![Request log](docs/screenshots/request-log.png)

</details>

<details>
<summary>Switch history</summary>

![Switch history](docs/screenshots/switch-history.png)

</details>

<details>
<summary>Routing</summary>

![Routing](docs/screenshots/routing.png)

</details>

<details>
<summary>Connections</summary>

![Connections](docs/screenshots/connections.png)

</details>

<details>
<summary>Settings</summary>

![Settings](docs/screenshots/settings.png)

</details>


## Requirements

- [Bun](https://bun.sh/) and Git.
- A supported provider account and API key for provider-backed requests.
- macOS for the optional launchd automatic startup and backup tasks. The proxy itself is cross-platform.

## Quick start

```bash
git clone https://github.com/Acorne-VJ/OpenSelect.git
cd OpenSelect
./bin/opensel init
./bin/opensel serve
```

Open the dashboard at [http://127.0.0.1:8789](http://127.0.0.1:8789) and add your provider credentials on the connection page (`接入账号`). Alternatively, run `./bin/opensel import` in another terminal to import existing OpenCode Go credentials from OpenCode.

The proxy listens on `http://127.0.0.1:8788` by default. To connect OpenCode, run the following in another terminal, then restart OpenCode:

```bash
./bin/opensel wire
```

To undo the integration, run `./bin/opensel unwire`. You can inspect the proposed changes first with `./bin/opensel wire --dry-run`.

## Dashboard

| Page | Purpose |
| --- | --- |
| `/` | Account pool, connections, model availability, and recent activity |
| `/connect` | Add accounts and manage client integrations |
| `/settings` | Runtime settings, free models, and backups |
| `/stats` and `/tokens` | Usage, token, and estimated-cost statistics |
| `/routes` | Provider and routing comparisons |
| `/requests` and `/switches` | Request and account-switch history |

## Command-line reference

Run `./bin/opensel --help` for the complete list and options.

| Command | Purpose |
| --- | --- |
| `./bin/opensel init` | Initialize local configuration |
| `./bin/opensel import` | Import existing OpenCode Go credentials |
| `./bin/opensel accounts` | List accounts and recent usage |
| `./bin/opensel status` | Show service and account status |
| `./bin/opensel serve` | Start the proxy, dashboard, and usage monitoring |
| `./bin/opensel wire` / `unwire` | Connect or restore OpenCode configuration |
| `./bin/opensel doctor` | Check the local setup |
| `./bin/opensel backup` / `restore` | Back up or restore local data |

## Security and privacy

Configuration, credentials, logs, and runtime data are stored under `~/.openselect/`. Keep API keys, configuration files, databases, and backups out of public repositories. **Backups can contain plaintext account keys**; use private storage or an encrypted backup.

The proxy and dashboard bind to localhost by default. Do not expose them to the public internet without suitable authentication, TLS, and a reverse proxy. See [SECURITY.md](SECURITY.md) for the security policy and reporting guidance.

## Limitations

- Failover requires another eligible account and can only replace a request before response bytes are sent to the client.
- Provider availability, model access, rate limits, and pricing can change. Enabling free-model routing may result in a different model answering the request.
- Anthropic-to-OpenAI translation supports OpenAI chat models, with limitations on some content blocks and streaming usage estimates. See the [Chinese README](README.zh-CN.md) for details.
- Automatic startup and scheduled backups use macOS launchd; the proxy itself is cross-platform.

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```

The test preload isolates `HOME` in a temporary directory. See the [Chinese README](README.zh-CN.md) for configuration, backup, and implementation details.

## License

[MIT](LICENSE).
