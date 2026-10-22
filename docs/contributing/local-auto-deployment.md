# Local automatic deployment

This host follows **`origin/dev`**, independently of `main` releases. The development
checkout is never installed directly. Existing hosts must complete the offline
[cutover](../../tools/local-deployment/CUTOVER.md) before enabling automation.

## Boundaries

| Component            | Account                   | Writable content                                                                          |
| -------------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| Controller and build | Deployment operator       | Independent release worktree and `/var/lib/pleiades-deployer`                             |
| Bots                 | `pleiades`                | `/var/lib/pleiades-fleet`, `/var/log/pleiades-fleet`, private systemd runtime directories |
| MongoDB              | `pleiades-mongo`          | Its database, journal and log directories                                                 |
| Daily backup         | `pleiades-backup`         | Its backup directory                                                                      |
| Install helper       | root, restricted commands | Fixed application releases and managed bot units                                          |

Root owns application releases under `/opt/pleiades-fleet` and settings under
`/etc/pleiades-fleet`. Bots have no login shell or GitHub credentials and cannot
write their executable files. `pleiades-settings` grants the bots and operator
read access to settings; these accounts intentionally share bot credentials.
MongoDB storage is accessible only to its separate account. These are OS account
and filesystem boundaries, rather than separate containers per bot.

Each release contains its own official Node runtime, npm dependencies and font
assets. Rollback restores those together with units. Shared configuration,
application state, database writes and Discord actions are outside code rollback.
The helper retains the newest three releases plus every service/backup reference.

## Deployment cycle

1. Fetch `origin/dev`, then require successful **push** runs for that exact SHA:
   CI jobs `quality`, `tests`, `security`; CodeQL `analyze`; and `migration-drill`
   when its path filter applies or a push drill exists. A missing, skipped,
   cancelled or failing required job blocks installation.
2. Compare each enabled bot against its own last installed SHA. A bot-directory
   change restarts that bot; shared or unknown changes restart all enabled bots.
   Documentation-only changes require no restart. Unknown history is conservative.
3. Check out the SHA in a separate, clean detached worktree. Copy only explicitly
   configured ignored operational snapshots and seed committed config examples for disabled
   bots without their credentials. Install the pinned official Node and
   Conda fonts, run `npm ci`, all eight local quality gates, and stage the release.
4. Publish pre-stop progress, then recheck dev and required CI immediately before
   invoking the installed helper. The helper copies root-owned code with explicit service-group permissions
   despite its private umask, then checks Node, dependencies, settings and graphics
   as the service account before stopping selected bots. It snapshots units,
   installs units, and checks process-specific readiness.
5. Save each successfully deployed bot's SHA. Failed installation restores prior
   units and active/enabled state; interruption keeps a recovery journal.

A kernel lock covers the whole cycle. Build failure pauses retries for that SHA;
another dev commit or `retry-build` permits a new attempt. An installation marker
always requires explicit `recover`, including after a successful host rollback.
Ordinary polling never restarts MongoDB or changes its version, schema or backup
schedule. Those operations require the maintenance procedure.

## Notifications

Add `pleiades-deploy` to Konata's `notificationRoutes`, using the intended guild
and channel, and keep `NOTIFY_API_KEY` in Konata's private `.env`. The controller
reads the same key from a separate operator-owned `0600` file. Only numeric
loopback HTTP endpoints are accepted; redirects are rejected. See the relay
[configuration](../configuration.md#notification-relay-api).

One commit uses one relay key (`pleiades-dev-<full SHA>`). The Discord message
lists the targeted bots and database services, per-component results and attempt
number. A retry updates the same message. Deploying Konata does not suppress
notifications: pre-stop progress is sent first, the latest progress is saved
while Konata is unavailable, and readiness/final progress is sent after it returns.
No successful deployment is failed by a notification outage.

The durable outbox keeps at most 100 commit threads for seven days, with at most
40 delivery attempts per saved payload. Polls retry notifications even while
installation is halted; each flush is bounded to eight deliveries. New progress
replaces older pending progress for the same commit. These limits bound offline
state and retries; delivery is best effort, not guaranteed during a prolonged outage.

## Install

First complete all local checks, commit and push to `dev`, and confirm GitHub CI.
The controller snapshot deliberately uses tracked files: uncommitted implementation
files are unsuitable for installation. Preserve the running legacy services until
the cutover backup and rollback material have been verified.

1. Create the official runtime and font environment following [local setup](local-setup.md).
   With legacy `.deploy/current.json`, preserve `.conda` and prepare the new Node
   and `.conda-fonts` independently; do not remove deployment state to bypass guards.
2. Use the verified Node executable to install the stable controller **without
   enabling its timer**, then bootstrap isolated accounts and the restricted helper:

   ```bash
   node_path="$(node scripts/runtime.mjs path)"
   sudo "$node_path" tools/auto-deployment/install.mjs "$USER" "$PWD" --prepare
   sudo "$node_path" tools/local-deployment/install.mjs --deployer "$USER" --bots tomori,nijika,msg-archive,konata
   ```

3. Follow [CUTOVER.md](../../tools/local-deployment/CUTOVER.md) to copy settings,
   state, MongoDB and backup service into their dedicated locations. Settings are
   root-owned; code deployment does not silently overwrite them. Preserve old
   runtime/data/units until recovery has been verified.
4. Prepare `/var/lib/pleiades-deployer/inputs` as private operator-owned snapshots,
   including [isolated `deployment.json`](../../deployment.isolated.example.json) and enabled bots' `.env` / `config.json`.
   Add optional `src/guild_profile.json` and other required operational files
   explicitly. These build inputs are independent of the development checkout.
5. Copy [config.example.json](../../tools/auto-deployment/config.example.json) to
   `/etc/pleiades-auto-deploy.json` (root-owned, no group/other write), adjusting
   paths and enabled bots. Use the actual relay listening port. Set the state
   directory and input directory to `0700`, snapshots and relay key to `0600`.
   Add the same route to the installed Konata settings and build snapshot.
6. Run `inspect`, then reinstall the controller without `--prepare` to enable its
   timer. Supplementary group access takes effect for the new controller process;
   use a new login for manual operator commands. Installer preflight keeps the operator's
   primary group while adding the read-only settings group, so operator-group configuration
   files remain readable.

The timer checks after boot and every minute after the prior cycle ends. Updating
controller implementation requires rerunning its installer; application pushes
do not modify the stable controller. Installation refuses to replace a running
controller, so wait for its cycle to finish. Installer exceptions restore the prior
controller, units and timer state. A sudden interruption during this manual
bootstrap requires administrator inspection before re-enabling the timer. Root authority is granted only to the
installed helper's `install <release-id>`, `recover` and `status`; ordinary
controller/build code runs as the deployment operator. Do not grant general sudo
to build scripts.

## Inspect and recover

Use the stable controller runtime; it remains usable when the dev checkout is
broken or its runtime pin changes:

```bash
controller=/opt/pleiades-auto-deploy/current
"$controller/runtime/bin/node" -r "$controller/node_modules/ts-node/register" "$controller/scripts/auto-deploy.ts" inspect
systemctl status pleiades-auto-deploy.timer
journalctl -u pleiades-auto-deploy.service -n 50
sudo /usr/local/libexec/pleiades-local-deploy status
```

Run controller commands from its directory with `TS_NODE_PROJECT` pointing to its
`tsconfig.json`, as the systemd unit does. `inspect` fetches dev/reads CI and state;
it does not install or send notifications. Run `retry-build` only after fixing the
build failure. Stop the timer before manual maintenance, inspect root and controller
journals, then use `recover` to reconcile an interrupted installation. Preserve
journals when recovery fails. A source/configuration correction may be necessary;
deleting markers is not recovery. Re-enable the timer after readiness is verified.

Daily backup operations and their restore limitations are documented in the
[backup guide](../../tools/mongo-backup/README.md). A daily application dump alone
does not replace the full offline database/settings backup required for cutover.
