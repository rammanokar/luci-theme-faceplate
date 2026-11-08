'use strict';
'require view';
'require rpc';
'require fs';
'require poll';

/*
 * Faceplate dashboard — live router overview rendered client-side.
 * Polls lightweight ubus calls, samples WAN counters every 2 s and keeps a
 * short rolling history in sessionStorage so the graph survives navigation.
 * All device-supplied strings (hostnames, SSIDs) go through textContent.
 */

const TICK = 2;              /* seconds between fast samples */
const WINDOW = 150;          /* seconds of history kept for graphs */
const SLOW_EVERY = 5;        /* slow data (leases, Wi-Fi) every N ticks */
const STORE_KEY = 'fp-dash-v1';

const callDevStatus = rpc.declare({ object: 'network.device', method: 'status', expect: { '': {} } });
const callIfDump    = rpc.declare({ object: 'network.interface', method: 'dump', expect: { 'interface': [] } });
const callSysInfo   = rpc.declare({ object: 'system', method: 'info' });
const callBoard     = rpc.declare({ object: 'system', method: 'board' });
const callPorts     = rpc.declare({ object: 'luci', method: 'getBuiltinEthernetPorts', expect: { result: [] } });
const callLeases    = rpc.declare({ object: 'luci-rpc', method: 'getDHCPLeases', expect: { '': {} } });
const callWifi      = rpc.declare({ object: 'luci-rpc', method: 'getWirelessDevices', expect: { '': {} } });
const callHints     = rpc.declare({ object: 'luci-rpc', method: 'getHostHints', expect: { '': {} } });
const callAssoc     = rpc.declare({ object: 'iwinfo', method: 'assoclist', params: [ 'device' ], expect: { results: [] } });
const callScan      = rpc.declare({ object: 'iwinfo', method: 'scan', params: [ 'device' ], expect: { results: [] } });
const callFreqs     = rpc.declare({ object: 'iwinfo', method: 'freqlist', params: [ 'device' ], expect: { results: [] } });
const callAudit     = rpc.declare({ object: 'faceplate', method: 'audit', expect: { '': {} } });

const SEVERITY = {
	critical:   { rank: 0, label: 'Critical' },
	warning:    { rank: 1, label: 'Warning' },
	suggestion: { rank: 2, label: 'Suggestion' }
};

const soft = (p) => Promise.resolve(p).catch(() => null);
const readNum = (path) => soft(fs.read(path)).then((s) => s != null ? +String(s).trim() : null);

/* ---------------------------------------------------------------- helpers */

function h(tag, cls, text) {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text != null) n.textContent = text;
	return n;
}

function svgEl(tag, attrs) {
	const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
	return n;
}

/* Material Symbols Rounded, painted by CSS (.fp-i-*) via mask */
const ICON = {
	down: 'arrow_downward', up: 'arrow_upward', copy: 'content_copy', check: 'check', done: 'check_circle',
	wifi: 'wifi', wire: 'cable', reboot: 'restart_alt', backup: 'backup', pkg: 'deployed_code',
	log: 'receipt_long', search: 'search', arrow: 'arrow_forward', table: 'table',
	critical: 'error', warning: 'warning', suggestion: 'lightbulb', shield: 'verified_user', radar: 'radar'
};

function icon(name, cls) {
	const n = h('span', 'fp-ico fp-i-' + (ICON[name] || name).replace(/_/g, '-') + (cls ? ' ' + cls : ''));
	n.setAttribute('aria-hidden', 'true');
	return n;
}

function fmtRate(bps) {
	if (bps == null || isNaN(bps)) return [ '–', '' ];
	const u = [ 'bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s' ];
	let i = 0;
	while (bps >= 1000 && i < u.length - 1) { bps /= 1000; i++; }
	return [ bps >= 100 || i == 0 ? bps.toFixed(0) : bps.toFixed(1), u[i] ];
}
const rateStr = (bps) => fmtRate(bps).join(' ');

function fmtBytes(b) {
	if (b == null) return '–';
	const u = [ 'B', 'KiB', 'MiB', 'GiB', 'TiB' ];
	let i = 0;
	while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
	return (i == 0 ? b.toFixed(0) : b.toFixed(b >= 100 ? 0 : 1)) + ' ' + u[i];
}

function fmtDuration(s) {
	if (s == null || s < 0) return '–';
	s = Math.floor(s);
	const d = Math.floor(s / 86400), hh = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
	if (d) return `${d}d ${hh}h ${m}m`;
	if (hh) return `${hh}h ${m}m`;
	if (m) return `${m}m ${s % 60}s`;
	return `${s}s`;
}

function fmtSpeed(sp) {
	if (!sp) return null;
	const m = String(sp).match(/^(\d+)([FH])?/);
	if (!m) return null;
	const n = +m[1];
	const txt = n >= 1000 ? (n / 1000) + ' Gb/s' : n + ' Mb/s';
	return m[2] == 'H' ? txt + ' half' : txt;
}

function niceMax(v) {
	if (!(v > 0)) return 1000;
	const e = Math.pow(10, Math.floor(Math.log10(v)));
	for (const m of [ 1, 2, 2.5, 5, 10 ])
		if (m * e >= v) return m * e;
	return 10 * e;
}

function bandName(b) {
	return { '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz', '60g': '60 GHz' }[b] || b || '';
}

function signalBars(dbm) {
	if (dbm == null) return 0;
	if (dbm >= -55) return 4;
	if (dbm >= -65) return 3;
	if (dbm >= -75) return 2;
	return 1;
}

function copyText(text, btn) {
	const done = () => {
		btn.classList.add('fp-copied');
		btn.replaceChildren(icon('check'));
		btn.setAttribute('aria-label', _('Copied'));
		setTimeout(() => {
			btn.classList.remove('fp-copied');
			btn.replaceChildren(icon('copy'));
			btn.setAttribute('aria-label', _('Copy'));
		}, 1400);
	};
	if (navigator.clipboard && window.isSecureContext)
		navigator.clipboard.writeText(text).then(done, () => {});
	else {
		const ta = h('textarea');
		ta.value = text;
		document.body.appendChild(ta);
		ta.select();
		try { document.execCommand('copy'); done(); } catch (e) {}
		ta.remove();
	}
}

function copyBtn(getText) {
	const b = h('button', 'fp-copy');
	b.type = 'button';
	b.setAttribute('aria-label', _('Copy'));
	b.title = _('Copy');
	b.appendChild(icon('copy'));
	b.addEventListener('click', (ev) => { ev.stopPropagation(); const t = getText(); if (t) copyText(t, b); });
	return b;
}

/* ------------------------------------------------------- traffic history */

function loadStore() {
	try {
		const s = JSON.parse(sessionStorage.getItem(STORE_KEY));
		if (s && Date.now() - s.saved < 20000) return s;
	} catch (e) {}
	return null;
}

function saveStore(st) {
	try {
		sessionStorage.setItem(STORE_KEY, JSON.stringify({
			saved: Date.now(), samples: st.samples, cpu: st.cpu, last: st.last, lastCpu: st.lastCpu
		}));
	} catch (e) {}
}

/* ------------------------------------------------------------- the chart */

class TrafficChart {
	constructor() {
		this.idx = null;
		this.root = h('div', 'fp-chart');
		this.svg = svgEl('svg', { class: 'fp-chart-svg', role: 'img', tabindex: '0' });
		this.svg.setAttribute('aria-label', _('WAN traffic over the last two minutes. Use the arrow keys to read values.'));
		this.tip = h('div', 'fp-chart-tip');
		this.tip.hidden = true;
		this.root.append(this.svg, this.tip);

		this.svg.addEventListener('pointermove', (ev) => this.hover(ev));
		this.svg.addEventListener('pointerleave', () => this.clearHover());
		this.svg.addEventListener('blur', () => this.clearHover());
		this.svg.addEventListener('keydown', (ev) => this.key(ev));

		if (window.ResizeObserver)
			new ResizeObserver(() => this.draw()).observe(this.root);
	}

	set(samples) { this.samples = samples; this.draw(); }

	geom() {
		const w = Math.max(this.root.clientWidth, 280), hgt = 200;
		return { w, h: hgt, l: 0, r: 0, t: 18, b: 24 };
	}

	draw() {
		const s = this.samples || [];
		const g = this.geom();
		this.g = g;
		const svg = this.svg;
		svg.setAttribute('viewBox', `0 0 ${g.w} ${g.h}`);
		svg.setAttribute('height', g.h);
		svg.replaceChildren();

		const now = s.length ? s[s.length - 1].t : Date.now();
		const t0 = now - WINDOW * 1000;
		const max = niceMax(Math.max(1, ...s.map((p) => Math.max(p.rx, p.tx))) * 1.1);
		this.max = max; this.t0 = t0; this.now = now;

		/* clamp to the window so the plot never crosses the card's content edge */
		const X = (t) => g.l + (Math.max(t, t0) - t0) / (WINDOW * 1000) * (g.w - g.l - g.r);
		const Y = (v) => g.t + (1 - v / max) * (g.h - g.t - g.b);
		this.X = X; this.Y = Y;

		/* grid + y labels */
		const grid = svgEl('g', { class: 'fp-grid' });
		for (let i = 0; i <= 4; i++) {
			const v = max * i / 4, y = Y(v);
			grid.appendChild(svgEl('line', { x1: g.l, x2: g.w - g.r, y1: y, y2: y, class: i == 0 ? 'base' : '' }));
			if (i % 2 == 0) {
				const tx = svgEl('text', { x: g.l, y: y - 6, 'text-anchor': 'start' });
				tx.textContent = i == 0 ? '0' : rateStr(v).replace('bit/s', 'b/s');
				grid.appendChild(tx);
			}
		}
		/* x labels */
		for (const sec of [ 120, 60, 0 ]) {
			const tx = svgEl('text', { x: X(now - sec * 1000), y: g.h - 6, 'text-anchor': sec == 0 ? 'end' : sec == 120 && X(now - sec * 1000) < 40 ? 'start' : 'middle' });
			tx.textContent = sec ? `−${sec / 60} min` : _('now');
			grid.appendChild(tx);
		}
		svg.appendChild(grid);

		if (s.length >= 2) {
			const pts = (k) => s.map((p) => `${X(p.t).toFixed(1)},${Y(p[k]).toFixed(1)}`);
			const rxPts = pts('rx'), txPts = pts('tx');
			const baseY = Y(0).toFixed(1);
			svg.appendChild(svgEl('path', {
				class: 'fp-area-rx',
				d: `M${X(s[0].t).toFixed(1)},${baseY}L${rxPts.join('L')}L${X(s[s.length - 1].t).toFixed(1)},${baseY}Z`
			}));
			svg.appendChild(svgEl('path', { class: 'fp-line-tx', d: 'M' + txPts.join('L') }));
			svg.appendChild(svgEl('path', { class: 'fp-line-rx', d: 'M' + rxPts.join('L') }));
		}
		else {
			const tx = svgEl('text', { x: (g.l + g.w) / 2, y: g.h / 2, 'text-anchor': 'middle', class: 'fp-chart-wait' });
			tx.textContent = _('Measuring traffic…');
			svg.appendChild(tx);
		}

		this.hoverLayer = svgEl('g', { class: 'fp-hover' });
		svg.appendChild(this.hoverLayer);
		if (this.idx != null) this.showIdx(Math.min(this.idx, s.length - 1));
	}

	hover(ev) {
		const s = this.samples || [];
		if (s.length < 2) return;
		const r = this.svg.getBoundingClientRect();
		const x = (ev.clientX - r.left) * (this.g.w / r.width);
		let best = 0, bd = Infinity;
		s.forEach((p, i) => { const d = Math.abs(this.X(p.t) - x); if (d < bd) { bd = d; best = i; } });
		this.showIdx(best);
	}

	key(ev) {
		const s = this.samples || [];
		if (!s.length) return;
		if (ev.key == 'ArrowLeft' || ev.key == 'ArrowRight') {
			ev.preventDefault();
			let i = this.idx == null ? s.length - 1 : this.idx + (ev.key == 'ArrowLeft' ? -1 : 1);
			this.showIdx(Math.max(0, Math.min(s.length - 1, i)));
		}
		else if (ev.key == 'Escape') this.clearHover();
	}

	showIdx(i) {
		const s = this.samples, p = s && s[i];
		if (!p) return;
		this.idx = i;
		const x = this.X(p.t);
		const L = this.hoverLayer;
		L.replaceChildren(
			svgEl('line', { x1: x, x2: x, y1: this.g.t, y2: this.g.h - this.g.b, class: 'fp-cross' }),
			svgEl('circle', { cx: x, cy: this.Y(p.tx), r: 4.5, class: 'fp-dot-tx' }),
			svgEl('circle', { cx: x, cy: this.Y(p.rx), r: 4.5, class: 'fp-dot-rx' })
		);
		const ago = Math.round((this.now - p.t) / 1000);
		const row = (cls, label, v) => {
			const d = h('div', 'fp-tip-row');
			d.append(h('span', 'fp-key ' + cls), h('strong', null, rateStr(v)), h('span', null, label));
			return d;
		};
		this.tip.replaceChildren(
			h('div', 'fp-tip-time', ago <= 1 ? _('Now') : _('%d s ago').format(ago)),
			row('fp-key-rx', _('Download'), p.rx),
			row('fp-key-tx', _('Upload'), p.tx)
		);
		this.tip.hidden = false;
		const r = this.svg.getBoundingClientRect(), scale = r.width / this.g.w;
		const px = x * scale, tw = this.tip.offsetWidth;
		this.tip.style.left = (px + 14 + tw > r.width ? px - 14 - tw : px + 14) + 'px';
		this.tip.style.top = '8px';
	}

	clearHover() {
		this.idx = null;
		if (this.hoverLayer) this.hoverLayer.replaceChildren();
		this.tip.hidden = true;
	}
}

function sparkline(values, max) {
	const w = 120, hgt = 32;
	const s = svgEl('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'fp-spark', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
	if (values.length >= 2) {
		const m = max || Math.max(...values, 1);
		const pts = values.map((v, i) => `${(i / (values.length - 1) * w).toFixed(1)},${(hgt - 2 - v / m * (hgt - 4)).toFixed(1)}`);
		s.appendChild(svgEl('path', { d: `M0,${hgt}L${pts.join('L')}L${w},${hgt}Z`, class: 'fp-spark-area' }));
		s.appendChild(svgEl('path', { d: 'M' + pts.join('L'), class: 'fp-spark-line' }));
	}
	return s;
}

/* ------------------------------------------------------------------ view */

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load() {
		return Promise.all([
			soft(callBoard()),
			soft(callPorts()),
		]);
	},

	render([ board, ports ]) {
		this.board = board || {};
		this.portList = (ports && ports.length) ? ports : null;
		this.tickNo = 0;

		const st = loadStore() || {};
		this.samples = st.samples || [];
		this.cpuHist = st.cpu || [];
		this.last = st.last || null;
		this.lastCpu = st.lastCpu || null;

		const root = h('div', 'fp-dash');
		root.appendChild(h('h2', 'fp-sr', _('Dashboard')));

		root.append(
			this.buildInternet(),
			this.buildTiles(),
			this.buildSecurity(),
			this.buildPorts(),
			this.buildLower()
		);

		/* first data round, then poll; the audit runs once per visit */
		this.refreshFast().then(() => this.refreshSlow()).then(() => this.runAudit());
		poll.add(() => {
			if (document.hidden) return Promise.resolve();
			this.tickNo++;
			return this.refreshFast().then(() => (this.tickNo % SLOW_EVERY == 0) ? this.refreshSlow() : null);
		}, TICK);

		/* ticking clocks between polls */
		this.clock = setInterval(() => this.tickClocks(), 1000);

		return root;
	},

	/* ----------------------------------------------------------- builders */

	buildInternet() {
		const c = h('section', 'fp-card fp-net');
		c.setAttribute('aria-labelledby', 'fp-net-h');

		const head = h('div', 'fp-net-head');
		this.netState = h('div', 'fp-net-state');
		this.netTitle = h('h3', null, _('Internet'));
		this.netTitle.id = 'fp-net-h';
		this.netStatus = h('span', 'fp-pill', _('Checking…'));
		this.netState.append(this.netTitle, this.netStatus);
		this.netSub = h('p', 'fp-net-sub', '');
		head.append(this.netState, this.netSub);

		const rates = h('div', 'fp-rates');
		const mk = (cls, label, ico) => {
			const d = h('div', 'fp-rate ' + cls);
			const lab = h('div', 'fp-rate-label');
			lab.append(h('span', 'fp-key'), icon(ico), h('span', null, label));
			const val = h('div', 'fp-rate-val');
			const num = h('span', 'fp-rate-num', '–'), unit = h('span', 'fp-rate-unit', '');
			val.append(num, unit);
			const tot = h('div', 'fp-rate-total', '');
			d.append(lab, val, tot);
			return { d, num, unit, tot };
		};
		this.rx = mk('fp-rx', _('Download'), 'down');
		this.tx = mk('fp-tx', _('Upload'), 'up');
		rates.append(this.rx.d, this.tx.d);

		this.netFacts = h('dl', 'fp-facts');

		const top = h('div', 'fp-net-top');
		const left = h('div', 'fp-net-left');
		left.append(head, rates);
		top.append(left, this.netFacts);

		this.chart = new TrafficChart();
		const foot = h('div', 'fp-chart-foot');
		foot.append(h('span', null, _('WAN traffic, sampled every %d seconds in this browser').format(TICK)));
		const tbtn = h('button', 'fp-link-btn');
		tbtn.type = 'button';
		tbtn.append(icon('table'), h('span', null, _('Show as table')));
		this.chartTable = h('div', 'fp-chart-table');
		this.chartTable.hidden = true;
		tbtn.addEventListener('click', () => {
			this.chartTable.hidden = !this.chartTable.hidden;
			tbtn.lastChild.textContent = this.chartTable.hidden ? _('Show as table') : _('Hide table');
			this.renderChartTable();
		});
		foot.append(tbtn);

		c.append(top, this.chart.root, foot, this.chartTable);
		return c;
	},

	buildSecurity() {
		const c = h('section', 'fp-card fp-sec');
		const hd = h('div', 'fp-card-head');
		const title = h('div', 'fp-sec-title');
		this.secIcon = h('span', 'fp-sec-badge');
		this.secIcon.appendChild(icon('shield'));
		const tt = h('div');
		tt.append(h('h3', null, _('Security & health')), (this.secSummary = h('p', 'fp-sec-summary', _('Checking your settings…'))));
		title.append(this.secIcon, tt);
		this.secRecheck = h('button', 'fp-link-btn');
		this.secRecheck.type = 'button';
		this.secRecheck.textContent = _('Check again');
		this.secRecheck.addEventListener('click', () => this.runAudit());
		hd.append(title, this.secRecheck);
		this.secList = h('ul', 'fp-findings');
		this.secPassed = h('details', 'fp-passed');
		this.secPassed.hidden = true;
		c.append(hd, this.secList, this.secPassed);
		return c;
	},

	runAudit() {
		this.secRecheck.disabled = true;
		this.secRecheck.classList.add('spinning');
		return soft(callAudit()).then((res) => {
			this.audit = res || null;
			this.auditFailed = !res;
			this.renderSecurity();
		}).finally(() => {
			this.secRecheck.disabled = false;
			this.secRecheck.classList.remove('spinning');
		});
	},

	/* checks that use live data the browser already has */
	clientFindings() {
		const out = [], passed = [];
		const m = this.sys && this.sys.memory;
		if (m) {
			const free = (m.available || m.free) / m.total * 100;
			if (free < 10)
				out.push({ severity: 'warning', title: _('Memory is almost full'), detail: _('Only %d%% of memory is free. The router may restart services or drop connections. Check running processes.').format(Math.round(free)), fix: { label: _('Processes'), path: 'admin/status/processes' } });
			else passed.push(_('Enough free memory (%d%%)').format(Math.round(free)));
		}
		const root = this.sys && this.sys.root;
		if (root && root.total) {
			const used = root.used / root.total * 100;
			if (used > 90)
				out.push({ severity: 'warning', title: _('Storage is almost full'), detail: _('%d%% of the settings storage is used. Saving settings or installing software may fail.').format(Math.round(used)), fix: { label: _('Software'), path: 'admin/system/package-manager' } });
			else passed.push(_('Plenty of free storage'));
		}
		if (this.ct != null && this.ctMax) {
			const pct = this.ct / this.ctMax * 100;
			if (pct > 80)
				out.push({ severity: 'warning', title: _('Connection table is nearly full'), detail: _('%d of %d tracked connections are in use. New connections may fail; a device may be misbehaving.').format(this.ct, this.ctMax), fix: { label: _('Connections'), path: 'admin/status/realtime/connections' } });
		}
		/* background noise per radio, from live iwinfo data */
		for (const r of Object.keys(this.wifi || {}).sort()) {
			const radio = this.wifi[r];
			const iw = ((radio.interfaces || []).find((i) => i.iwinfo && i.iwinfo.noise) || {}).iwinfo;
			if (!radio.up || !iw) continue;
			const name = bandName(radio.config && radio.config.band);
			if (iw.noise > -80)
				out.push({ severity: 'warning', title: _('High interference on %s').format(name), detail: _('Background noise is %d dBm (below -85 dBm is good). Microwaves, baby monitors, Bluetooth or crowded neighbours can cause this. Run “Check for interference” and try a quieter channel.').format(iw.noise), fix: { label: _('Wi-Fi settings'), path: 'admin/network/wireless' } });
			else
				passed.push(_('%s background noise is low (%d dBm)').format(name, iw.noise));
		}
		const weak = (this.lastDevices || []).filter((d) => d.wifi && d.wifi.signal != null && d.wifi.signal < -75);
		if (weak.length)
			out.push({
				severity: 'suggestion',
				title: weak.length == 1 ? _('1 device has a weak Wi-Fi signal') : _('%d devices have a weak Wi-Fi signal').format(weak.length),
				detail: _('%s. Weak signal means slow speeds and dropouts. Move the router higher and more central, or add an access point.').format(weak.map((d) => `${d.name || d.mac} (${d.wifi.signal} dBm)`).join(', '))
			});
		else if (this.lastDevices) passed.push(_('All Wi-Fi devices have a usable signal'));
		return { out, passed };
	},

	renderSecurity() {
		if (!this.secList) return;
		const cf = this.clientFindings();
		const server = (this.audit && this.audit.findings) || [];
		const all = server.concat(cf.out).sort((a, b) => (SEVERITY[a.severity] || SEVERITY.suggestion).rank - (SEVERITY[b.severity] || SEVERITY.suggestion).rank);
		const passed = ((this.audit && this.audit.passed) || []).concat(cf.passed);

		const n = (sev) => all.filter((f) => f.severity == sev).length;
		const crit = n('critical'), warn = n('warning'), sug = n('suggestion');
		const parts = [];
		if (crit) parts.push(crit == 1 ? _('1 critical issue') : _('%d critical issues').format(crit));
		if (warn) parts.push(warn == 1 ? _('1 warning') : _('%d warnings').format(warn));
		if (sug) parts.push(sug == 1 ? _('1 suggestion') : _('%d suggestions').format(sug));
		if (passed.length) parts.push(_('%d checks passed').format(passed.length));

		this.secSummary.textContent = this.auditFailed && !this.audit
			? _('The router could not run its security checks. Showing live checks only.')
			: (crit + warn + sug == 0 ? _('No problems found. ') : '') + parts.join(' · ');
		this.secIcon.className = 'fp-sec-badge ' + (crit ? 'is-critical' : warn ? 'is-warning' : 'is-ok');
		this.secIcon.replaceChildren(icon(crit ? 'critical' : warn ? 'warning' : 'shield'));

		try { localStorage.setItem('fp-audit', JSON.stringify({ crit, warn, t: Date.now() })); } catch (e) {}
		const navBadge = document.querySelector('#fp-alert-badge');
		if (navBadge) { navBadge.textContent = String(crit + warn); navBadge.hidden = !(crit + warn); navBadge.className = 'fp-badge' + (crit ? ' is-critical' : ''); }

		const frag = document.createDocumentFragment();
		all.forEach((f) => {
			const sev = SEVERITY[f.severity] ? f.severity : 'suggestion';
			const li = h('li', 'fp-finding is-' + sev);
			const ic = h('span', 'fp-finding-ic');
			ic.appendChild(icon(sev));
			const body = h('div', 'fp-finding-body');
			const head = h('div', 'fp-finding-head');
			head.append(h('span', 'fp-sev', _(SEVERITY[sev].label)), h('strong', null, f.title));
			body.append(head, h('p', null, f.detail));
			li.append(ic, body);
			if (f.fix && f.fix.path) {
				const a = h('a', 'btn fp-fix');
				a.href = L.url.apply(L, f.fix.path.split('/'));
				a.textContent = f.fix.label;
				li.appendChild(a);
			}
			frag.appendChild(li);
		});
		this.secList.replaceChildren(frag);
		this.secList.hidden = !all.length;

		this.secPassed.replaceChildren();
		if (passed.length) {
			const sum = h('summary', null, _('Show %d passed checks').format(passed.length));
			const ul = h('ul', 'fp-passed-list');
			passed.forEach((t) => { const li = h('li'); li.append(icon('done'), h('span', null, t)); ul.appendChild(li); });
			this.secPassed.append(sum, ul);
		}
		this.secPassed.hidden = !passed.length;
	},

	buildTiles() {
		const g = h('div', 'fp-tiles');
		const tile = (label, href) => {
			const t = h(href ? 'a' : 'div', 'fp-tile');
			if (href) t.href = L.url(href);
			const top = h('div', 'fp-tile-label', label);
			const val = h('div', 'fp-tile-val', '–');
			const sub = h('div', 'fp-tile-sub', '');
			const viz = h('div', 'fp-tile-viz');
			t.append(top, val, sub, viz);
			g.appendChild(t);
			return { t, val, sub, viz };
		};
		this.tDevices = tile(_('Devices'), 'admin/network/dhcp');
		this.tCpu = tile(_('Processor'), 'admin/status/processes');
		this.tMem = tile(_('Memory'), null);
		this.tConn = tile(_('Connections'), 'admin/status/realtime/connections');
		return g;
	},

	buildPorts() {
		const c = h('section', 'fp-card fp-ports-card');
		const hd = h('div', 'fp-card-head');
		hd.append(h('h3', null, _('Ports')), this.linkTo(_('Interfaces'), 'admin/network/network'));
		this.portsWrap = h('div', 'fp-ports');
		c.append(hd, this.portsWrap);
		return c;
	},

	buildLower() {
		const g = h('div', 'fp-lower');

		/* devices */
		const dev = h('section', 'fp-card fp-devices');
		const dh = h('div', 'fp-card-head');
		this.devCount = h('span', 'fp-count', '');
		const t = h('h3', null, _('Connected devices'));
		t.appendChild(this.devCount);
		this.devFilter = h('input', 'fp-filter');
		this.devFilter.type = 'search';
		this.devFilter.placeholder = _('Filter by name, IP or MAC');
		this.devFilter.setAttribute('aria-label', _('Filter devices'));
		this.devFilter.addEventListener('input', () => this.renderDevices());
		dh.append(t, this.devFilter);
		this.devBody = h('div', 'fp-dev-list');
		this.devSort = 'name';
		dev.append(dh, this.devBody);

		/* right column */
		const side = h('div', 'fp-side');

		const wifi = h('section', 'fp-card fp-wifi');
		const wh = h('div', 'fp-card-head');
		wh.append(h('h3', null, _('Wi-Fi')), this.linkTo(_('Settings'), 'admin/network/wireless'));
		this.wifiBody = h('div', 'fp-wifi-list');
		const scanBtn = h('button', 'btn fp-scan-btn');
		scanBtn.type = 'button';
		scanBtn.append(icon('radar'), h('span', null, _('Check for interference')));
		scanBtn.addEventListener('click', () => this.runScan(scanBtn));
		this.scanBox = h('div', 'fp-scan');
		this.scanBox.setAttribute('aria-live', 'polite');
		wifi.append(wh, this.wifiBody, scanBtn, this.scanBox);

		const sys = h('section', 'fp-card fp-sys');
		const sh = h('div', 'fp-card-head');
		sh.append(h('h3', null, _('System')), this.linkTo(_('Details'), 'admin/status/overview'));
		this.sysFacts = h('dl', 'fp-facts fp-facts-sys');
		const b = this.board;
		this.sysClock = this.fact(this.sysFacts, _('Local time'), '–');
		this.sysUptime = this.fact(this.sysFacts, _('Uptime'), '–');
		this.sysLoad = this.fact(this.sysFacts, _('Load average'), '–');
		this.fact(this.sysFacts, _('Model'), b.model || '–');
		this.fact(this.sysFacts, _('Firmware'), (b.release && b.release.description) || '–');
		this.fact(this.sysFacts, _('Kernel'), b.kernel || '–');
		this.sysStore = this.fact(this.sysFacts, _('Storage'), '–');

		const acts = h('div', 'fp-actions');
		[
			[ _('Reboot'), 'admin/system/reboot', 'reboot' ],
			[ _('Backup'), 'admin/system/flash', 'backup' ],
			[ _('Software'), 'admin/system/package-manager', 'pkg' ],
			[ _('System log'), 'admin/status/logs/syslog', 'log' ]
		].forEach(([ label, path, ic ]) => {
			const a = h('a', 'fp-action');
			a.href = L.url(path);
			a.append(icon(ic), h('span', null, label));
			acts.appendChild(a);
		});
		sys.append(sh, this.sysFacts, acts);

		side.append(wifi, sys);
		g.append(dev, side);
		return g;
	},

	linkTo(label, path) {
		const a = h('a', 'fp-card-link');
		a.href = L.url(path);
		a.append(h('span', null, label), icon('arrow'));
		return a;
	},

	fact(dl, label, value) {
		const wrap = h('div');
		const dd = h('dd', null, value);
		wrap.append(h('dt', null, label), dd);
		dl.appendChild(wrap);
		return dd;
	},

	/* ------------------------------------------------------------ polling */

	refreshFast() {
		return Promise.all([
			soft(callDevStatus()),
			soft(callIfDump()),
			soft(callSysInfo()),
			soft(fs.read('/proc/stat')),
			readNum('/proc/sys/net/netfilter/nf_conntrack_count'),
			readNum('/proc/sys/net/netfilter/nf_conntrack_max')
		]).then(([ devs, ifaces, sys, stat, ctCount, ctMax ]) => {
			this.devs = devs || {};
			this.ifaces = ifaces || [];
			this.sys = sys;
			this.sysAt = Date.now();

			this.sampleTraffic();
			this.sampleCpu(stat);
			this.renderInternet();
			this.renderPorts();
			this.renderTiles(ctCount, ctMax);
			this.tickClocks();
			saveStore(this);
		});
	},

	refreshSlow() {
		return Promise.all([
			soft(callLeases()),
			soft(callWifi()),
			soft(callHints())
		]).then(([ leases, wifi, hints ]) => {
			const ifnames = [];
			for (const r in (wifi || {}))
				for (const i of (wifi[r].interfaces || []))
					if (i.ifname) ifnames.push(i.ifname);

			return Promise.all(ifnames.map((n) => soft(callAssoc(n)).then((l) => [ n, l || [] ])))
				.then((assoc) => {
					this.leases = (leases && leases.dhcp_leases) || [];
					this.wifi = wifi || {};
					this.hints = hints || {};
					this.assoc = Object.fromEntries(assoc);
					this.renderWifi();
					this.renderDevices();
				});
		});
	},

	wanIface() {
		const up = this.ifaces.filter((i) => i.up && i.route && i.route.some((r) => r.target == '0.0.0.0' && r.mask == 0));
		return up[0] || this.ifaces.find((i) => i.interface == 'wan') || null;
	},

	sampleTraffic() {
		const wan = this.wanIface();
		const dev = wan && (wan.l3_device || wan.device);
		const st = dev && this.devs[dev] && this.devs[dev].statistics;
		if (!st) return;
		const now = Date.now();
		const cur = { t: now, dev, rx: st.rx_bytes, tx: st.tx_bytes };
		const prev = this.last;

		if (prev && prev.dev == dev && now > prev.t && cur.rx >= prev.rx && cur.tx >= prev.tx) {
			const dt = (now - prev.t) / 1000;
			if (dt < 30)
				this.samples.push({ t: now, rx: (cur.rx - prev.rx) * 8 / dt, tx: (cur.tx - prev.tx) * 8 / dt });
		}
		this.last = cur;
		this.totals = { rx: st.rx_bytes, tx: st.tx_bytes };
		const cut = now - WINDOW * 1000 - 3000;
		this.samples = this.samples.filter((p) => p.t >= cut);

		/* per-port rates for the port strip */
		this.portRates = this.portRates || {};
		this.portPrev = this.portPrev || {};
		for (const name in this.devs) {
			const s = this.devs[name].statistics, p = this.portPrev[name];
			if (!s) continue;
			if (p && now > p.t) {
				const dt = (now - p.t) / 1000;
				this.portRates[name] = { rx: Math.max(0, (s.rx_bytes - p.rx) * 8 / dt), tx: Math.max(0, (s.tx_bytes - p.tx) * 8 / dt) };
			}
			this.portPrev[name] = { t: now, rx: s.rx_bytes, tx: s.tx_bytes };
		}
	},

	sampleCpu(stat) {
		const m = stat && String(stat).match(/^cpu\s+(.+)$/m);
		if (!m) return;
		const v = m[1].trim().split(/\s+/).map(Number);
		const idle = v[3] + (v[4] || 0), total = v.reduce((a, b) => a + b, 0);
		const p = this.lastCpu;
		if (p && total > p.total) {
			const pct = Math.max(0, Math.min(100, 100 * (1 - (idle - p.idle) / (total - p.total))));
			this.cpuHist.push(Math.round(pct * 10) / 10);
			if (this.cpuHist.length > WINDOW / TICK) this.cpuHist.shift();
		}
		this.lastCpu = { idle, total };
	},

	/* ----------------------------------------------------------- renderers */

	renderInternet() {
		const wan = this.wanIface();
		const online = !!(wan && wan.up && (wan['ipv4-address'] || []).length);
		const pending = wan && wan.pending;

		this.netStatus.className = 'fp-pill fp-pill-dot ' + (online ? 'fp-pill-ok' : pending ? 'fp-pill-warn' : 'fp-pill-bad');
		this.netStatus.textContent = online ? _('Online') : pending ? _('Connecting') : _('Offline');

		if (wan) {
			const proto = { dhcp: 'DHCP', pppoe: 'PPPoE', static: _('Static address'), dhcpv6: 'DHCPv6' }[wan.proto] || wan.proto;
			this.netSub.textContent = online
				? _('Connected for %s via %s on %s').format(fmtDuration(wan.uptime), proto, wan.l3_device || wan.device || wan.interface)
				: _('The %s interface has no address. Check the cable or your provider.').format(wan.interface);
		}
		else
			this.netSub.textContent = _('No interface with a default route was found.');

		/* facts */
		const v4 = wan && (wan['ipv4-address'] || [])[0];
		const v6if = this.ifaces.find((i) => i.up && (i['ipv6-address'] || []).length && i.interface != 'loopback' && i.interface != 'lan');
		const v6 = v6if && v6if['ipv6-address'][0];
		const gw = wan && (wan.route || []).find((r) => r.target == '0.0.0.0');
		const dns = wan ? (wan['dns-server'] || []) : [];

		const key = JSON.stringify([ v4, v6, gw && gw.nexthop, dns ]);
		if (key != this.factsKey) {
			this.factsKey = key;
			this.netFacts.replaceChildren();
			const add = (label, value, copy) => {
				const wrap = h('div');
				const dd = h('dd', null, value || '–');
				if (copy && value) dd.appendChild(copyBtn(() => value));
				wrap.append(h('dt', null, label), dd);
				this.netFacts.appendChild(wrap);
			};
			add(_('WAN address'), v4 ? `${v4.address}/${v4.mask}` : null, true);
			if (v6) add(_('IPv6 address'), `${v6.address}/${v6.mask}`, true);
			add(_('Gateway'), gw && gw.nexthop, false);
			add(_('DNS servers'), dns.join(', '), false);
		}

		/* rates */
		const s = this.samples, cur = s[s.length - 1];
		const setRate = (o, v, total) => {
			const [ n, u ] = fmtRate(cur ? v : null);
			o.num.textContent = n;
			o.unit.textContent = u;
			o.tot.textContent = total != null ? _('%s since boot').format(fmtBytes(total)) : '';
		};
		setRate(this.rx, cur && cur.rx, this.totals && this.totals.rx);
		setRate(this.tx, cur && cur.tx, this.totals && this.totals.tx);

		this.chart.set(s);
		if (!this.chartTable.hidden) this.renderChartTable();
	},

	renderChartTable() {
		if (this.chartTable.hidden) return;
		const tbl = h('table', 'table');
		const hr = h('tr', 'tr table-titles');
		[ _('Time'), _('Download'), _('Upload') ].forEach((t) => hr.appendChild(h('th', 'th', t)));
		tbl.appendChild(hr);
		const s = this.samples.slice(-15).reverse();
		const now = Date.now();
		s.forEach((p) => {
			const tr = h('tr', 'tr');
			tr.append(
				h('td', 'td', _('%d s ago').format(Math.round((now - p.t) / 1000))),
				h('td', 'td', rateStr(p.rx)),
				h('td', 'td', rateStr(p.tx))
			);
			tbl.appendChild(tr);
		});
		this.chartTable.replaceChildren(tbl);
	},

	renderTiles(ctCount, ctMax) {
		this.ct = ctCount;
		this.ctMax = ctMax;
		/* CPU */
		const cpu = this.cpuHist[this.cpuHist.length - 1];
		this.tCpu.val.textContent = cpu != null ? `${Math.round(cpu)} %` : '–';
		if (this.sys && this.sys.load)
			this.tCpu.sub.textContent = _('Load %s').format(this.sys.load.map((l) => (l / 65536).toFixed(2)).join(' · '));
		this.tCpu.viz.replaceChildren(sparkline(this.cpuHist, 100));

		/* memory */
		const m = this.sys && this.sys.memory;
		if (m) {
			const used = m.total - (m.available || (m.free + (m.buffered || 0) + (m.cached || 0)));
			const pct = Math.round(used / m.total * 100);
			this.tMem.val.textContent = `${pct} %`;
			this.tMem.sub.textContent = _('%s of %s in use').format(fmtBytes(used), fmtBytes(m.total));
			this.meter(this.tMem.viz, pct);
		}

		/* connections */
		if (ctCount != null) {
			this.tConn.val.textContent = ctCount.toLocaleString();
			this.tConn.sub.textContent = ctMax ? _('of %s tracked').format(ctMax.toLocaleString()) : _('tracked');
			this.meter(this.tConn.viz, ctMax ? ctCount / ctMax * 100 : 0);
		}
	},

	meter(host, pct) {
		let bar = host.querySelector('.fp-meter');
		if (!bar) {
			bar = h('div', 'fp-meter');
			bar.appendChild(h('div'));
			host.replaceChildren(bar);
		}
		bar.firstChild.style.width = Math.max(1, Math.min(100, pct)) + '%';
		bar.classList.toggle('fp-meter-hot', pct >= 85);
	},

	renderPorts() {
		const list = this.portList || [ 'wan', 'lan1', 'lan2', 'lan3', 'lan4' ]
			.filter((n) => this.devs[n]).map((n) => ({ device: n, role: n == 'wan' ? 'wan' : 'lan' }));
		if (!list.length) { this.portsWrap.closest('.fp-card').hidden = true; return; }

		/* WAN first, then LAN in order — like the back of the router */
		const ordered = list.slice().sort((a, b) => (a.role == 'wan' ? -1 : 0) - (b.role == 'wan' ? -1 : 0));
		if (!this.portEls) {
			this.portEls = {};
			ordered.forEach((p) => {
				const el = h('div', 'fp-port' + (p.role == 'wan' ? ' fp-port-wan' : ''));
				const sock = h('div', 'fp-socket');
				sock.append(h('span', 'fp-led'), h('span', 'fp-socket-hole'));
				const name = h('div', 'fp-port-name', p.role == 'wan' ? 'WAN' : p.device.replace(/^lan(\d+)$/i, 'LAN $1'));
				const speed = h('div', 'fp-port-speed', '');
				const rate = h('div', 'fp-port-rate', '');
				el.append(sock, name, speed, rate);
				this.portsWrap.appendChild(el);
				this.portEls[p.device] = { el, speed, rate };
			});
		}
		ordered.forEach((p) => {
			const d = this.devs[p.device] || {}, e = this.portEls[p.device];
			if (!e) return;
			const up = !!d.carrier;
			e.el.classList.toggle('fp-port-up', up);
			e.speed.textContent = up ? (fmtSpeed(d.speed) || _('Connected')) : _('No cable');
			const r = this.portRates && this.portRates[p.device];
			e.rate.textContent = up && r ? `↓ ${rateStr(p.role == 'wan' ? r.rx : r.tx)}  ↑ ${rateStr(p.role == 'wan' ? r.tx : r.rx)}` : '';
			e.el.title = up && d.statistics
				? _('%s received, %s sent since boot').format(fmtBytes(d.statistics.rx_bytes), fmtBytes(d.statistics.tx_bytes))
				: '';
		});
	},

	collectDevices() {
		const byMac = {};
		const hints = this.hints || {};
		const get = (mac) => {
			mac = String(mac).toUpperCase();
			return byMac[mac] || (byMac[mac] = { mac, name: null, ip: null, wifi: null, expires: null });
		};

		(this.leases || []).forEach((l) => {
			if (!l.macaddr) return;
			const d = get(l.macaddr);
			d.name = l.hostname || d.name;
			d.ip = l.ipaddr || d.ip;
			d.expires = l.expires;
		});

		for (const r in this.wifi) {
			const radio = this.wifi[r];
			for (const i of (radio.interfaces || [])) {
				const ssid = (i.iwinfo && i.iwinfo.ssid) || (i.config && i.config.ssid) || '';
				for (const s of ((this.assoc || {})[i.ifname] || [])) {
					const d = get(s.mac);
					d.wifi = { band: bandName(radio.config && radio.config.band), ssid, signal: s.signal, rate: s.rx && s.rx.rate, time: s.connected_time };
				}
			}
		}

		Object.values(byMac).forEach((d) => {
			const hh = hints[d.mac];
			if (hh) {
				d.name = d.name || hh.name || null;
				d.ip = d.ip || (hh.ipaddrs && hh.ipaddrs[0]) || null;
			}
		});
		return Object.values(byMac);
	},

	renderDevices() {
		const all = this.collectDevices();
		const wifiN = all.filter((d) => d.wifi).length;
		const firstRun = !this.lastDevices;
		this.lastDevices = all;
		if (firstRun && this.audit) this.renderSecurity();

		this.devCount.textContent = String(all.length);
		this.tDevices.val.textContent = String(all.length);
		this.tDevices.sub.textContent = _('%d on Wi-Fi · %d with a DHCP lease').format(wifiN, all.filter((d) => d.expires != null).length);
		this.meter(this.tDevices.viz, all.length ? wifiN / all.length * 100 : 0);

		const q = (this.devFilter.value || '').trim().toLowerCase();
		const ipNum = (ip) => (ip || '').split('.').reduce((a, b) => a * 256 + (+b || 0), 0);
		const rows = all
			.filter((d) => !q || [ d.name, d.ip, d.mac ].some((v) => v && v.toLowerCase().includes(q)))
			.sort((a, b) => (b.wifi ? 1 : 0) - (a.wifi ? 1 : 0) || ipNum(a.ip) - ipNum(b.ip));

		const frag = document.createDocumentFragment();
		if (!rows.length) {
			frag.appendChild(h('p', 'fp-empty', q ? _('No device matches “%s”.').format(q) : _('No devices yet. Devices appear here once they get an address from the router.')));
		}
		rows.forEach((d) => {
			const row = h('div', 'fp-dev');
			const ic = h('div', 'fp-dev-ic' + (d.wifi ? ' is-wifi' : ''));
			ic.appendChild(icon(d.wifi ? 'wifi' : 'wire'));

			const main = h('div', 'fp-dev-main');
			main.append(h('div', 'fp-dev-name' + (d.name ? '' : ' is-unknown'), d.name || _('Unnamed device')), h('div', 'fp-dev-mac', d.mac));

			const ip = h('div', 'fp-dev-ip');
			if (d.ip) { ip.append(h('span', null, d.ip), copyBtn(() => d.ip)); }
			else ip.textContent = '–';

			const conn = h('div', 'fp-dev-conn');
			if (d.wifi) {
				const bars = h('span', 'fp-bars fp-bars-' + signalBars(d.wifi.signal));
				bars.setAttribute('aria-hidden', 'true');
				for (let i = 0; i < 4; i++) bars.appendChild(h('i'));
				const txt = h('span', null, `${d.wifi.band || _('Wi-Fi')} · ${d.wifi.signal} dBm`);
				conn.append(bars, txt);
				conn.title = _('Connected to %s for %s').format(d.wifi.ssid, fmtDuration(d.wifi.time));
			}
			else
				conn.append(h('span', 'fp-muted', d.expires != null ? _('Wired or idle') : _('Wired')));

			const lease = h('div', 'fp-dev-lease', d.expires != null ? (d.expires > 0 ? _('Lease %s').format(fmtDuration(d.expires)) : _('Static lease')) : '');

			row.append(ic, main, ip, conn, lease);
			frag.appendChild(row);
		});
		this.devBody.replaceChildren(frag);
	},

	renderWifi() {
		const frag = document.createDocumentFragment();
		let any = false;
		for (const r of Object.keys(this.wifi).sort()) {
			const radio = this.wifi[r];
			for (const i of (radio.interfaces || [])) {
				any = true;
				const iw = i.iwinfo || {};
				const up = radio.up && !radio.disabled && !(i.config && i.config.disabled);
				const n = ((this.assoc || {})[i.ifname] || []).length;

				const card = h('div', 'fp-ssid' + (up ? '' : ' is-off'));
				const top = h('div', 'fp-ssid-top');
				const led = h('span', 'fp-led ' + (up ? 'fp-led-ok' : ''));
				top.append(led, h('strong', 'fp-ssid-name', iw.ssid || (i.config && i.config.ssid) || '?'), h('span', 'fp-pill', bandName(radio.config && radio.config.band)));
				const meta = h('div', 'fp-ssid-meta');
				meta.append(
					h('span', null, up ? _('Channel %s').format(iw.channel || (radio.config && radio.config.channel) || '?') : _('Disabled')),
					h('span', null, n == 1 ? _('1 client') : _('%d clients').format(n))
				);
				if (up && iw.txpower != null) meta.appendChild(h('span', null, `${iw.txpower} dBm`));
				card.append(top, meta);
				frag.appendChild(card);
			}
		}
		if (!any) frag.appendChild(h('p', 'fp-empty', _('No wireless networks are configured.')));
		this.wifiBody.replaceChildren(frag);
	},

	runScan(btn) {
		const radios = [];
		for (const r of Object.keys(this.wifi || {}).sort()) {
			const radio = this.wifi[r];
			const ap = (radio.interfaces || []).find((i) => i.ifname && (!i.config || (i.config.mode || 'ap') == 'ap'));
			if (radio.up && ap) radios.push({ r, radio, ifname: ap.ifname, channel: ap.iwinfo && ap.iwinfo.channel });
		}
		if (!radios.length) return;
		btn.disabled = true;
		btn.classList.add('spinning');
		btn.lastChild.textContent = _('Scanning nearby networks…');
		/* scan radios one after another so only one is off-channel at a time */
		let chain = Promise.resolve(), results = [];
		radios.forEach((x) => {
			chain = chain.then(() => Promise.all([ soft(callScan(x.ifname)), soft(callFreqs(x.ifname)) ]))
				.then(([ list, freqs ]) => results.push(Object.assign({
					aps: list || [],
					allowed: freqs && freqs.length ? new Set(freqs.filter((f) => !f.restricted).map((f) => f.channel)) : null
				}, x)));
		});
		chain.then(() => {
			this.scanBox.replaceChildren(...results.map((x) => this.renderScan(x)));
		}).finally(() => {
			btn.disabled = false;
			btn.classList.remove('spinning');
			btn.lastChild.textContent = _('Scan again');
		});
	},

	renderScan(x) {
		const band = x.radio.config && x.radio.config.band;
		const own = new Set(Object.values(this.wifi).flatMap((r) => (r.interfaces || []).map((i) => i.iwinfo && i.iwinfo.bssid)).filter(Boolean).map((b) => b.toUpperCase()));
		const aps = x.aps.filter((a) => a.channel && !own.has(String(a.bssid).toUpperCase()));
		const cur = x.channel;
		const box = h('div', 'fp-scan-band');
		const head = h('div', 'fp-scan-head');
		head.append(h('strong', null, bandName(band)), h('span', null, _('%d networks nearby').format(aps.length)));
		box.appendChild(head);

		let channels, score, candidates;
		if (band == '2g') {
			channels = [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13 ];
			/* overlapping networks within ±4 channels count, nearer and stronger count more */
			score = (c) => aps.reduce((s, a) => {
				const d = Math.abs(a.channel - c);
				if (d > 4) return s;
				return s + (1 - d / 5) * (a.signal > -60 ? 3 : a.signal > -75 ? 2 : 1);
			}, 0);
			candidates = [ 1, 6, 11 ];
		}
		else {
			const seen = new Set(aps.map((a) => a.channel));
			if (cur) seen.add(cur);
			channels = Array.from(seen).sort((a, b) => a - b);
			const block = (c) => c >= 149 ? Math.floor((c - 149) / 16) + 100 : Math.floor((c - 36) / 16);
			score = (c) => aps.reduce((s, a) => s + (block(a.channel) == block(c) ? (a.signal > -60 ? 3 : a.signal > -75 ? 2 : 1) : 0), 0);
			candidates = [ 36, 149 ];
		}
		/* only suggest channels this radio may use in its country */
		if (x.allowed) candidates = candidates.filter((c) => x.allowed.has(c) || c == cur);
		if (!candidates.length) candidates = [ cur ];
		if (band != '2g') {
			candidates.forEach((c) => { if (channels.indexOf(c) < 0) channels.push(c); });
			channels.sort((a, b) => a - b);
		}

		/* column chart: networks per channel */
		const counts = {};
		aps.forEach((a) => { counts[a.channel] = (counts[a.channel] || []).concat(a); });
		const max = Math.max(1, ...channels.map((c) => (counts[c] || []).length));
		const best = candidates.slice().sort((a, b) => score(a) - score(b))[0];
		const chart = h('div', 'fp-chan');
		chart.setAttribute('role', 'img');
		chart.setAttribute('aria-label', _('Nearby networks per channel'));
		channels.forEach((c) => {
			const list = counts[c] || [];
			const col = h('div', 'fp-chan-col' + (c == cur ? ' is-current' : '') + (c == best && c != cur ? ' is-best' : ''));
			col.title = list.length
				? _('Channel %d: %s').format(c, list.slice().sort((a, b) => b.signal - a.signal).slice(0, 6).map((a) => `${a.ssid || _('hidden')} (${a.signal} dBm)`).join(', ') + (list.length > 6 ? ' …' : ''))
				: _('Channel %d: no networks').format(c);
			const bar = h('div', 'fp-chan-bar');
			bar.style.height = (list.length ? 6 + list.length / max * 54 : 2) + 'px';
			col.append(h('span', 'fp-chan-n', list.length ? String(list.length) : ''), bar, h('span', 'fp-chan-c', String(c)));
			if (c == cur) col.appendChild(h('span', 'fp-chan-tag', _('you')));
			else if (c == best) col.appendChild(h('span', 'fp-chan-tag', _('best')));
			chart.appendChild(col);
		});
		box.appendChild(chart);

		/* recommendation */
		const auto = (x.radio.config && x.radio.config.channel) == 'auto';
		const sc = cur ? score(cur) : 0, sb = score(best);
		let msg;
		if (!cur) msg = _('Could not read the current channel.');
		else if (best != cur && sb < sc * 0.6 && sc - sb >= 2)
			msg = _('Channel %d is busy. Channel %d is quieter. %s').format(cur, best,
				auto ? _('Automatic selection picked the busy channel; set channel %d manually in Wi-Fi settings.').format(best) : _('Change it in Wi-Fi settings.'));
		else
			msg = _('Channel %d is a good choice for this location.').format(cur);
		const p = h('p', 'fp-scan-msg', msg);
		box.appendChild(p);
		if (band == '5g' && best != cur)
			box.appendChild(h('p', 'fp-scan-note', _('Channels 52–144 need radar detection and can switch without warning, so only 36 and 149 are suggested.')));
		return box;
	},

	tickClocks() {
		const s = this.sys;
		if (!s) return;
		const drift = Math.floor((Date.now() - this.sysAt) / 1000);
		const t = new Date((s.localtime + drift) * 1000);
		/* localtime is already shifted to the router's zone; print as UTC */
		this.sysClock.textContent = t.toLocaleString(undefined, { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
		this.sysUptime.textContent = fmtDuration(s.uptime + drift);
		if (s.load) this.sysLoad.textContent = s.load.map((l) => (l / 65536).toFixed(2)).join('  ');
		if (s.root && s.root.total) {
			const pct = Math.round(s.root.used / s.root.total * 100);
			this.sysStore.textContent = _('%s of %s used (%d%%)').format(fmtBytes(s.root.used * 1024), fmtBytes(s.root.total * 1024), pct);
		}
	}
});
