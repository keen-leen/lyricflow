#!/usr/bin/env python3
"""Summarize raw controlled measurements; no third-party dependencies."""
import json
import math
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parent

def read(name):
    return json.loads((ROOT / name).read_text())

def p95(values):
    return sorted(values)[math.ceil(len(values) * .95) - 1] if values else None

phases = {name: read(f'ui/{name}.json') for name in ['baseline', 'cache-requests', 'optimized']}
summary = {'ui': [], 'requests': []}
for scenario in ['idle', 'paused', 'playing-closed', 'playing-open', 'long-scroll']:
    row = {'scenario': scenario, 'phases': {}}
    for phase, data in phases.items():
        samples = [r for r in data['rows'] if r['scenario'] == scenario]
        assert len(samples) == 3, (phase, scenario, 'missing trials')
        row['phases'][phase] = {
            'medianUpdates': median(r['updates'] for r in samples),
            'medianUpdateMs': median(r['updateUs'] for r in samples) / 1000,
            'medianProgressCalls': median(r['progressCalls'] for r in samples),
            'lyricDelayP95Ms': p95([v for r in samples for v in r['lyricDelayMs']]),
            'medianShellCpuTicks': median(r['shellCpuTicks'] for r in samples),
        }
    before, after = row['phases']['cache-requests'], row['phases']['optimized']
    old_delay, new_delay = before['lyricDelayP95Ms'], after['lyricDelayP95Ms']
    row['lowerMedianTime'] = after['medianUpdateMs'] < before['medianUpdateMs']
    row['delayWithinBudget'] = old_delay is None or new_delay is not None and new_delay <= old_delay + 20
    summary['ui'].append(row)
for scenario in ['stale-cache', 'slow-primary']:
    summary['requests'].append({'scenario': scenario, **{
        phase: median(r['firstVisibleMs'] for r in read(f'requests-{phase}.json')['rows'] if r['scenario'] == scenario)
        for phase in ['baseline', 'optimized']}})
for phase in ['baseline', 'optimized']:
    path = ROOT / f'ui/{phase}-actors.json'
    if path.exists():
        summary[f'{phase}Actors'] = read(f'ui/{phase}-actors.json')['actorRows']
(ROOT / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(summary, ensure_ascii=False, indent=2))
