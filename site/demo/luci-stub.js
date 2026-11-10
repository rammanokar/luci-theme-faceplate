/*
 * Just enough of LuCI's client runtime (L, E, ui, rpc, fs, poll) to run the
 * real Faceplate menu and dashboard modules in a static page, answering every
 * RPC call from mock-data.js. Traffic and CPU counters advance on each poll so
 * the charts move.
 */
'use strict';

String.prototype.format = function() {
	var a = arguments, i = 0;
	return this.replace(/%([%sd])/g, function(m, c) { return c == '%' ? '%' : String(a[i++]); });
};
window._ = function(s) { return s; };

var DEMO_HOME = 'admin/dashboard';
window.L = {
	env: { dispatchpath: DEMO_HOME.split('/'), requestpath: DEMO_HOME.split('/') },
	url: function() { return '#page=' + Array.prototype.slice.call(arguments).join('/'); }
};
window.E = function(tag, attrs, children) {
	var n = document.createElement(tag);
	for (var k in (attrs || {})) {
		var v = attrs[k];
		if (v == null) continue;
		if (typeof v == 'function') n.addEventListener(k, v); else n.setAttribute(k, v);
	}
	(Array.isArray(children) ? children : (children != null ? [ children ] : [])).forEach(function(c) {
		if (c != null) n.appendChild(c instanceof Node ? c : document.createTextNode(c));
	});
	return n;
};

var ui = {
	menu: {
		load: function() { return Promise.resolve(FXMENU); },
		getChildren: function(n) {
			return Object.keys(n.children || {}).map(function(k) { return Object.assign(n.children[k], { name: k }); })
				.filter(function(c) { return c.title; })
				.sort(function(a, b) { return (a.order || 9999) - (b.order || 9999); });
		}
	}
};
var baseclass = { extend: function(o) { return o; } };
var view = { extend: function(o) { return o; } };

var clone = function(o) { return JSON.parse(JSON.stringify(o)); };
var later = function(v, ms) { return new Promise(function(res) { setTimeout(function() { res(v); }, ms); }); };
var tick = 0, cpu = FX.stat.replace(/^cpu\s+/, '').split(/\s+/).map(Number);

var rpc = { declare: function(spec) { return function(arg) {
	switch (spec.object + '.' + spec.method) {
	case 'network.device.status':
		tick++;
		var r = clone(FX.devstatus), burst = Math.sin(tick / 6) > 0.6 ? 4 : 1;
		var add = function(dev, rx, tx) {
			if (!r[dev]) return;
			r[dev].statistics.rx_bytes += Math.round(rx * tick * (0.8 + Math.random() * 0.4) * burst);
			r[dev].statistics.tx_bytes += Math.round(tx * tick * (0.8 + Math.random() * 0.4));
		};
		add('wan', 3e6, 4e5); add('lan3', 2e4, 1e5);
		return Promise.resolve(r);
	case 'network.interface.dump':       return Promise.resolve(clone(FX.ifdump.interface));
	case 'system.info':                  return Promise.resolve(clone(FX.sysinfo));
	case 'system.board':                 return Promise.resolve(clone(FX.board));
	case 'luci.getBuiltinEthernetPorts': return Promise.resolve(clone(FX.ports.result));
	case 'luci-rpc.getDHCPLeases':       return Promise.resolve(clone(FX.leases));
	case 'luci-rpc.getWirelessDevices':  return Promise.resolve(clone(FX.wifi));
	case 'luci-rpc.getHostHints':        return Promise.resolve(clone(FX.hints));
	case 'iwinfo.assoclist':             return Promise.resolve(clone((arg == 'phy0-ap0' ? FX.assoc0 : FX.assoc1).results));
	case 'iwinfo.scan':                  return later(clone((arg == 'phy0-ap0' ? FX2.scan0 : FX2.scan1).results), 900);
	case 'faceplate.audit':              return later(clone(FX2.audit), 500);
	}
	return Promise.reject(new Error('demo: no mock for ' + spec.object + '.' + spec.method));
}; } };

var fs = { read: function(p) {
	if (p == '/proc/stat') {
		cpu[0] += 9 + Math.random() * 6; cpu[2] += 6; cpu[3] += 180 + Math.random() * 40;
		return Promise.resolve('cpu  ' + cpu.map(Math.round).join(' ') + '\n');
	}
	if (/count$/.test(p)) return Promise.resolve(String(FX.ct + Math.round(Math.random() * 30)));
	if (/max$/.test(p)) return Promise.resolve(String(FX.ctmax));
	return Promise.reject(new Error('demo: no file ' + p));
} };
var poll = { add: function(fn, s) { setInterval(fn, s * 1000); } };

/* Seed a couple of minutes of traffic history so the chart isn't empty on first load. */
(function() {
	var now = Date.now(), s = [], c = [];
	for (var i = 74; i >= 1; i--) {
		var x = (74 - i) / 74, spike = i < 30 && i > 18;
		s.push({ t: now - i * 2000,
			rx: Math.max(0, 6e6 + 5e6 * Math.sin(x * 6) + 4e6 * Math.random() + (spike ? 24e6 : 0)),
			tx: Math.max(0, 9e5 + 4e5 * Math.sin(x * 9 + 1) + 3e5 * Math.random() + (spike ? 2.2e6 : 0)) });
		c.push(Math.round(3 + 10 * Math.random() + (spike ? 20 : 0)));
	}
	try { sessionStorage.setItem('fp-dash-v1', JSON.stringify({ saved: now, samples: s, cpu: c, last: null, lastCpu: null })); } catch (e) {}
})();

/* Demo navigation: only the dashboard is live. Other pages explain themselves. */
(function() {
	var toast, timer;
	function say(html) {
		if (!toast) {
			toast = document.createElement('div');
			toast.className = 'demo-toast';
			toast.setAttribute('role', 'status');
			document.body.appendChild(toast);
		}
		toast.innerHTML = html;
		toast.classList.add('show');
		clearTimeout(timer);
		timer = setTimeout(function() { toast.classList.remove('show'); }, 4200);
	}
	function route(path) {
		if (!path || path == DEMO_HOME) return false;
		if (path == 'admin/logout') { location.href = 'login.html'; return true; }
		document.body.classList.remove('fp-drawer-open');
		var scrim = document.getElementById('fp-scrim'); if (scrim) scrim.hidden = true;
		var name = path.split('/').pop().replace(/[-_]/g, ' ');
		say('<strong>“' + name.charAt(0).toUpperCase() + name.slice(1) + '” is a stock LuCI page.</strong> ' +
			'Only the dashboard runs in this demo. On your router, every LuCI page gets the Faceplate look.');
		return true;
	}
	document.addEventListener('click', function(ev) {
		var a = ev.target.closest && ev.target.closest('a[href^="#page="]');
		if (a && route(a.getAttribute('href').slice(6))) ev.preventDefault();
	}, true);
	window.addEventListener('hashchange', function() {
		var m = location.hash.match(/^#page=(.+)$/);
		if (m && route(m[1])) history.replaceState(null, '', location.pathname);
	});
})();
