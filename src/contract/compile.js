import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { compileFile } from 'cashc';

export function compileMeanRevertContract({
  sourcePath = new URL('../../contracts/MeanRevertSingleTokenNFTAuthV3.cash', import.meta.url),
  outputPath = resolve('artifacts/MeanRevertSingleTokenNFTAuthV3.json'),
} = {}) {
  const artifact = compileFile(sourcePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(artifact, null, 2));
  return artifact;
}

