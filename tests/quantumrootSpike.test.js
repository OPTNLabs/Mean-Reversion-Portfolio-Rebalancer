import test from 'node:test';
import assert from 'node:assert/strict';

import { renderQuantumrootSpikeReport } from '../src/vaulting/quantumrootSpike.js';

test('quantumroot spike report documents the research scope', () => {
  const report = renderQuantumrootSpikeReport();
  assert.match(report, /Quantumroot feasibility spike/);
  assert.match(report, /constructor params/);
});

