#!/usr/bin/env python3
"""Build the deployable copy of Faceplate into dist/.

Router flash is small, so the build:
  * inlines only the Material Symbols icons the theme references, as CSS
    data URIs (no icon directory on the router),
  * minifies cascade.css (esbuild) and the LuCI JS modules (terser,
    keeping LuCI's 'require …' directives and the top-level return).
Sources under root/ stay readable; dist/ is what install.sh copies.
"""
import os, re, shutil, subprocess, sys, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
SRC, DIST, ICONS = (os.path.join(BASE, d) for d in ('root', 'dist', 'assets/icons'))
CSS = 'www/luci-static/faceplate/cascade.css'
JS = [ 'www/luci-static/resources/menu-faceplate.js', 'www/luci-static/resources/view/faceplate/dashboard.js' ]


def icon_data(css):
    names = sorted(set(re.findall(r'var\(--fp-svg-([a-z0-9-]+)\)', css)))
    decls = []
    for n in names:
        path = os.path.join(ICONS, n.replace('-', '_') + '.svg')
        svg = open(path).read()
        vb = re.search(r'viewBox="([^"]+)"', svg).group(1)
        ds = re.findall(r'<path[^>]*\sd="([^"]+)"', svg)
        mini = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='%s'>%s</svg>" % (vb, ''.join("<path d='%s'/>" % d for d in ds))
        uri = 'data:image/svg+xml,' + urllib.parse.quote(mini, safe=" /'=:,.-")
        decls.append('--fp-svg-%s:url("%s")' % (n, uri))
    return ':root{%s}' % ';'.join(decls), names


def run(cmd, data):
    r = subprocess.run(cmd, input=data, capture_output=True, text=True)
    if r.returncode:
        sys.exit('build failed: %s\n%s' % (' '.join(cmd[:3]), r.stderr))
    return r.stdout


def main():
    shutil.rmtree(DIST, ignore_errors=True)
    shutil.copytree(SRC, DIST)

    css_path = os.path.join(DIST, CSS)
    css = open(css_path).read()
    block, names = icon_data(css)
    assert '/* @@ICON-DATA@@ */' in css
    css = css.replace('/* @@ICON-DATA@@ */', block)
    css = run([ 'npx', '--yes', 'esbuild@0.24.0', '--loader=css', '--minify', '--log-level=error' ], css)
    open(css_path, 'w').write(css)
    shutil.copy(os.path.join(ICONS, 'LICENSE.txt'), os.path.join(os.path.dirname(css_path), 'LICENSE-icons.txt'))

    for rel in JS:
        p = os.path.join(DIST, rel)
        out = run([ 'npx', '--yes', 'terser@5.36.0', '--parse', 'bare_returns', '--mangle', '--format', 'ascii_only=false,comments=false,quote_style=1' ], open(p).read())
        # LuCI reads 'require …' directives from the top of the module; make sure they survived
        need = re.findall(r"^'require [^']+';", open(os.path.join(SRC, rel)).read(), re.M)
        for d in need:
            if d.rstrip(';') not in out:
                sys.exit('build failed: directive %s lost in %s' % (d, rel))
        open(p, 'w').write(out)

    total = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(DIST) for f in fs)
    print('dist: %d icons inlined, %d files, %.1f KiB' % (len(names), sum(len(fs) for _, _, fs in os.walk(DIST)), total / 1024))


if __name__ == '__main__':
    main()
