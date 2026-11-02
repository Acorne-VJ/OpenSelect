# Security Policy

## Reporting

If you find a vulnerability, please **do not open a public issue with secrets or exploit details**. Contact the maintainer privately with:

- affected version / commit
- reproduction steps
- impact
- suggested fix, if any

## Sensitive data

OpenSelect is a local proxy. Never commit:

- `~/.openselect/config.json`
- SQLite databases (`data.sqlite`, WAL/SHM)
- backups (`~/.openselect/backups/`)
- API keys (`oc_sk_...`, `sk-...`, GitHub tokens)
- private keys (`*.pem`, `*.key`)
- `.egc/` governance history containing personal data

Backup archives contain plaintext account keys by design. Store them only in a private repository or encrypted storage.

## Network boundary

Default endpoints:

```text
proxy:     127.0.0.1:8788
dashboard: 127.0.0.1:8789
```

Do not expose these ports to the public internet without authentication, TLS, and a reverse proxy. The dashboard has local-origin CSRF checks, but it is not designed as a public multi-user service.

## Supported versions

Only the current `main` branch is supported for security fixes unless a release branch is explicitly documented.
