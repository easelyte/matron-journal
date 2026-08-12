# Deployment hardening

matron-journal is internet-adjacent (a public client endpoint fronts it), so a
code-execution bug should not be able to reach anything on the host beyond the
service's own data. How much isolation you get depends on how you run it.

## Reference deployment (recommended for production)

Run as a dedicated, unprivileged user out of `/opt`, with the sandboxed unit in
`deploy/matron-journal.service`. This is the fully-contained model:

```
sudo useradd --system --home-dir /opt/matron-journal --shell /usr/sbin/nologin matron
sudo install -d -o matron -g matron /opt/matron-journal /opt/matron-journal/data
# deploy the code under /opt/matron-journal (git clone / rsync), owned by matron
sudo -u matron npm ci --omit=dev --prefix /opt/matron-journal
sudo cp deploy/matron-journal.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now matron-journal
systemd-analyze security matron-journal.service   # sanity-check the exposure score
```

The unit sets `ProtectHome=yes`, `ProtectSystem=strict` with only
`/opt/matron-journal/data` writable, drops all capabilities, and restricts the
syscall/address-family surface — so the process cannot read the operator's home,
other services' secrets, or the rest of the filesystem.

### APNs key with the sandboxed unit

With `ProtectHome=yes` the service cannot read a key placed in a user's home.
Put the `.p8` somewhere the sandbox allows and point `MATRON_APNS_KEY_FILE` at
it — the simplest is under the service's own tree, e.g.
`/opt/matron-journal/apns_key.p8` (owned `matron:matron`, mode `600`), which
`ProtectSystem=strict` leaves readable. Set the four `MATRON_APNS_*` vars via a
drop-in (`systemctl edit matron-journal`).

## Single-user / dev-box deployment (in-place hardening)

If the service runs as a normal login user out of that user's home (the dev-box
convention), full isolation is not achievable — the process shares the user's
home, so a compromise can still read whatever that user can (`~/.ssh`, other
services' env files, etc.). The honest options are:

1. **In-place hardening drop-in** — adds every protection compatible with the
   home layout (no new privileges, read-only system tree, dropped capabilities,
   restricted syscalls/address families, private tmp/devices), *without*
   `ProtectHome` (which would break reading the code, data, and APNs key under
   home). This blocks privilege escalation, kernel tampering, and most of the
   syscall surface, but does **not** contain the home-read blast radius. Install:

   ```
   sudo mkdir -p /etc/systemd/system/matron-journal.service.d
   sudo tee /etc/systemd/system/matron-journal.service.d/hardening.conf <<'EOF'
   [Service]
   NoNewPrivileges=yes
   ProtectSystem=strict
   ReadWritePaths=/home/<user>/matron-journal/data
   PrivateTmp=yes
   PrivateDevices=yes
   ProtectKernelTunables=yes
   ProtectKernelModules=yes
   ProtectKernelLogs=yes
   ProtectControlGroups=yes
   ProtectClock=yes
   ProtectHostname=yes
   ProtectProc=invisible
   ProcSubset=pid
   CapabilityBoundingSet=
   AmbientCapabilities=
   RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
   RestrictNamespaces=yes
   RestrictRealtime=yes
   RestrictSUIDSGID=yes
   LockPersonality=yes
   SystemCallArchitectures=native
   SystemCallFilter=@system-service
   SystemCallErrorNumber=EPERM
   UMask=0077
   EOF
   sudo systemctl daemon-reload && sudo systemctl restart matron-journal
   ```

   The restart drops live journal connections; do it in a maintenance window.

2. **Move to the reference deployment above** for full containment. On a
   provisioned box this means owning the service (user, `/opt` tree, unit, data
   dir, and APNs-key placement) in configuration management rather than by hand,
   so it survives a rebuild.
