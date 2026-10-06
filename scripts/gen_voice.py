#!/usr/bin/env python3
"""
Offline mission-control voice generation with Kokoro-82M (Apache-2.0).

Model + voices come from the npm packages `kokoro-q8-shards` (ONNX weights) and
`kokoro-js` (voice style vectors). Clean voice is written; the radio chain
(band-limit, saturation, squelch, Quindar tones) is applied live by the game's
audio engine so it can react to distance / blackout / signal quality.

Usage: python scripts/gen_voice.py <model.onnx> <voices.npz> <lines.json> <out_dir>
"""
import json
import os
import sys

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

model, voices, lines_path, out_dir = sys.argv[1:5]
os.makedirs(out_dir, exist_ok=True)
spec = json.load(open(lines_path))
k = Kokoro(model, voices)

manifest = {}
existing = {}
man_path = os.path.join(out_dir, 'manifest.json')
if os.path.exists(man_path):
    existing = json.load(open(man_path))

for line_id, role, text in spec['lines']:
    v = spec['voices'][role]
    path = os.path.join(out_dir, f'{line_id}.mp3')
    prev = existing.get(line_id)
    if prev and prev.get('text') == text and prev.get('role') == role and os.path.exists(path):
        manifest[line_id] = prev
        continue
    audio, sr = k.create(text, voice=v['voice'], speed=v['speed'], lang='en-us')
    audio = np.asarray(audio, dtype=np.float32)
    # trim silence
    thr = 0.012 * np.max(np.abs(audio))
    idx = np.where(np.abs(audio) > thr)[0]
    if len(idx):
        a0 = max(0, idx[0] - int(0.03 * sr))
        a1 = min(len(audio), idx[-1] + int(0.08 * sr))
        audio = audio[a0:a1]
    # gentle high-pass (remove rumble) via first-order filter
    y = np.zeros_like(audio)
    a = 0.995
    prev_x = prev_y = 0.0
    for i, x in enumerate(audio):
        prev_y = a * (prev_y + x - prev_x)
        prev_x = x
        y[i] = prev_y
    # RMS normalise to a consistent dialogue level, then peak-limit
    rms = np.sqrt(np.mean(y ** 2) + 1e-12)
    y = y * (0.11 / rms)
    peak = np.max(np.abs(y))
    if peak > 0.97:
        y = y * (0.97 / peak)
    # short fades
    f = int(0.006 * sr)
    y[:f] *= np.linspace(0, 1, f)
    y[-f:] *= np.linspace(1, 0, f)
    sf.write(path, y, sr, format='MP3', subtype='MPEG_LAYER_III')
    manifest[line_id] = {'role': role, 'text': text, 'duration': round(len(y) / sr, 3)}
    print(line_id, role, manifest[line_id]['duration'], flush=True)

json.dump(manifest, open(man_path, 'w'), indent=1)
print('lines:', len(manifest))
