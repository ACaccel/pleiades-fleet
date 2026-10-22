import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** MongoDB cutover stays an explicit administrator operation, outside application deployment. */
export function renderMongoUnit() {
  return `# Managed by Pleiades isolated MongoDB cutover
[Unit]
Description=Pleiades MongoDB
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=exec
User=pleiades-mongo
Group=pleiades-mongo
WorkingDirectory=/var/lib/pleiades-mongo
Environment=PATH=/opt/pleiades-mongo/runtime/bin:/usr/bin:/bin
Environment=CONDA_PREFIX=/opt/pleiades-mongo/runtime
ExecStart=/opt/pleiades-mongo/runtime/bin/mongod --config /etc/pleiades-mongo/mongod.conf
TimeoutStartSec=135
TimeoutStopSec=120
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
KillMode=control-group
LimitNOFILE=64000
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
CapabilityBoundingSet=
ReadWritePaths=/var/lib/pleiades-mongo /var/log/pleiades-mongo
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(renderMongoUnit());
