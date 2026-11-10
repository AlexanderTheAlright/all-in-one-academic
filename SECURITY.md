# Security

- Local single-user app; binds to loopback (127.0.0.1); not designed to be exposed to a network.
- Report an issue through GitHub security advisories on this repository.
- Enabling run_vault_scripts executes code from the vault; only enable it for a vault you wrote.
- Stats verifiers run only when run_vault_scripts is on and the script's sha256 is listed in `approved-verifiers.json` in the state dir.
