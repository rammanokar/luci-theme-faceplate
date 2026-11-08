'use strict';
'require baseclass';
'require ui';

/*
 * Faceplate navigation:
 *  - sidebar: Dashboard, pinnable Shortcuts, then every section collapsible
 *  - command palette (Ctrl/⌘+K or "/") that searches every page and tab,
 *    with plain-language keywords ("wifi password", "port forward", …)
 *  - recent pages, theme switch (auto / light / dark)
 */

const LS = {
	get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
	set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};

const DEFAULT_PINS = [
	'admin/network/network',
	'admin/network/wireless',
	'admin/network/dhcp',
	'admin/network/firewall/forwards',
	'admin/system/package-manager',
	'admin/system/flash',
	'admin/system/reboot'
];

/* extra words people search for, mapped to the page that answers them */
const KEYWORDS = {
	'admin/dashboard': 'home overview speed traffic devices clients',
	'admin/status/overview': 'status info uptime memory leases',
	'admin/network/network': 'interfaces wan lan internet ip address pppoe dhcp client bridge vlan',
	'admin/network/wireless': 'wifi wi-fi wlan ssid wireless password key access point radio channel 5ghz 2.4ghz',
	'admin/network/dhcp': 'dhcp leases static ip reservation hostnames clients devices',
	'admin/network/dns': 'dns domain resolver dnsmasq hosts adblock',
	'admin/network/firewall': 'firewall security zones nat block',
	'admin/network/firewall/forwards': 'port forwarding open port nat redirect game server',
	'admin/network/firewall/rules': 'traffic rules allow block ports',
	'admin/network/diagnostics': 'ping traceroute nslookup test connectivity',
	'admin/network/routes': 'static routes gateway',
	'admin/system/system': 'hostname timezone time ntp clock language theme appearance',
	'admin/system/admin': 'password root login ssh dropbear keys https',
	'admin/system/admin/password': 'change password root',
	'admin/system/package-manager': 'software packages install apk opkg apps',
	'admin/system/flash': 'backup restore upgrade firmware factory reset sysupgrade',
	'admin/system/reboot': 'restart reboot power',
	'admin/system/startup': 'services init scripts boot',
	'admin/system/crontab': 'scheduled tasks cron',
	'admin/system/leds': 'lights led',
	'admin/status/logs': 'logs syslog messages kernel dmesg errors',
	'admin/status/logs/syslog': 'system log messages errors',
	'admin/status/realtime': 'graphs bandwidth traffic load live',
	'admin/status/processes': 'processes cpu top kill',
	'admin/logout': 'sign out log out exit'
};

/* Material Symbols Rounded names; painted by CSS (.fp-i-*) via mask */
const ICONS = {
	dashboard: 'dashboard', status: 'monitoring', system: 'settings', network: 'lan',
	services: 'apps', vpn: 'vpn_lock', statistics: 'bar_chart', logout: 'logout',
	search: 'search', star: 'star', star_fill: 'star_fill', page: 'description',
	auto: 'contrast', light: 'light_mode', dark: 'dark_mode'
};

function svgIcon(name, cls) {
	const n = document.createElement('span');
	n.className = 'fp-ico fp-i-' + (ICONS[name] || ICONS.page).replace(/_/g, '-') + (cls ? ' ' + cls : '');
	n.setAttribute('aria-hidden', 'true');
	return n;
}

function txt(tag, cls, text) {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (text != null) n.textContent = text;
	return n;
}

return baseclass.extend({
	__init__() {
		this.bindDrawer();
		this.bindScheme();
		this.bindGauges();
		ui.menu.load().then((tree) => this.render(tree));
	},

	render(tree) {
		let node = tree;
		let url = '';

		this.renderModeMenu(tree);

		if (L.env.dispatchpath.length >= 3) {
			for (let i = 0; i < 3 && node; i++) {
				node = node.children[L.env.dispatchpath[i]];
				url = url + (url ? '/' : '') + L.env.dispatchpath[i];
			}

			if (node)
				this.renderTabMenu(node, url);
		}

		this.rememberPage();
		this.bindPalette();
		this.liftTitle();
	},

	/* --------------------------------------------------------- index */

	buildIndex(root, base) {
		const out = [];
		/* raw children: getChildren() resolves "alias" nodes (e.g. Firewall) to
		 * their target and so loses sibling tabs like Port Forwards */
		const kids = (node) => Object.keys(node.children || {})
			.map((k) => Object.assign(node.children[k], { name: k }))
			.filter((c) => c.satisfied !== false && c.title)
			.sort((a, b) => (a.order || 9999) - (b.order || 9999));
		const walk = (node, path, trail, depth) => {
			kids(node).forEach((child) => {
				const p = path.concat(child.name);
				const key = p.join('/');
				const title = _(child.title);
				const subs = kids(child);
				out.push({
					key,
					title,
					trail: trail.join(' › '),
					url: L.url.apply(L, p),
					top: p[1],
					leaf: !subs.length,
					depth,
					words: (KEYWORDS[key] || '').toLowerCase()
				});
				if (depth < 4)
					walk(child, p, trail.concat(title), depth + 1);
			});
		};
		walk(root, [ base ], [], 1);
		this.index = out;
		this.byKey = Object.fromEntries(out.map((e) => [ e.key, e ]));
		return out;
	},

	/* -------------------------------------------------------- tab bars */

	renderTabMenu(tree, url, level) {
		const container = document.querySelector('#tabmenu');
		const ul = E('ul', { 'class': 'tabs' });
		const children = ui.menu.getChildren(tree);
		let activeNode = null;

		children.forEach((child) => {
			const isActive = (L.env.dispatchpath[3 + (level || 0)] == child.name);

			ul.appendChild(E('li', { 'class': 'tabmenu-item-%s%s'.format(child.name, isActive ? ' active' : '') }, [
				E('a', { 'href': L.url(url, child.name), 'aria-current': isActive ? 'page' : null }, [ _(child.title) ])
			]));

			if (isActive)
				activeNode = child;
		});

		if (ul.children.length == 0)
			return E([]);

		container.appendChild(ul);
		container.style.display = '';

		if (activeNode)
			this.renderTabMenu(activeNode, url + '/' + activeNode.name, (level || 0) + 1);

		return ul;
	},

	/* --------------------------------------------------------- sidebar */

	renderMainMenu(tree, base) {
		const nav = document.querySelector('#topmenu');
		const children = ui.menu.getChildren(tree);
		const where = document.querySelector('#fp-where');
		const cur = L.env.dispatchpath;

		this.buildIndex(tree, base);

		const leaves = children.filter((c) => !ui.menu.getChildren(c).length && c.name != 'logout');
		const groups = children.filter((c) => ui.menu.getChildren(c).length);
		const logout = children.find((c) => c.name == 'logout');

		/* top-level single pages (e.g. Dashboard) */
		leaves.forEach((child) => {
			const isActive = cur[1] == child.name;
			nav.appendChild(E('a', {
				'class': 'fp-item%s'.format(isActive ? ' active' : ''),
				'href': L.url(base, child.name),
				'aria-current': isActive ? 'page' : null
			}, [ svgIcon(ICONS[child.name] ? child.name : 'page'), E('span', {}, [ _(child.title) ]), child.name == 'dashboard' ? this.alertBadge() : null ]));
		});

		/* shortcuts */
		this.shortcutsBox = E('div', { 'class': 'fp-shortcuts' });
		nav.appendChild(this.shortcutsBox);
		this.renderShortcuts();

		/* all sections */
		nav.appendChild(E('div', { 'class': 'fp-nav-label' }, [ _('All settings') ]));

		groups.forEach((child) => {
			const subs = ui.menu.getChildren(child);
			const isActive = (cur[1] == child.name);
			const list = E('ul', { 'class': 'fp-sub', 'id': 'fp-sub-' + child.name });
			let activeTitle = null;

			subs.forEach((sub) => {
				const subActive = isActive && (cur[2] == sub.name);
				if (subActive) activeTitle = _(sub.title);
				list.appendChild(E('li', { 'class': subActive ? 'active' : '' }, [
					E('a', { 'href': L.url(base, child.name, sub.name), 'aria-current': subActive ? 'page' : null }, [ _(sub.title) ])
				]));
			});

			const head = E('button', {
				'type': 'button',
				'class': 'fp-group-head',
				'aria-expanded': isActive ? 'true' : 'false',
				'aria-controls': 'fp-sub-' + child.name,
				'click': (ev) => {
					const g = ev.currentTarget.parentNode;
					const open = g.classList.toggle('open');
					ev.currentTarget.setAttribute('aria-expanded', open ? 'true' : 'false');
				}
			}, [ svgIcon(ICONS[child.name] ? child.name : 'page'), E('span', {}, [ _(child.title) ]), E('span', { 'class': 'fp-chev', 'aria-hidden': 'true' }) ]);

			nav.appendChild(E('div', { 'class': 'fp-group%s'.format(isActive ? ' active open' : '') }, [ head, list ]));

			if (isActive && where) {
				where.appendChild(txt('span', 'fp-where-group', _(child.title)));
				if (activeTitle) where.appendChild(txt('span', 'fp-where-page', activeTitle));
			}
		});

		if (where && !where.firstChild) {
			const leaf = leaves.find((c) => c.name == cur[1]);
			if (leaf) where.appendChild(txt('span', 'fp-where-page', _(leaf.title)));
		}

		if (logout) {
			const foot = document.querySelector('.fp-rail-foot');
			foot.insertBefore(E('a', { 'class': 'fp-item fp-logout', 'href': L.url(base, 'logout') }, [
				svgIcon('logout'), E('span', {}, [ _(logout.title) ])
			]), foot.firstChild);
		}

		nav.style.display = '';
	},

	/* issue count from the last security check, shown on every page */
	alertBadge() {
		const a = LS.get('fp-audit', null);
		const n = a ? (a.crit || 0) + (a.warn || 0) : 0;
		const b = E('span', {
			'id': 'fp-alert-badge',
			'class': 'fp-badge' + (a && a.crit ? ' is-critical' : ''),
			'title': n ? _('%d security issues found. Open the dashboard for details.').format(n) : ''
		}, [ String(n) ]);
		b.hidden = !n;
		return b;
	},

	pins() {
		return LS.get('fp-pins', DEFAULT_PINS).filter((k) => this.byKey && this.byKey[k]);
	},

	togglePin(key) {
		const all = LS.get('fp-pins', DEFAULT_PINS);
		const i = all.indexOf(key);
		if (i >= 0) all.splice(i, 1); else all.push(key);
		LS.set('fp-pins', all);
		this.renderShortcuts();
	},

	renderShortcuts() {
		const box = this.shortcutsBox;
		if (!box) return;
		const cur = L.env.dispatchpath.join('/');
		box.replaceChildren();
		const pins = this.pins();
		if (!pins.length) return;
		box.appendChild(E('div', { 'class': 'fp-nav-label' }, [ _('Shortcuts') ]));
		pins.forEach((k) => {
			const e = this.byKey[k];
			const active = cur == k || cur.indexOf(k + '/') == 0;
			box.appendChild(E('a', {
				'class': 'fp-item fp-pin%s'.format(active ? ' active' : ''),
				'href': e.url,
				'title': e.trail ? e.trail + ' › ' + e.title : e.title
			}, [ E('span', { 'class': 'fp-pin-dot', 'aria-hidden': 'true' }), E('span', {}, [ e.title ]) ]));
		});
	},

	renderModeMenu(tree) {
		const ul = document.querySelector('#modemenu');
		const children = ui.menu.getChildren(tree);

		children.forEach((child, index) => {
			const isActive = L.env.requestpath.length
				? child.name === L.env.requestpath[0]
				: index === 0;

			ul.appendChild(E('li', { 'class': isActive ? 'active' : '' }, [
				E('a', { 'href': L.url(child.name) }, [ _(child.title) ])
			]));

			if (isActive)
				this.renderMainMenu(child, child.name);
		});

		if (ul.children.length > 1)
			ul.style.display = '';
	},

	/* ------------------------------------------------- page title
	 * The menu tabs (#tabmenu) render before the view, so on tabbed pages
	 * they appeared above the title. Show a copy of the view's title above
	 * the tabs and hide the original (re-done if the view re-renders). */
	liftTitle() {
		const tabs = document.querySelector('#tabmenu');
		const view = document.querySelector('#view');
		if (!tabs || !view || tabs.style.display == 'none' || !tabs.firstElementChild) return;

		let head = null;
		const sync = () => {
			const src = Array.from(view.querySelectorAll('h2')).find((h) => !h.closest('.cbi-section, .modal'));
			if (!src) return;
			if (!head) {
				head = E('h2', { 'class': 'fp-page-title' });
				tabs.parentNode.insertBefore(head, tabs);
			}
			if (head.textContent != src.textContent) head.textContent = src.textContent;
			if (!src.classList.contains('fp-title-src')) src.classList.add('fp-title-src');
		};
		new MutationObserver(sync).observe(view, { childList: true, subtree: true });
		sync();
	},

	/* ---------------------------------------------------- recent pages */

	rememberPage() {
		const key = L.env.dispatchpath.join('/');
		if (!this.byKey) return;
		/* resolve to the deepest indexed node on the current path */
		let p = L.env.dispatchpath.slice();
		while (p.length > 1 && !this.byKey[p.join('/')]) p.pop();
		const k = p.join('/');
		if (!this.byKey[k] || k == 'admin/logout') return;
		const rec = LS.get('fp-recent', []).filter((x) => x != k);
		rec.unshift(k);
		LS.set('fp-recent', rec.slice(0, 6));
	},

	/* ---------------------------------------------------------- palette */

	bindPalette() {
		const trigger = document.querySelector('#fp-search');
		const dlg = txt('div', 'fp-palette');
		dlg.id = 'fp-palette';
		dlg.hidden = true;
		dlg.setAttribute('role', 'dialog');
		dlg.setAttribute('aria-modal', 'true');
		dlg.setAttribute('aria-label', _('Search'));

		const panel = txt('div', 'fp-palette-panel');
		const bar = txt('div', 'fp-palette-bar');
		const input = txt('input', 'fp-palette-input');
		input.type = 'text';
		input.placeholder = _('Search pages and settings…');
		input.setAttribute('role', 'combobox');
		input.setAttribute('aria-expanded', 'true');
		input.setAttribute('aria-controls', 'fp-palette-list');
		input.setAttribute('autocomplete', 'off');
		input.spellcheck = false;
		bar.append(svgIcon('search'), input, txt('kbd', null, 'Esc'));

		const list = txt('ul', 'fp-palette-list');
		list.id = 'fp-palette-list';
		list.setAttribute('role', 'listbox');

		const foot = txt('div', 'fp-palette-foot');
		foot.append(
			txt('span', null, _('↑ ↓ to move')),
			txt('span', null, _('Enter to open')),
			txt('span', null, _('Ctrl+Enter to pin to the sidebar'))
		);

		panel.append(bar, list, foot);
		dlg.appendChild(panel);
		document.body.appendChild(dlg);

		this.pal = { dlg, input, list, sel: 0, items: [] };

		dlg.addEventListener('mousedown', (ev) => { if (ev.target === dlg) this.closePalette(); });
		input.addEventListener('input', () => { this.pal.sel = 0; this.searchPalette(); });
		input.addEventListener('keydown', (ev) => this.paletteKey(ev));

		if (trigger) trigger.addEventListener('click', () => this.openPalette());

		document.addEventListener('keydown', (ev) => {
			const tag = (ev.target.tagName || '').toLowerCase();
			const typing = tag == 'input' || tag == 'textarea' || tag == 'select' || ev.target.isContentEditable;
			if ((ev.key == 'k' || ev.key == 'K') && (ev.ctrlKey || ev.metaKey)) {
				ev.preventDefault();
				dlg.hidden ? this.openPalette() : this.closePalette();
			}
			else if (ev.key == '/' && !typing && dlg.hidden && !document.body.classList.contains('modal-overlay-active')) {
				ev.preventDefault();
				this.openPalette();
			}
		});
	},

	openPalette() {
		const p = this.pal;
		this.lastFocus = document.activeElement;
		p.dlg.hidden = false;
		document.body.classList.add('fp-palette-open');
		p.input.value = '';
		p.sel = 0;
		this.searchPalette();
		p.input.focus();
	},

	closePalette() {
		const p = this.pal;
		if (!p || p.dlg.hidden) return;
		p.dlg.hidden = true;
		document.body.classList.remove('fp-palette-open');
		if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus();
	},

	score(e, terms, q) {
		const t = e.title.toLowerCase(), tr = e.trail.toLowerCase();
		const hay = t + ' ' + tr + ' ' + e.words + ' ' + e.key.replace(/[\/_-]/g, ' ');
		let s = 0;
		for (const term of terms) {
			if (!hay.includes(term)) return -1;
			if (t.startsWith(term)) s += 60;
			else if (t.includes(term)) s += 35;
			else if (e.words.includes(term)) s += 22;
			else s += 8;
		}
		if (t == q) s += 100;
		if (t.startsWith(q)) s += 40;
		s -= e.depth * 2;
		if (e.leaf) s += 3;
		return s;
	},

	searchPalette() {
		const p = this.pal;
		const q = p.input.value.trim().toLowerCase();
		let groups = [];

		if (!q) {
			const recent = LS.get('fp-recent', []).map((k) => this.byKey[k]).filter(Boolean).slice(0, 5);
			const pins = this.pins().map((k) => this.byKey[k]).filter((e) => recent.indexOf(e) < 0);
			if (recent.length) groups.push([ _('Recent'), recent ]);
			if (pins.length) groups.push([ _('Shortcuts'), pins ]);
		}
		else {
			const terms = q.split(/\s+/);
			const hits = this.index
				.map((e) => [ this.score(e, terms, q), e ])
				.filter(([ s ]) => s >= 0)
				.sort((a, b) => b[0] - a[0])
				.slice(0, 12)
				.map(([ , e ]) => e);
			groups.push([ null, hits ]);
		}

		const pinned = new Set(this.pins());
		const frag = document.createDocumentFragment();
		p.items = [];
		groups.forEach(([ label, entries ]) => {
			if (label) frag.appendChild(txt('li', 'fp-palette-group', label)).setAttribute('role', 'presentation');
			entries.forEach((e) => {
				const i = p.items.length;
				const li = txt('li', 'fp-palette-item');
				li.id = 'fp-pal-' + i;
				li.setAttribute('role', 'option');
				const main = txt('div', 'fp-palette-main');
				main.append(txt('span', 'fp-palette-title', e.title));
				if (e.trail) main.append(txt('span', 'fp-palette-trail', e.trail));
				const pin = txt('button', 'fp-palette-pin' + (pinned.has(e.key) ? ' is-pinned' : ''));
				pin.type = 'button';
				pin.tabIndex = -1;
				pin.title = pinned.has(e.key) ? _('Remove from shortcuts') : _('Add to shortcuts');
				pin.setAttribute('aria-label', pin.title);
				pin.appendChild(svgIcon(pinned.has(e.key) ? 'star_fill' : 'star'));
				pin.addEventListener('mousedown', (ev) => ev.preventDefault());
				pin.addEventListener('click', (ev) => { ev.stopPropagation(); this.togglePin(e.key); this.searchPalette(); });
				li.append(svgIcon(ICONS[e.top] ? e.top : 'page'), main, pin);
				li.addEventListener('mousemove', () => { if (p.sel != i) { p.sel = i; this.markSel(); } });
				li.addEventListener('click', () => this.go(e));
				frag.appendChild(li);
				p.items.push({ e, li });
			});
		});

		if (!p.items.length)
			frag.appendChild(txt('li', 'fp-palette-empty', q ? _('Nothing matches “%s”. Try a shorter word.').format(q) : _('Type to search every page and tab.')));

		p.list.replaceChildren(frag);
		this.markSel();
	},

	markSel() {
		const p = this.pal;
		if (p.sel >= p.items.length) p.sel = p.items.length - 1;
		p.items.forEach(({ li }, i) => li.setAttribute('aria-selected', i == p.sel ? 'true' : 'false'));
		const cur = p.items[p.sel];
		if (cur) {
			p.input.setAttribute('aria-activedescendant', cur.li.id);
			cur.li.scrollIntoView({ block: 'nearest' });
		}
	},

	paletteKey(ev) {
		const p = this.pal;
		if (ev.key == 'ArrowDown' || ev.key == 'ArrowUp') {
			ev.preventDefault();
			const n = p.items.length;
			if (n) p.sel = (p.sel + (ev.key == 'ArrowDown' ? 1 : -1) + n) % n;
			this.markSel();
		}
		else if (ev.key == 'Enter') {
			ev.preventDefault();
			const cur = p.items[p.sel];
			if (!cur) return;
			if (ev.ctrlKey || ev.metaKey) { this.togglePin(cur.e.key); this.searchPalette(); }
			else this.go(cur.e);
		}
		else if (ev.key == 'Escape') {
			ev.preventDefault();
			this.closePalette();
		}
		else if (ev.key == 'Tab') {
			ev.preventDefault();
		}
	},

	go(e) {
		this.closePalette();
		location.href = e.url;
	},

	/* ------------------------------------------------------ theme switch */

	bindScheme() {
		const btn = document.querySelector('#fp-scheme');
		if (!btn) return;
		const order = [ 'auto', 'light', 'dark' ];
		const labels = { auto: _('Theme: match device'), light: _('Theme: light'), dark: _('Theme: dark') };
		const show = () => {
			const s = LS.get('fp-scheme', 'auto');
			btn.replaceChildren(svgIcon(s));
			btn.title = labels[s];
			btn.setAttribute('aria-label', labels[s]);
		};
		btn.addEventListener('click', () => {
			const s = LS.get('fp-scheme', 'auto');
			const next = order[(order.indexOf(s) + 1) % order.length];
			LS.set('fp-scheme', next);
			if (window.fpApplyScheme) window.fpApplyScheme();
			show();
		});
		show();
	},

	/* ------------------------------------------- donut gauges
	 * Status progress bars only carry their value as an inline width on the
	 * inner element. Mirror it into CSS variables so the stylesheet can draw
	 * a donut (conic-gradient) with the percentage in the centre. */
	bindGauges() {
		if (!/^admin-status-overview/.test(document.body.dataset.page || '')) return;
		let queued = false;
		const apply = () => {
			queued = false;
			document.querySelectorAll('.cbi-progressbar').forEach((pb) => {
				const inner = pb.firstElementChild;
				const m = inner && /([0-9.]+)%/.exec(inner.style.width || '');
				const p = m ? Math.max(0, Math.min(100, +m[1])) : 0;
				if (pb.dataset.fpP === String(p)) return;   /* no write, no mutation loop */
				pb.dataset.fpP = String(p);
				pb.style.setProperty('--fp-p', p);
				pb.style.setProperty('--fp-pi', Math.round(p));
				pb.classList.toggle('fp-hot', p >= 85);
			});
			this.renderMemory();
		};
		const queue = () => { if (!queued) { queued = true; requestAnimationFrame(apply); } };
		new MutationObserver(queue).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: [ 'style' ] });
		queue();
	},

	/* ------------------------------------------- memory: one stacked bar
	 * LuCI lists Total Available, Used, Buffered and Cached as separate bars,
	 * but they are parts of one total (and "Used" includes the cache). Read
	 * the values from LuCI's rows and show a single Apps | Cache | Free bar. */
	renderMemory() {
		const sec = Array.from(document.querySelectorAll('.cbi-section')).find((el) => {
			const h = el.querySelector('h3');
			return h && h.firstChild && String(h.firstChild.textContent).trim() == _('Memory');
		});
		const table = sec && sec.querySelector('.table');
		if (!table) return;

		const unit = { B: 1, KiB: 1024, MiB: 1048576, GiB: 1073741824, TiB: 1099511627776 };
		const vals = {};
		let total = null;
		table.querySelectorAll('.tr').forEach((tr) => {
			const label = tr.firstElementChild && tr.firstElementChild.textContent.trim();
			const pb = tr.querySelector('.cbi-progressbar');
			const m = pb && /^([0-9.]+)\s*([KMGT]?i?B)\s*\/\s*([0-9.]+)\s*([KMGT]?i?B)/.exec(pb.getAttribute('title') || '');
			if (!m) return;
			vals[label] = +m[1] * (unit[m[2]] || 1);
			if (label != _('Swap free')) total = +m[3] * (unit[m[4]] || 1);
		});
		const used = vals[_('Used')], avail = vals[_('Total Available')];
		if (!total || used == null) return;

		const cache = (vals[_('Buffered')] || 0) + (vals[_('Cached')] || 0);
		const apps = Math.max(0, used - cache), free = Math.max(0, total - used);
		const key = [ apps, cache, free, avail ].map(Math.round).join(',');
		if (sec.dataset.fpMem == key) return;
		sec.dataset.fpMem = key;

		const fmt = (b) => {
			const u = [ 'B', 'KiB', 'MiB', 'GiB' ];
			let i = 0;
			while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
			return (i ? b.toFixed(b >= 100 ? 0 : 1) : b.toFixed(0)) + ' ' + u[i];
		};
		const pct = (v) => (v / total * 100);

		let box = sec.querySelector('.fp-mem');
		if (!box) {
			box = E('div', { 'class': 'fp-mem' });
			table.parentNode.insertBefore(box, table);
			table.parentNode.classList.add('fp-mem-host');
		}

		const seg = (cls, v, label) => E('div', {
			'class': 'fp-mem-seg ' + cls,
			'style': 'flex-grow:' + Math.max(pct(v), 0.0001).toFixed(3),
			'title': '%s: %s (%d%%)'.format(label, fmt(v), Math.round(pct(v)))
		});
		const item = (cls, label, v) => E('li', { 'class': cls }, [
			E('span', { 'class': 'fp-mem-key', 'aria-hidden': 'true' }),
			E('span', {}, [ label ]),
			E('strong', {}, [ fmt(v) ]),
			E('span', { 'class': 'fp-mem-pct' }, [ Math.round(pct(v)) + '%' ])
		]);

		box.replaceChildren(
			E('div', { 'class': 'fp-mem-head' }, [
				E('div', {}, [ E('strong', { 'class': 'fp-mem-big' }, [ fmt(apps) ]), ' ', _('used by programs, of %s').format(fmt(total)) ]),
				avail != null ? E('div', { 'class': 'fp-mem-avail' }, [ _('%s available').format(fmt(avail)) ]) : null
			]),
			E('div', { 'class': 'fp-mem-bar', 'role': 'img',
				'aria-label': _('Programs %s, cache %s, free %s of %s').format(fmt(apps), fmt(cache), fmt(free), fmt(total)) }, [
				seg('is-apps', apps, _('Programs')),
				seg('is-cache', cache, _('Cache')),
				seg('is-free', free, _('Free'))
			]),
			E('ul', { 'class': 'fp-mem-legend' }, [
				item('is-apps', _('Programs'), apps),
				item('is-cache', _('Cache (freed when needed)'), cache),
				item('is-free', _('Free'), free)
			])
		);
	},

	/* --------------------------------------------- off-canvas drawer */

	bindDrawer() {
		const btn = document.querySelector('#fp-menu-toggle');
		const scrim = document.querySelector('#fp-scrim');

		if (!btn || !scrim)
			return;

		const set = (open) => {
			document.body.classList.toggle('fp-drawer-open', open);
			btn.setAttribute('aria-expanded', open ? 'true' : 'false');
			scrim.hidden = !open;
		};

		btn.addEventListener('click', () => set(!document.body.classList.contains('fp-drawer-open')));
		scrim.addEventListener('click', () => set(false));
		document.addEventListener('keydown', (ev) => {
			if (ev.key === 'Escape' && document.body.classList.contains('fp-drawer-open')) {
				set(false);
				btn.focus();
			}
		});
	}
});
