import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
try {
  if (!process.argv[2]) throw new Error('manifest path required');
  const manifestPath = resolve(process.argv[2]);
  const fixture = read(manifestPath);
  const capabilities = read('artifacts/p0/capabilities.json');
  const identity = read('artifacts/p0/identity-evidence.json').report;
  const official = read('artifacts/p0/official-source-evidence.json');
  const tests = read('artifacts/p0/tests.json');
  const fixtureTests = read('artifacts/p0/fixture-tests.json');
  const verification = read('artifacts/p0/verification.json');
  const config = read('config/robinhood.json');
  const gates = {
    tests: tests.success === true && tests.numFailedTests === 0 && tests.numPassedTests > 0,
    latestFixtureTests: fixtureTests.success === true && fixtureTests.numPassedTests > 0 && fixtureTests.numFailedTests === 0,
    engineering: verification.typecheckExit === 0 && verification.testExit === 0 && verification.buildExit === 0,
    chainAndCurrentIdentity: capabilities.chainId === 4663 && capabilities.requiredPassed && capabilities.identityPassed && identity?.requiredPassed,
    officialSources: Object.values(official.contracts).every(contract => contract.matchesOfficialDeployment) && official.AMC.matchesOfficialRegistry && identity?.tokens?.AMC?.decimals === official.AMC.decimals,
    realFixture: fixture.chainId === 4663 && fixture.synthetic === false && fixture.acceptancePassed && fixture.completeness === 'complete' && fixture.missing.length === 0,
    seedIdentity: config.v4PoolIds.every(poolId => fixture.seedVerifications?.some(seed => seed.poolId === poolId && seed.status === 'verified')),
    configAndAbi: fixture.configHash === capabilities.configHash && JSON.stringify(fixture.abiHashes) === JSON.stringify(capabilities.abiHashes),
    budgets: [fixture, capabilities].every(report => report.meter.calls <= 150 && report.meter.peakOneSecond <= 5),
    fixtureHashes: fixture.files.every(file => sha256(readFileSync(file.path)) === file.sha256),
    officialHashes: official.sources.every(file => sha256(readFileSync(file.path)) === file.sha256),
  };
  const passed = Object.values(gates).every(Boolean);
  const paths = [manifestPath, 'artifacts/p0/capabilities.json', 'artifacts/p0/identity-evidence.json', 'artifacts/p0/official-source-evidence.json', 'artifacts/p0/tests.json', 'artifacts/p0/fixture-tests.json', 'artifacts/p0/verification.json'];
  const result = { at: new Date().toISOString(), scope: 'P0 only; public RPC endpoint', passed, gates, evidence: paths.map(path => ({ path, sha256: sha256(readFileSync(path)) })), nextStage: passed ? 'P1 (new user window)' : 'P0 remaining acceptance', limitations: ['maxLogsPerResponse remains unknown', 'Factory/Manager deployment boundaries unverified; 9070 remains a candidate', 'Historical samples are not full P5 coverage', 'WS and trace not probed', 'No transactions, wallet connection or permanent service'] };
  writeFileSync('artifacts/p0/acceptance.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = passed ? 0 : 1;
} catch { console.error('P0 acceptance inputs incomplete or invalid'); process.exitCode = 1; }
