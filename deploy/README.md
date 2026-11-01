# deploy/ — run session-bridge on a Linux host

## One-shot install (systemd)

```bash
git clone <this-repo> && cd rokid-glasses-grokbot-open
sudo bash deploy/install.sh
```

The script installs Node 20 if needed, creates system user `leqi-bridge`, copies the tree to `/opt/leqi-grokbot-bridge`, writes `/etc/leqi-grokbot-bridge.env` (mode 600, random `BRIDGE_TOKEN`, listen `127.0.0.1:8787`), and enables `session-bridge.service` (`Restart=always`). Re-runs are safe and will not overwrite an existing env file.

Then set delivery / webhook options:

```bash
sudo nano /etc/leqi-grokbot-bridge.env
# PUBLIC_BASE_URL=https://glasses.example.com
# DELIVERY_MODE=gateway
# optional webhook fallback: GROKBOT_WEBHOOK_URL= / GROKBOT_WEBHOOK_KEY=
sudo systemctl restart session-bridge
curl -s localhost:8787/health
journalctl -u session-bridge -f
```

Expose `8787` only via a reverse proxy or tunnel you control. Do not publish the port raw on the internet.

See also `deploy-hub/` for Prism Hub sideload helpers (examples only).
