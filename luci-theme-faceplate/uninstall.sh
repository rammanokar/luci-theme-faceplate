#!/bin/sh
# Restore the previous LuCI theme and remove Faceplate.
HOST="${1:-root@192.168.0.1}"
ssh "$HOST" '
	prev="$(uci -q get luci.main.fp_previous)"
	uci set luci.main.mediaurlbase="${prev:-/luci-static/bootstrap}"
	uci -q delete luci.main.fp_previous
	uci -q delete luci.themes.Faceplate
	uci commit luci
	rm -rf /www/luci-static/faceplate /www/luci-static/resources/menu-faceplate.js /www/luci-static/resources/view/faceplate /usr/share/ucode/luci/template/themes/faceplate /usr/share/luci/menu.d/luci-theme-faceplate.json /usr/share/rpcd/acl.d/luci-theme-faceplate.json /usr/share/rpcd/ucode/faceplate /tmp/faceplate-pwcheck.json /tmp/luci-indexcache*
	/etc/init.d/rpcd restart
	echo "Restored theme: ${prev:-/luci-static/bootstrap}"
'
