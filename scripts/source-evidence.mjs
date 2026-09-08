import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = 'artifacts/p0/upstream';
mkdirSync(root, { recursive: true });
const config = JSON.parse(readFileSync('config/robinhood.json', 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const at = new Date().toISOString();
async function capture(url, name) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'lp-monitor-p0-source-check' } });
  if (!response.ok) throw new Error('public-source-unavailable');
  const content = await response.text(); const path = `${root}/${name}`; writeFileSync(path, content);
  return { url, at, path, sha256: hash(content), content };
}
try {
  let commit = null; let commits = null;
  try {
    commits = await capture('https://api.github.com/repos/Uniswap/contracts/commits?path=deployments/4663.md&per_page=1', 'deployment-commits.json');
    const candidate = JSON.parse(commits.content)[0].sha;
    if (/^[0-9a-f]{40}$/.test(candidate)) commit = candidate;
  } catch { /* Commit API is optional; the saved source snapshot is SHA256-bound. */ }
  const deployment = await capture(`https://raw.githubusercontent.com/Uniswap/contracts/${commit ?? 'main'}/deployments/4663.md`, 'deployments-4663.md');
  const stocks = await capture('https://api.robinhood.com/rhj/assets', 'stock-assets.json');
  const amc = JSON.parse(stocks.content).assets.find(asset => asset.tokenSymbol === 'AMC');
  const notice = await capture('https://raw.githubusercontent.com/labrinyang/lp-terminal/c127e70a2a21ca40f5668d155587e36e80049277/LICENSE', 'lp-terminal-LICENSE');
  const sources = [commits, deployment, stocks, notice].filter(Boolean).map(({ content, ...evidence }) => evidence);
  const contracts = Object.fromEntries(['v3Factory', 'v4Manager', 'stateView'].map(key => [key, { address: config[key], matchesOfficialDeployment: deployment.content.toLowerCase().includes(config[key].toLowerCase()) }]));
  const result = { at, commit, sources, contracts, AMC: { address: config.tokens.AMC, matchesOfficialRegistry: amc?.deployments?.some(d => d.chainId === 4663 && d.contractAddress.toLowerCase() === config.tokens.AMC), decimals: amc?.tokenDecimals ?? null, status: amc?.status ?? null }, runtime: { node: process.version, platform: process.platform, arch: process.arch }, packageJsonSha256: hash(readFileSync('package.json')), lockfileSha256: hash(readFileSync('pnpm-lock.yaml')) };
  writeFileSync('artifacts/p0/official-source-evidence.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ contracts, AMC: result.AMC, evidence: 'artifacts/p0/official-source-evidence.json' }, null, 2));
} catch { console.error('Official source check failed; no endpoint details emitted'); process.exitCode = 1; }
