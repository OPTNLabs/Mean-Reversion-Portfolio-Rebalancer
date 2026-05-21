export const quantumrootCustomizationSpikes = [
  {
    area: 'constructor params',
    status: 'safe to parameterize',
    notes:
      'Candidate paths: alternate recovery leaves, token-aware address commitments, signer slots, and recovery delay windows.',
  },
  {
    area: 'artifact generation',
    status: 'requires contract-specific templates',
    notes:
      'Quantumroot customizations that change the compiled bytecode or internal address derivation should be treated as new artifacts, not runtime toggles.',
  },
  {
    area: 'vault policy',
    status: 'can be modelled separately',
    notes:
      'The wallet can keep policy metadata outside the covenant, but the covenant must still enforce the exact successor outputs.',
  },
  {
    area: 'quantum signer rotation',
    status: 'likely needs a migration branch',
    notes:
      'If the signer commitment changes after deployment, recovery and spend paths should be versioned to avoid ambiguous authority.',
  },
];

export function renderQuantumrootSpikeReport() {
  const lines = ['Quantumroot feasibility spike', ''];
  for (const item of quantumrootCustomizationSpikes) {
    lines.push(`- ${item.area}: ${item.status}`);
    lines.push(`  ${item.notes}`);
  }
  return lines.join('\n');
}

