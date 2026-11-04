# MongoDB physical-capacity sampler

A standalone Linux/Node builtins-only sampler preserves the database/bot OS
account boundary. It reads filesystem metadata as `pleiades-mongo`; it does not
connect to MongoDB, read message contents, change database permissions, or add
the bot to database groups.

## Contract and freshness

The service atomically publishes `/run/pleiades-mongo-storage/usage.json`:

```json
{
  "version": 1,
  "root": "/var/lib/example-mongo/data",
  "measuredAt": 1790000000000,
  "usedBytes": 8192,
  "availableBytes": 1000000
}
```

- `root`: canonical absolute data directory; the root itself cannot be a symlink.
- `measuredAt`: epoch milliseconds recorded **before** walking.
- `usedBytes`: physical allocation (`lstat.blocks * 512`) of the directory tree,
  including directories and symlinks, deduplicated by device/inode. Symlinks are
  never followed, including directory replacement during traversal.
- `availableBytes`: `statfs.bavail * statfs.bsize` on the root filesystem.
- All numeric measurements must be safe nonnegative integers. Missing/unreadable
  roots, special entries, invalid measurements and all filesystem errors except
  vanished child entries (`ENOENT`) fail the sample.

This is a changing-filesystem measurement, not a consistent database snapshot.
The service completes one pass, waits 5000 ms, then starts the next; passes never
overlap. A failed pass logs a brief error code, cleans its temporary output, and
retains the previous sample and timestamp. SIGTERM/SIGINT lets the current pass
finish and interrupts the idle wait. A slow or stuck filesystem can delay
shutdown; systemd applies the 60-second stop timeout.

A reservation reader must wait for `measuredAt` **strictly after** its read
invocation, allowing up to 10 seconds. A merely recent older sample cannot prove
that preceding reservations reached the filesystem. Large trees may exceed that
window; the reader must fail closed rather than reuse the older sample.
Configure the bot reader with `ARCHIVE_MONGO_USAGE_FILE` in msg-archive's `.env`
pointing to the path above, and `archive_runtime.storage.mongo_data_root` in its
JSON settings pointing to the verified active `storage.dbPath`. Direct local measurement remains the explicit default when
OS account isolation is not used.

## Review and install

First verify the **active** MongoDB service's config/startup arguments and actual
`storage.dbPath`. Supply that directory explicitly; the installer does not infer
or certify the active MongoDB configuration. Example paths below are placeholders.

```sh
node tools/mongo-storage/install.mjs --mongo-data-root /var/lib/example-mongo/data --dry-run
sudo /path/to/reviewed/node tools/mongo-storage/install.mjs --mongo-data-root /var/lib/example-mongo/data
```

Dry-run is available without root and prints a plan only: it performs no writes,
subprocesses, service actions, or privileged preflight. Review this source before
running the installer as root from a trusted checkout.

The default service runtime is
`/opt/pleiades-auto-deploy/current/runtime/bin/node`. Installation resolves and
pins its immutable target, verifies root ownership and non-writable ancestors,
checks official `.pleiades-runtime.json` checksum metadata and the repository's
`.nvmrc` version, and verifies executable access with `runuser -u pleiades-mongo`.
It downloads nothing. If controller directory permissions prevent database-account
access, prepare a separate root-owned official runtime using the project's
existing runtime setup, then use `--node /opt/accessible-node/bin/node` in both
commands. Do not relax controller directory permissions for this sampler.
Paths must be normalized absolute paths using letters, digits, `_`, `.`, `/`,
and `-`; home and temporary paths are rejected because the unit hides them.

The existing `pleiades-mongo` account and matching primary group are required.
Data path ancestors must be controlled by root or that account and cannot be
writable by others. The installer never changes existing database ownership or
permissions. Installation refuses symlink/unmanaged targets, unmanaged runtime
output, and inherited or unit-specific systemd drop-ins; replacements require the sampler's managed marker.
It stages and checks the unit with `systemd-analyze verify`, then runs a one-shot
sampler as the database account into an isolated temporary directory under
`/run`. Only after successful preflight does it atomically install the root-owned,
self-contained `/usr/local/libexec/pleiades-mongo-storage.mjs` and unit, reload
systemd, enable and start/restart **only** `pleiades-mongo-storage.service`.
MongoDB and bots are never restarted. No sudo policy is added.

The unit uses `ProtectSystem=strict`, `ProtectHome=true`, an explicit
`ReadOnlyPaths` for the database tree, no capabilities and no network access.
Only `/run/pleiades-mongo-storage` is writable. systemd creates it as database
account/group mode `0755`; the atomic output is mode `0644`. The bot can read the
aggregate but cannot write it or inspect the protected database tree. Verify
freshness and access under the actual bot account before configuring the reader.

## Verify and troubleshoot

```sh
systemctl status pleiades-mongo-storage.service
journalctl -u pleiades-mongo-storage.service -n 30 --no-pager
stat -c '%U:%G %a %n' /run/pleiades-mongo-storage /run/pleiades-mongo-storage/usage.json
cat /run/pleiades-mongo-storage/usage.json
```

Confirm `root` matches the actual dbPath and `measuredAt` advances after completed
passes. `EACCES` means the database account cannot traverse/read an input or
publish output; correct the intended deployment layout rather than grant bot
access to the database. `INVALID_SAMPLE` covers unsafe entry types, overflow, or
validation errors. Use `--once` with a **separate** output directory owned by the
database account to distinguish input errors from sandbox/runtime access errors.
The service depends on Linux `/proc/self/fd` for safe anchored traversal.

Standalone preflight (output directory must already exist, be sampler-owned and
not writable by others; output must be outside the measured tree):

```sh
/path/to/node tools/mongo-storage/sampler.mjs --root /var/lib/example-mongo/data --output /run/operator-preflight/usage.json --once
```

`--interval-ms` accepts integers from 1 through 2147483647; the installed unit
always uses 5000. CLI errors exit nonzero; no credentials are accepted.

## Rollback

First restore the bot's previous storage configuration; a reader pointing at a
removed sample will fail. Then disable/stop only the sampler:

```sh
sudo systemctl disable --now pleiades-mongo-storage.service
```

After checking the managed marker and absence of custom changes, remove only
`/etc/systemd/system/pleiades-mongo-storage.service` and
`/usr/local/libexec/pleiades-mongo-storage.mjs`, then run
`sudo systemctl daemon-reload`. systemd removes the runtime sample directory on
stop. Preserve any unrelated files and the shared Node runtime. To undo an
upgrade, restore the previously reviewed managed script/unit together and
restart only the sampler. A failed installation after publication may leave the
new managed script/unit present; inspect them and rerun or restore that pair.

## Tests

```sh
npm run test:tools -- tools/mongo-storage
```

Tests use synthetic temporary trees and do not install services or access
production data. Root installation and the host-specific sandbox require an
operator preflight on the target host.
