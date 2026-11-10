<p align="center"><img src="docs/logo.svg" width="96" alt="all-in-one-academic"></p>

# all-in-one-academic

<!-- description -->

## Quick start

Linux only.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
(cd web && pnpm install && pnpm run build)
cp -r examples/sample-vault /tmp/all-in-one-academic-vault
AIOA_VAULT=/tmp/all-in-one-academic-vault .venv/bin/python server/serve.py
```

Open http://127.0.0.1:8787.

Tests: `.venv/bin/python -m unittest discover tests`.

## Configuration

Environment variable `AIOA_<KEY>` overrides the TOML file at `$AIOA_CONFIG`
(default `~/.config/all-in-one-academic/config.toml`), which overrides the default.

| Key | Type | Default |
|---|---|---|
| `vault` | path | `~/all-in-one-academic-vault` |
| `projects_dir` | string (folder under the vault) | `Projects` |
| `state_dir` | path | `$XDG_STATE_HOME/all-in-one-academic` or `~/.local/state/all-in-one-academic` |
| `web_dist` | path | `web/dist` |
| `secrets_file` | path | `~/.config/all-in-one-academic/secrets.env` |
| `port` | integer | `8787` |
| `surface` | string | `host` |
| `run_vault_scripts` | boolean (execute build scripts found in the vault) | `false` |
| `tasks_board` | vault-relative path | `Planning/Tasks.md` |
| `goals_file` | vault-relative path | `Planning/Goals.md` |
| `systems_dir` | vault-relative path | `Planning/Systems` |
| `data_family` | string (folder of the primary dataset family) | `main` |
| `project_prefix` | string (folder-name prefix of a live paper or grant under `Projects/papers` and `Projects/grants`) | empty |
| `primary_sources_dir` | vault-relative path (primary-source citations and corpus) | `Preparation/Reading/Primary` |
| `index_skip` | list of vault-relative path prefixes the tag index skips | empty |
| `toolkit_dir` | vault-relative path (build scripts and templates) | `Projects/toolkit` |
| `marp_render` | path to a deck renderer script | empty |
| `panel_cheat` | path | `<state_dir>/panel/cheat.json` |
| `panel_recipes` | path | `recipes/` in the vault data folder |
| `web_fonts` | boolean (load Sora and Geist from Google Fonts) | `false` |
| `habits` | list of strings | `habit-one, habit-two, habit-three` |
| `daily_log_heading` | string | `Log` |
| `daily_sections` | table: anchor to heading (TOML file only) | `Notes`, `Work`, `Entry`, `Next`, `Summary` |
| `author_name` | string | empty |
| `author_affiliation` | string | empty |
| `institution` | string | empty |
| `contact_email` | string | empty |
| `timezone` | string (IANA name) | `UTC` |
| `latitude` | number (weather is off while both are 0) | `0.0` |
| `longitude` | number | `0.0` |
| `habit_tracking_start` | date (YYYY-MM-DD) | `1970-01-01` |

The bind address is `127.0.0.1` and is not configurable.

## Licence

MIT. See `LICENSE`.
