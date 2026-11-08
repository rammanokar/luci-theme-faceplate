#!/bin/sh
# Install the Faceplate LuCI theme onto an OpenWrt router and make it the default.
# Usage: ./install.sh [host]   (default root@192.168.0.1)
set -e
HOST="${1:-root@192.168.0.1}"
cd "$(dirname "$0")"
python3 tools/build.py
cd dist
tar -cf - www usr | ssh "$HOST" '
	set -e
	rm -rf /www/luci-static/faceplate/icons /www/luci-static/faceplate/icons-LICENSE.txt
	tar -xf - -C /
	chown -R root:root /www/luci-static/faceplate /www/luci-static/resources/menu-faceplate.js /www/luci-static/resources/view/faceplate /usr/share/ucode/luci/template/themes/faceplate /usr/share/luci/menu.d/luci-theme-faceplate.json /usr/share/rpcd/acl.d/luci-theme-faceplate.json /usr/share/rpcd/ucode/faceplate
	/etc/init.d/rpcd restart
	sleep 2
	# safety net: if the audit plugin misbehaves, pull it so rpcd/LuCI stay usable
	if ! ubus -t 15 call faceplate audit >/dev/null 2>&1 || ! ubus -t 5 call luci getVersion >/dev/null 2>&1; then
		echo "WARNING: audit plugin failed its health check; removing it" >&2
		rm -f /usr/share/rpcd/ucode/faceplate
		/etc/init.d/rpcd restart
	fi
	uci -q get luci.main.fp_previous >/dev/null || uci set luci.main.fp_previous="$(uci -q get luci.main.mediaurlbase)"
	uci set luci.themes.Faceplate=/luci-static/faceplate
	uci set luci.main.mediaurlbase=/luci-static/faceplate
	uci commit luci
	rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache 2>/dev/null || true
	echo "Faceplate installed; previous theme: $(uci -q get luci.main.fp_previous)"
'
