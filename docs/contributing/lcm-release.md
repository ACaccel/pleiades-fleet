# LCM release

Part of the [contributing guide](../../CONTRIBUTING.md).

LCM (the self-hosted control plane) builds and runs the bots as one read-only
release shared by one systemd unit per bot. This page covers the repository side:
the build, the launcher and the settings an instance needs. The systemd flow in
[deployment](deployment.md) and [local auto-deployment](local-auto-deployment.md)
stays in use until the cutover; nothing here changes it.

## Build

```bash
npm run build:release   # Node 24 and npm on PATH, network access; no Conda, no tests
```

[`scripts/build-release.mjs`](../../scripts/build-release.mjs) writes `.release/`
(ignored by Git):

| Path                             | Content                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `bin/start.cjs`                  | [Launcher](#launcher)                                                                                           |
| `src/`, `assets/`                | Sources and static files; operator files (`.env`, `config.json`, `guild_profile.json`) and symlinks are skipped |
| `package*.json`, `tsconfig.json` | Dependency lock and path aliases                                                                                |
| `node_modules/`                  | `npm ci --omit=dev`: `ts-node`, `typescript` and `tsconfig-paths` are runtime dependencies                      |
| `fonts/`                         | `NotoSansCJKtc-VF.ttf` and `NotoColorEmoji.ttf`                                                                 |

Fonts come from `$LCM_INPUTS_DIR/fonts` when that variable is set (and fail the
build if the files are missing there); otherwise from `PLEIADES_FONT_DIR`,
`PLEIADES_CONDA_PREFIX/fonts` or `.conda-fonts/fonts`, so a development checkout
builds without extra setup. The build ends by loading every bot through
`start.cjs --check` from a foreign working directory, which proves that the tree is
self-contained and that native Canvas and both fonts work. Type checking, lint and
tests stay in CI, whose `release` job also runs this build.

## Launcher

`node bin/start.cjs [--check] [<bot>]` registers `ts-node` with `transpileOnly`
(no type checking at runtime) and `tsconfig-paths` relative to the release,
changes into the release root, and loads `src/bot/<bot>/index.ts`. The bot is the
first argument or else `PLEIADES_BOT`; anything outside `gopher`, `konata`,
`msg-archive`, `nijika`, `tomori` exits with code 2 and a message. It defaults
`NODE_ENV` to `production` (the release has no `pino-pretty`) and
`PLEIADES_FONT_DIR` to `<release>/fonts`.

`--check` loads the bot's code, fonts and, when present, its config, prints
`ok <bot>` and exits without connecting to Discord or reading secrets.

## Instance settings

All instances share the release; each has its own environment (systemd
`EnvironmentFile`, plain `KEY=value`) and its own `config.json`:

| Setting                                     | Instance value                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `TOKEN`, `CLIENT_ID`, `MONGO_URI`, API keys | Environment; no `.env` file is needed ([variables](../configuration.md#environment-variables))   |
| `PLEIADES_BOT`                              | The bot, unless passed as the first argument                                                     |
| `PLEIADES_CONFIG_FILE`                      | Absolute path of that bot's `config.json`                                                        |
| `PLEIADES_DATA_DIR`, `LOG_DIR`              | Absolute paths inside the writable state directory (for example `/var/lib/pleiades/{data,logs}`) |
| `NOTIFY_API_PORT` / `EARTHQUAKE_ALERT_PORT` | The instance's port, for the bots that expose an API ([configuration](../configuration.md))      |

Keys by bot (names only; the shared ones may live in one common environment file):

| Bot                | Per-bot keys                                                | Port (bound to 127.0.0.1) |
| ------------------ | ----------------------------------------------------------- | ------------------------- |
| `konata`           | `TOKEN`, `CLIENT_ID`, `XAI_API_KEY`, `NOTIFY_API_KEY`       | `NOTIFY_API_PORT`         |
| `nijika`, `tomori` | `TOKEN`, `CLIENT_ID`, `EARTHQUAKE_ALERT_KEY`, `CWA_API_KEY` | `EARTHQUAKE_ALERT_PORT`   |
| `nijika` only      | `MONGO_INSPECT_URI` (once `/db` is enabled)                 |                           |
| `msg-archive`      | `TOKEN`, `CLIENT_ID`                                        | none                      |

`MONGO_URI` is required by every bot except `gopher`; the logging, data-directory and
wait settings (`LOG_LEVEL`, `LOG_RETENTION_DAYS`, `MONGO_READY_TIMEOUT_SECONDS`,
`MONGO_RECOVERY_INTERVAL_MS`) are optional and shared. The listeners ignore `PORT` and
`HOST`; set the port variable to the port LCM grants.

Every database-backed bot waits for MongoDB to answer (`MONGO_READY_TIMEOUT_SECONDS`,
default 120 s) before it logs in to Discord and exits 1 on a timeout, so a unit needs
no `ExecStartPre` probe and `Restart=on-failure` covers a database that stays down. The
[systemd flow](deployment.md) keeps its probe; the in-app wait then returns at once.
`PLEIADES_READY_FILE` is optional: unset, no marker is written.

The working directory is read-only, so `PLEIADES_DATA_DIR` and `LOG_DIR` must be set;
the defaults (`./data`, `logs`) are inside the release. In production a non-empty
`LOG_DIR` sends the logs to files only; a blank `LOG_DIR` sends them to stdout (the
journal) and msg-archive transcripts go to `<PLEIADES_DATA_DIR>/logs`. See
[deployment paths](../configuration.md#deployment-paths).
A fatal startup error (a rejected Discord token, the MongoDB wait timing out) is also
written to stderr as one JSON line, so the journal carries the cause whatever `LOG_DIR` is.

## LCM document fields

```yaml
spec:
  type: service
  adapter: managed
  config:
    source:
      {
        url: https://github.com/ACaccel/pleiades-fleet.git,
        branch: dev,
        build: npm run build:release,
        timeout: 20m,
      }
    artifact: .release/
    runtime: node24
    start: bin/start.cjs
    startArgs: [konata] # one value per instance; PLEIADES_BOT in the instance env is equivalent
```

The host grants the service an input `fonts` (`lcm host allow ... --input
fonts=<directory with the two font files>`). The multi-instance interface of LCM
(one unit, environment file and port per bot) is still being designed; the fields
above are the single-service form.

## At cutover

- `.nvmrc` moves from Node 22.23.4 to 24.22.1. The current controller builds
  releases with the Node pinned in `.nvmrc`, so a `dev` commit containing the new
  pin deploys only after the controller host has the Node 24 runtime prepared;
  see [CUTOVER](../../tools/local-deployment/CUTOVER.md).
- Per-bot `.env` and `config.json` leave `/etc/pleiades-fleet/bots/<bot>/` for the
  instance environment and `PLEIADES_CONFIG_FILE`.
- Data (`/var/lib/pleiades-fleet`) and logs (`/var/log/pleiades-fleet`) move to the
  service's state directory or are pointed at through `PLEIADES_DATA_DIR` and `LOG_DIR`.
- Not handled by the launcher: msg-archive measures MongoDB's data directory for its
  storage budget and so needs read access to it (today through the `pleiades-mongo`
  group). The budget also counts the release and the Node runtime, but not a state
  directory outside the release: list it in `archive_runtime.storage.additional_roots`
  of msg-archive's `config.json`.
