#!/usr/bin/env python3
"""
Asset preprocessing for ASCENT.

Turns the raw, legally-sourced texture/catalog downloads (see CREDITS.md) into
compact, game-ready files under public/assets/.

Usage:  python3 -I scripts/process_assets.py <raw_dir> <out_dir>

Raw inputs expected in <raw_dir>:
  earth-blue-marble.jpg        NASA Blue Marble (via vasturiano/three-globe)
  earth_night_4096.jpg         Solar System Scope night lights (via three.js examples)
  earth_brc_4096.jpg           Solar System Scope bump/roughness/clouds (via three.js examples)
  water_4k.png, elev_bump_4k.jpg  NASA Visible Earth masks (via turban/webgl-earth)
  sss/*.jpg|png                Solar System Scope 2k planet maps (via pyvista/data)
  Jupiter_-_Io_(A).jpg ...     NASA-3D-Resources (public domain) Galilean moons
  Tycho_Star_Map.jpg           NASA-3D-Resources Tycho star map (public domain)
  bsc5.json                    Yale Bright Star Catalog 5 (via brettonw/YaleBrightStarCatalog)
"""
import json
import math
import os
import struct
import sys

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None

RAW = sys.argv[1]
OUT = sys.argv[2]


def raw(*p):
    return os.path.join(RAW, *p)


def out(*p):
    path = os.path.join(OUT, *p)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def load_rgb(path, size=None):
    im = Image.open(path).convert('RGB')
    if size and im.size != size:
        im = im.resize(size, Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0


def load_l(path, size=None):
    im = Image.open(path).convert('L')
    if size and im.size != size:
        im = im.resize(size, Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255.0


def save_rgb(arr, path, quality=92, lossless=False):
    img = Image.fromarray(np.clip(arr * 255.0 + 0.5, 0, 255).astype(np.uint8), 'RGB')
    img.save(path, 'WEBP', quality=quality, lossless=lossless, method=6)
    print('wrote', path, os.path.getsize(path) // 1024, 'KB', img.size)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


# ----------------------------------------------------------------------------- Earth
def earth():
    size = (4096, 2048)
    bm = load_rgb(raw('earth-blue-marble.jpg'), size)
    water = load_l(raw('water_4k.png'), size)
    elev = load_l(raw('elev_bump_4k.jpg'), size)
    brc = load_rgb(raw('earth_brc_4096.jpg'), size)
    night = load_rgb(raw('earth_night_4096.jpg'), size)

    lum = bm @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    # sea ice: bright pixels flagged as water are ice, treat as land surface (diffuse, white)
    ice = (water > 0.5) & (lum > 0.42)
    w = water.copy()
    w[ice] = 0.0
    # soften the mask edge a touch so coastlines filter nicely
    wimg = Image.fromarray((w * 255).astype(np.uint8), 'L').filter(ImageFilter.GaussianBlur(0.8))
    w = np.asarray(wimg).astype(np.float32) / 255.0

    # Bathymetry-derived shallowness from the Blue Marble topo-bathy shading of the ocean.
    ocean_lum = np.where(water > 0.5, lum, 0.0)
    deep_ref = np.percentile(ocean_lum[water > 0.5], 35)
    shelf_ref = np.percentile(ocean_lum[water > 0.5], 97)
    shallow = smoothstep(deep_ref + 0.015, shelf_ref, ocean_lum) * (water > 0.5)
    shallow = np.asarray(Image.fromarray((shallow * 255).astype(np.uint8), 'L')
                         .filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32) / 255.0

    # Albedo: Blue Marble land, natural dark ocean (shader adds shallow tint, glint, sky reflection)
    deep = np.array([0.020, 0.055, 0.115], dtype=np.float32)  # sRGB-ish dark navy
    shelf = np.array([0.045, 0.16, 0.24], dtype=np.float32)
    ocean = deep[None, None, :] * (1 - shallow[..., None] * 0.6) + shelf[None, None, :] * (shallow[..., None] * 0.6)
    # Gentle land grading: Blue Marble is a touch dark/green in shadows; lift slightly.
    land = np.clip(bm * 1.04, 0, 1)
    alb = land * (1 - w[..., None]) + ocean * w[..., None]
    save_rgb(alb, out('earth', 'albedo.webp'), quality=93)

    # Data texture: R = water, G = elevation (0..1 -> 0..8848 m), B = shallowness
    data = np.stack([w, elev * (1 - (water > 0.5) * 0.98), shallow], axis=-1)
    save_rgb(data, out('earth', 'data.webp'), lossless=True)

    # City lights: subtract the dark floor, keep warm colour
    floor = np.array([0.028, 0.032, 0.075], dtype=np.float32)
    nl = np.clip((night - floor) / (1 - floor), 0, 1)
    nl = np.clip(nl * 1.15, 0, 1)
    save_rgb(nl, out('earth', 'night.webp'), quality=90)

    # Clouds: blue channel of the Solar System Scope packed texture
    clouds = brc[..., 2]
    clouds = np.clip((clouds - 0.04) / 0.96, 0, 1)
    save_rgb(np.repeat(clouds[..., None], 3, axis=-1), out('earth', 'clouds.webp'), quality=92)

    # Small versions for environment probes / far LOD
    small = Image.open(out('earth', 'albedo.webp')).resize((1024, 512), Image.LANCZOS)
    small.save(out('earth', 'albedo_1k.webp'), 'WEBP', quality=90)
    smallc = Image.open(out('earth', 'clouds.webp')).resize((1024, 512), Image.LANCZOS)
    smallc.save(out('earth', 'clouds_1k.webp'), 'WEBP', quality=90)


# ----------------------------------------------------------------------------- Moon & planets
def moon():
    alb = load_rgb(raw('sss', 'moon.jpg'))
    save_rgb(alb, out('moon', 'albedo.webp'), quality=93)
    lum = alb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    # Large-scale relief proxy: maria (dark) are low basins, highlands (bright) high.
    big = np.asarray(Image.fromarray((lum * 255).astype(np.uint8), 'L').resize((1024, 512), Image.LANCZOS)
                     .filter(ImageFilter.GaussianBlur(6))).astype(np.float32) / 255.0
    lo, hi = np.percentile(big, 2), np.percentile(big, 98)
    h = np.clip((big - lo) / (hi - lo), 0, 1)
    save_rgb(np.repeat(h[..., None], 3, axis=-1), out('moon', 'height.webp'), lossless=True)


def planets():
    for name in ['mercury', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'sun']:
        im = Image.open(raw('sss', f'{name}.jpg')).convert('RGB')
        p = out('planets', f'{name}.webp')
        im.save(p, 'WEBP', quality=92, method=6)
        print('wrote', p, im.size)
    im = Image.open(raw('sss', 'venus_atmosphere.jpg')).convert('RGB')
    im.save(out('planets', 'venus.webp'), 'WEBP', quality=92, method=6)
    ring = Image.open(raw('sss', 'saturn_ring_alpha.png')).convert('RGBA')
    ring.save(out('planets', 'saturn_ring.webp'), 'WEBP', lossless=True)
    for src, dst in [('Jupiter_-_Io_(A).jpg', 'io'), ('Jupiter_-_Europa.jpg', 'europa'),
                     ('Jupiter_-_Ganymede.jpg', 'ganymede'), ('Jupiter_-_Callisto.jpg', 'callisto')]:
        im = Image.open(raw(src)).convert('RGB')
        im.save(out('planets', f'{dst}.webp'), 'WEBP', quality=90, method=6)
        print('wrote', dst, im.size)


# ----------------------------------------------------------------------------- Sky
OBLIQUITY = math.radians(23.4392911)


def eq_to_ecl(x, y, z):
    # rotate equatorial J2000 -> ecliptic J2000 about +X
    ce, se = math.cos(OBLIQUITY), math.sin(OBLIQUITY)
    return x, ce * y + se * z, -se * y + ce * z


def parse_ra(s):
    h, m, sec = s.replace('h', ' ').replace('m', ' ').replace('s', ' ').split()[:3]
    return (float(h) + float(m) / 60 + float(sec) / 3600) * 15.0


def parse_dec(s):
    s = s.replace('°', ' ').replace('′', ' ').replace('″', ' ').replace("'", ' ').replace('"', ' ')
    parts = s.split()
    sign = -1.0 if parts[0].startswith('-') else 1.0
    d = abs(float(parts[0]))
    m = float(parts[1]) if len(parts) > 1 else 0
    sec = float(parts[2]) if len(parts) > 2 else 0
    return sign * (d + m / 60 + sec / 3600)


def temp_to_rgb(t):
    # Blackbody colour approximation (Tanner Helland fit), normalised
    t = max(1000.0, min(40000.0, t)) / 100.0
    if t <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661
        b = 0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    else:
        r = 329.698727446 * ((t - 60) ** -0.1332047592)
        g = 288.1221695283 * ((t - 60) ** -0.0755148492)
        b = 255.0
    c = np.clip(np.array([r, g, b]) / 255.0, 0, 1)
    return c / max(c.max(), 1e-6)


def stars():
    cat = json.load(open(raw('bsc5.json')))
    rows = []
    for s in cat:
        if 'RA' not in s or 'Dec' not in s or 'Vmag' not in s:
            continue
        try:
            ra = math.radians(parse_ra(s['RA']))
            dec = math.radians(parse_dec(s['Dec']))
            v = float(s['Vmag'])
        except Exception:
            continue
        k = float(s.get('K', '6000') or 6000)
        x, y, z = math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec)
        ex, ey, ez = eq_to_ecl(x, y, z)
        r, g, b = temp_to_rgb(k)
        rows.append((ex, ey, ez, v, r, g, b))
    rows.sort(key=lambda r: r[3])
    with open(out('sky', 'stars.bin'), 'wb') as f:
        f.write(struct.pack('<I', len(rows)))
        for r in rows:
            f.write(struct.pack('<7f', *r))
    print('stars', len(rows))
    return rows


def milky_way(rows):
    tycho = Image.open(raw('Tycho_Star_Map.jpg')).convert('RGB')
    W, H = tycho.size
    a = np.asarray(tycho).astype(np.float32) / 255.0
    lum = a.mean(axis=2)
    # Calibrate the map's RA convention against the bright stars of the catalogue.
    best = None
    bright = [r for r in rows if r[3] < 3.0]
    for flip in (False, True):
        for off in np.arange(0, 360, 2.0):
            score = 0.0
            for (ex, ey, ez, v, *_ ) in bright:
                # back to equatorial for the test
                ce, se = math.cos(OBLIQUITY), math.sin(OBLIQUITY)
                x, y, z = ex, ce * ey - se * ez, se * ey + ce * ez
                ra = math.degrees(math.atan2(y, x)) % 360
                dec = math.degrees(math.asin(max(-1, min(1, z))))
                u = ((-ra if flip else ra) + off) % 360 / 360.0
                px = int(u * W) % W
                py = int((90 - dec) / 180 * H)
                py = min(H - 1, max(0, py))
                score += lum[max(0, py - 1):py + 2, max(0, px - 1):px + 2].max()
            if best is None or score > best[0]:
                best = (score, flip, off)
    print('tycho calibration', best)
    _, flip, off = best

    # Remove point stars: morphological opening via min/median filters, then blur into glow.
    # Star-subtracted diffuse glow: heavy median (kills point sources) then a multi-scale blur
    glow = tycho.filter(ImageFilter.MedianFilter(9)).filter(ImageFilter.MedianFilter(9))
    fine = np.asarray(glow.filter(ImageFilter.GaussianBlur(2.5))).astype(np.float32) / 255.0
    coarse = np.asarray(glow.filter(ImageFilter.GaussianBlur(9.0))).astype(np.float32) / 255.0
    g = 0.55 * fine + 0.45 * coarse
    g = np.clip(g - np.percentile(g, 8), 0, None)
    g = g / max(np.percentile(g, 99.8), 1e-6)
    g = np.clip(g, 0, 1) ** 1.1
    # Kill JPEG chroma speckle: luminance carries detail, colour comes from a very coarse blur.
    lum_g = g.mean(axis=2, keepdims=True)
    tint = np.asarray(Image.fromarray((np.clip(g, 0, 1) * 255).astype(np.uint8), 'RGB')
                      .filter(ImageFilter.GaussianBlur(24))).astype(np.float32) / 255.0
    tint = tint / np.maximum(tint.mean(axis=2, keepdims=True), 1e-3)
    tint = 1.0 + (np.clip(tint, 0.5, 1.6) - 1.0) * 0.6
    g = np.clip(lum_g * tint, 0, 1)

    # Resample into an ecliptic-longitude/latitude equirectangular map (our sky frame).
    OW, OH = 2048, 1024
    lon = (np.arange(OW) + 0.5) / OW * 2 * np.pi - np.pi
    lat = np.pi / 2 - (np.arange(OH) + 0.5) / OH * np.pi
    LON, LAT = np.meshgrid(lon, lat)
    ex, ey, ez = np.cos(LAT) * np.cos(LON), np.cos(LAT) * np.sin(LON), np.sin(LAT)
    ce, se = math.cos(OBLIQUITY), math.sin(OBLIQUITY)
    x, y, z = ex, ce * ey - se * ez, se * ey + ce * ez
    ra = np.degrees(np.arctan2(y, x)) % 360
    dec = np.degrees(np.arcsin(np.clip(z, -1, 1)))
    u = (((-ra if flip else ra) + off) % 360) / 360.0
    px = np.clip((u * W).astype(np.int32), 0, W - 1)
    py = np.clip(((90 - dec) / 180 * H).astype(np.int32), 0, H - 1)
    mw = g[py, px]
    save_rgb(mw, out('sky', 'milkyway.webp'), quality=94)
    # star density proxy for procedural faint stars
    dens = np.asarray(Image.fromarray((np.clip(lum, 0, 1) * 255).astype(np.uint8), 'L')
                      .filter(ImageFilter.GaussianBlur(4))).astype(np.float32) / 255.0
    d = dens[py, px]
    d = d / max(d.max(), 1e-6)
    dimg = Image.fromarray((d * 255).astype(np.uint8), 'L').resize((512, 256), Image.LANCZOS)
    dimg.save(out('sky', 'stardensity.png'))


if __name__ == '__main__':
    earth()
    moon()
    planets()
    r = stars()
    milky_way(r)
    print('done')
