# Isolated host cutover integration notes

This is a reviewed administrator procedure, not an automatic application deployment. Do not execute it while writers run. The installer creates accounts and directories only; it neither migrates data nor replaces active units. The controller tracks `dev`; it must stay disabled until cutover acceptance.

## Paths and identities

- Operator/controller: `acaccel`; stage `/var/lib/pleiades-deployer/stage`; root-only transaction journal `/var/lib/pleiades-deployment`.
- Bots: `pleiades`; immutable releases `/opt/pleiades-fleet/releases/<id>`; mutable `data` and `logs` links to `/var/lib/pleiades-fleet` and `/var/log/pleiades-fleet`.
- Settings: `/etc/pleiades-fleet/bots/<bot>/{.env,config.json}` and optional `/etc/pleiades-fleet/guild_profile.json`; directories root:pleiades-settings 0750, files root:pleiades-settings 0640. Operator and service share read-only group; no write access. New login/restarted controller is required for supplementary groups.
- MongoDB: `pleiades-mongo`; runtime `/opt/pleiades-mongo/runtime`; configuration `/etc/pleiades-mongo/mongod.conf`; data `/var/lib/pleiades-mongo/data`; logs `/var/log/pleiades-mongo`. MongoDB remains 7.0.34.
- Backups: `pleiades-backup`; `/etc/pleiades-backup/backup.env` owned by this account 0600, containing only the MongoDB backup URI; `/var/backups/pleiades` 0700. Its supplementary `pleiades` group allows reading immutable app code, not bot settings or MongoDB files.

## Preparation before stopping services

1. Complete the full gate. Install the root-owned controller snapshot with its `--prepare` mode first. It must provide `/opt/pleiades-auto-deploy/current/runtime/bin/node` (official 22.23.4); do not enable its timer.
2. Review and render scaffolding as an ordinary user:

   ```sh
   node tools/local-deployment/install.mjs --dry-run --deployer acaccel --bots tomori,nijika,msg-archive,konata
   ```

   Apply the reviewed scaffolding explicitly as administrator:

   ```sh
   sudo /opt/pleiades-auto-deploy/current/runtime/bin/node tools/local-deployment/install.mjs --deployer acaccel --bots tomori,nijika,msg-archive,konata
   ```

3. Record the old deployment configuration, MongoDB `configFile` and actual `storage.dbPath`, runtime prefix, service enabled/active states and unit files/drop-ins, current commit, existing backup directory, all configuration files and existing schema. Read paths from `deployment.json` and active `mongod.conf`, never infer data from installation paths. Keep the resulting receipt and complete backups outside all release/data roots, root-owned 0700. Preserve permissions and numeric owners (for example `tar --acls --xattrs --numeric-owner`); do not print credentials.
4. Keep the old runtime and paths. Prepare a _separate_ exact MongoDB 7.0.34 runtime at `/opt/pleiades-mongo/runtime`, root-owned and world-readable/executable for the tools; preserve its package manifest and checksums. Prefer recreating/cloning the pinned Conda environment for the final prefix, since copying Conda environments can retain old prefixes. Reject activation hooks, symlinks/ELF library paths into `/home`, missing shared libraries, or any version change. Verify under the actual identities:

   ```sh
   sudo runuser -u pleiades-mongo -- /opt/pleiades-mongo/runtime/bin/mongod --version
   sudo runuser -u pleiades-backup -- /opt/pleiades-mongo/runtime/bin/mongodump --version
   ```

   Archive the runtime/tool checksums in the receipt. No database files are copied in this step.

5. Populate bot settings with `sudo install -o root -g pleiades-settings -m 0640 ...`, preserving the original credentials. Create the backup-only env separately with least-privilege backup credentials, `pleiades-backup:pleiades-backup` 0600; never copy an entire bot env containing Discord/LLM tokens into the backup account. Preserve the old full configuration backup before changing any URI/path.
6. Configure the independent deployment checkout with `user: "pleiades"` and the fixed `isolation` object. `runtimePrefix`/`PLEIADES_NODE_PREFIX` selects the official build runtime; `PLEIADES_CONDA_PREFIX` selects fonts-only assets. `prepareIsolatedRelease` needs read access to selected `/etc` bot env/config files, Git-tracked app files, installed node_modules and fonts. It copies no ignored/private source files. Its stage has no absolute links to secrets.

## Offline data and unit transition

1. Disable the automatic deploy timer and Mongo backup timer. Stop all bot services and any unmanaged launchers; stop MongoDB cleanly last. Record their prior states. Confirm systemd PIDs are zero and no `mongod`/bot process still uses the old data/working directories. Cancel the cutover if any writer remains.
2. Only now take a complete cold snapshot of the _entire_ active `dbPath`, including its admin database/users/roles, plus all app data/media, secrets/settings, original Mongo config, runtime/package receipts and unit files/drop-ins. Keep existing logical backups too. Existing daily logical backups omit system databases and therefore do not replace this complete snapshot. Verify snapshot integrity and restore/schema compatibility in isolation before moving on.
3. Copy the stopped complete database into an initially absent `/var/lib/pleiades-mongo/data`; do not initialize a new database and do not overwrite an existing destination. Copy application data and historical logs into their new roots. Preserve the old backup directory as a separate complete snapshot, then migrate retained logical snapshots into the new backup area with pleiades-backup:pleiades-backup ownership; bootstrap deliberately leaves preexisting backup ownership untouched so the active old timer keeps working until stopped. The isolated backup installer refuses mixed or legacy snapshot owners. Retain the old trees unchanged for recovery. Change only destination ownership: Mongo data to pleiades-mongo:pleiades-mongo 0700, app data/logs to pleiades:pleiades with no group writes. Use filesystem-aware archival copying that preserves metadata; inspect symlinks and migrate any intentional writable links outside the old roots explicitly.
4. Copy the old Mongo configuration, retaining authorization, network/port, storage-engine settings and feature-compatibility assumptions. Change `storage.dbPath` to `/var/lib/pleiades-mongo/data`; run in foreground (`processManagement.fork=false`, remove `pidFilePath`); route file logs to `/var/log/pleiades-mongo/mongod.log`. Migrate key/certificate paths if present. Reject remaining `/home` paths. Install root:pleiades-mongo 0640 at `/etc/pleiades-mongo/mongod.conf`.
5. Preserve and remove the disabled legacy bot, Mongo and backup unit definitions/drop-ins from `/etc/systemd/system` only after the receipt/backups exist. The helper deliberately rejects legacy markers rather than silently adopting them. Do not delete original release manifests or original service definitions from the receipt.
6. Render and review MongoDB's dedicated unit, verify it, then explicitly install/reload/start it:

   ```sh
   node tools/local-deployment/render-mongo.mjs > /tmp/mongodb-pleiades.service
   systemd-analyze verify /tmp/mongodb-pleiades.service
   sudo install -o root -g root -m 0644 /tmp/mongodb-pleiades.service /etc/systemd/system/mongodb-pleiades.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now mongodb-pleiades.service
   ```

   Check its executable owner/version, active `dbPath`, authenticated reads/writes, users/roles, representative collection counts and existing data. No automatic controller code restarts this service. Require a successful probe under the service identity using the prepared immutable app runtime and `/etc` settings before proceeding.

7. Prepare the first app release as the operator in a fresh login/session with `pleiades-settings`. Review its manifest and static units; install with the allowlisted helper. The install atomically updates only selected bots, verifies fresh readiness markers and rolls back failed services. Every release includes its own official Node runtime and fonts; rollback does not depend on a mutable Conda or home-directory runtime.
8. After an app release is ready, install the dedicated backup timer, pinning that exact installed release id:

   ```sh
   npm run backup:install -- --release <installed-release-id>
   sudo systemctl start pleiades-mongo-backup.service
   ```

   The explicit backup installer requires normal administrator authentication; it is not covered by the automatic controller's sudo rule. Confirm the backup contains all expected application databases and test restoring it separately. Keep the complete cutover snapshot for users/roles; routine app backup semantics do not change. Runtime/script/dependencies are pinned under the selected immutable app release and retention preserves the release while the backup unit references it.

9. Validate Discord connections, Canvas CJK rendering, archive reads/writes, notifications including Konata restarts, database readiness, log paths, backup restore and boot-enabled state. Then enable the controller/timer; confirm the root host bot allowlist excludes gopher unless intentionally enabled.

## Recovery and subsequent operation

- Inspect `sudo /usr/local/libexec/pleiades-local-deploy status`; use `sudo /usr/local/libexec/pleiades-local-deploy recover` for an interrupted isolated app transaction. Its root-owned fsync'd journal survives process interruption. An install that reached the committed state is finalized rather than rolled back on recovery.
- For initial host/data cutover failure, stop new writers and MongoDB before restoring preserved unit definitions/settings/paths. If any new writes occurred, keep complete snapshots of both old and new data and reconcile the latest stopped data before selecting a recovery direction. Never blindly restore the stale pre-cutover database over newer writes. Original runtimes and paths remain until operator acceptance.
- Old `deploy.ts` commands reject database/removal actions when isolation is enabled. Removing isolation from a local config cannot bypass hardened unit ownership markers. Backup removal remains an explicit administrator operation; existing snapshots are retained.
- Normal app changes restart only selected bots. MongoDB schema/engine/data cutovers and backup-runtime repinning remain explicit reviewed operations. Retention keeps the newest three app releases, all currently referenced bot releases and the backup-pinned release.
