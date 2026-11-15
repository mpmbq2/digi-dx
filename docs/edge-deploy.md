# Deploying & Auto-Updating the Edge Container

The Digi-Dx edge client runs as a Docker container on the radio computer and updates automatically from GitHub Container Registry (`ghcr.io/mpmbq2/digi-dx-edge:latest`) via a `systemd` timer, guarded by a **30-minute inactivity check** so updates never interrupt an active QSO or session.

## How CI/CD Works

1. **Build & Push (`.github/workflows/edge-image.yml`)**: Every push to `main` builds `Dockerfile.edge` and pushes `ghcr.io/mpmbq2/digi-dx-edge:latest` (plus a `sha-<short>` tag) to GHCR.
2. **Activity-Gated Auto-Update (`deploy/edge/update-edge.sh`)**: Every 5 minutes, `digi-dx-edge-updater.timer` runs `update-edge.sh`:
   - Queries `GET http://127.0.0.1:8792/api/update-readiness?minIdleSeconds=1800`.
   - `EdgeRuntime` tracks operator/TX activity (PTT assertions, `tx` events, cloud `transmit`/`cancel_transmit`/`pairing_complete`, config saves, CAT/PTT tests). Passive RX decodes do **not** count as activity.
   - If PTT is active, the engine is transitioning, uptime is under 60s, or the last activity was less than 30 minutes ago, the update is **deferred** until the station is idle.
   - Otherwise, it pulls the new image, re-verifies readiness, and restarts `digi-dx-edge` via Docker Compose.

## First-Time Setup on the Radio Computer (`c3p0`)

1. Ensure `rigctld` is running on the host (if using CAT over `127.0.0.1:4532`) and stop any bare-metal `npm run edge` process so port `8792` is free.
2. Copy the example environment file (optional):
   ```bash
   cp deploy/edge/.env.example deploy/edge/.env
   ```
3. Make sure the `ghcr.io/mpmbq2/digi-dx-edge` package is **Public** on GitHub Packages (or run `docker login ghcr.io` once if private).
4. Start the container:
   ```bash
   docker compose -f deploy/edge/docker-compose.yml up -d
   ```
5. Install and enable the 5-minute `systemd` updater timer:
   ```bash
   sudo cp deploy/edge/digi-dx-edge-updater.service /etc/systemd/system/
   sudo cp deploy/edge/digi-dx-edge-updater.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now digi-dx-edge-updater.timer
   ```

## Monitoring & Manual Control

- Check updater timer status: `systemctl status digi-dx-edge-updater.timer`
- View updater logs: `journalctl -u digi-dx-edge-updater.service -n 50`
- Check readiness directly: `curl -s http://127.0.0.1:8792/api/update-readiness | python3 -m json.tool`
- Force an immediate check: `sudo systemctl start digi-dx-edge-updater.service`
