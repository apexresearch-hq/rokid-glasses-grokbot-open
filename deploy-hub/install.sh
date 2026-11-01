set -e
cd /tmp/hubdeploy
id prism-hub >/dev/null 2>&1 || sudo useradd --system --home /var/lib/prism-hub --create-home --shell /usr/sbin/nologin prism-hub
sudo install -d -m755 /opt/prism-hub && sudo install -m755 prism-sidecar /opt/prism-hub/prism-sidecar
H=/var/lib/prism-hub/.prism; sudo install -d -o prism-hub -g prism-hub -m700 $H $H/pluginbridge-plugins
sudo rm -rf $H/pluginbridge-plugins/grokbot; sudo tar -xzf plugin.tgz -C $H/pluginbridge-plugins && sudo mv $H/pluginbridge-plugins/prism-plugin-grokbot $H/pluginbridge-plugins/grokbot
sudo sed -i '/^runtime_dependencies:/,/^[^ ]/{/^runtime_dependencies:/d;/^ /d}' $H/pluginbridge-plugins/grokbot/pluginbridge-plugin.yaml
[ -f $H/config.yaml ] || sudo install -m600 config.yaml $H/config.yaml
sudo chown -R prism-hub:prism-hub /var/lib/prism-hub
(cd $H/pluginbridge-plugins/grokbot && sudo -u prism-hub env HOME=/var/lib/prism-hub npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true)
sudo install -m644 prism-hub.service /etc/systemd/system/prism-hub.service
sudo systemctl daemon-reload && sudo systemctl enable --now prism-hub
sleep 6; systemctl is-active prism-hub session-bridge leqi-tunnel; ps -o rss,cmd -u prism-hub; free -m|head -2
rm -f /tmp/hubdeploy/config.yaml
