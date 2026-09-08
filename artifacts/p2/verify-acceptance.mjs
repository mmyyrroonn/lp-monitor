import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Interface } from 'ethers';
import Database from 'better-sqlite3';
import { loadChainConfig } from '../../dist/config/chain.js';
import { loadAssetVersion } from '../../dist/registry/assets.js';
import { computeWatchScopeId } from '../../dist/ingest/filter-plan.js';
import { SqliteRangeStore } from '../../dist/storage/raw-store.js';
import { SqliteProjectionStore } from '../../dist/storage/projection-store.js';
import { rawLogKey } from '../../dist/storage/manifest.js';
import { v3PoolAbi } from '../../dist/protocols/uniswap-v3/abi.js';
import { v4ManagerAbi } from '../../dist/protocols/uniswap-v4/abi.js';
import { encodeJson } from '../../dist/domain/json.js';
const hash=(value)=>createHash('sha256').update(value).digest('hex');
const save=(name,value)=>writeFileSync('artifacts/p2/'+name,encodeJson(value)+'\n');
const config=loadChainConfig('config/robinhood.json');
const assets=loadAssetVersion('config/watchlist.amc.json');
const scope=computeWatchScopeId(assets,'operations',config);
const registryScope=computeWatchScopeId(assets,'discovery-only',config);
const dbPath=process.argv[2] ?? 'data/p2-acceptance.sqlite';
const db=new Database(dbPath,{readonly:true,fileMustExist:true});
let replay;
try {
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  const raw=new SqliteRangeStore(db);
  const projection=new SqliteProjectionStore(db).read(scope,registryScope,config.version);
  assert.ok(projection,'Projection must match current accepted source');
  assert.equal(projection.qualityErrors.length,0);
  const logs=raw.activeLogs(scope);
  assert.equal(logs.length,650);
  assert.equal(projection.events.length,650);
  const logMap=new Map(logs.map(l=>[rawLogKey(l),l]));
  const abi={v3:new Interface(v3PoolAbi),v4:new Interface(v4ManagerAbi)};
  const counts={};
  for(const event of projection.events){
    const log=logMap.get(rawLogKey(event.ref));
    assert.ok(log);
    const protocol=event.pool.protocol;
    const decoded=abi[protocol].parseLog({topics:[...log.topics],data:log.data});
    assert.ok(decoded);
    const category=protocol+':'+decoded.name;
    counts[category]=(counts[category]??0)+1;
    assert.equal(event.time.exactTimestampSec,null);
    assert.equal(event.time.source,'minute-boundary');
    assert.ok(event.time.minuteStartSec>0);
    if(event.kind==='swap'){
      for(const [field,abiField] of [['rawAmount0','amount0'],['rawAmount1','amount1'],['liquidityAfter','liquidity'],['sqrtPriceX96After','sqrtPriceX96']])
        assert.equal(event[field],decoded.args[abiField]);
      assert.equal(BigInt(event.tickAfter),decoded.args.tick);
      if(protocol==='v4') assert.equal(BigInt(event.effectiveSwapFeePips),decoded.args.fee);
    } else if(event.kind==='liquidity'){
      assert.equal(event.delta,protocol==='v4'?decoded.args.liquidityDelta:decoded.name==='Mint'?decoded.args.amount:-decoded.args.amount);
    }
  }
  const contentTables=['raw_logs','active_logs','log_times','pools','scope_cursors','accepted_ranges','minute_boundaries'];
  const source=new Database('data/p1-acceptance.sqlite',{readonly:true,fileMustExist:true});
  const sourceTables={};
  try{
    for(const table of contentTables){
      const a=hash(encodeJson(source.prepare('select * from '+table+' order by rowid').all()));
      const b=hash(encodeJson(db.prepare('select * from '+table+' order by rowid').all()));
      assert.equal(a,b,'P1 source rows must remain unchanged: '+table);sourceTables[table]=a;
    }
  }finally{source.close();}
  const observedPools=projection.observations.filter(o=>o.lastSwap || o.lastLiquidityAction);
  save('observed-pools.json',{sourceHash:projection.sourceHash,at:projection.end,observations:observedPools});
  replay={database:dbPath,scope,registryScope,sourceHash:projection.sourceHash,counts,activeLogs:logs.length,events:projection.events.length,
    registeredPools:projection.observations.length,observedPools:observedPools.length,qualityErrors:0,exactSeconds:null,timing:'minute',sourceTables,
    independentDecoder:'ethers.Interface against fixed official ABI'};
  save('decode-comparison.json',replay);
} finally {db.close();}
const archivePath='artifacts/p0/raw/2026-09-08T06-10-51-129Z/logs.json';
assert.equal(hash(readFileSync(archivePath)),'13d388eaf6702cf28025e064f0f3fdab2c93ecd50cc5069e36e7a45489223126');
const tests=JSON.parse(readFileSync('artifacts/p2/tests.json','utf8'));
assert.equal(tests.numFailedTests,0);assert.equal(tests.numPendingTests,0);
const checks=JSON.parse(readFileSync('artifacts/p2/check-results.json','utf8'));
for(const c of checks) assert.equal(c.exitCode,0,c.command);
const walk=(dir)=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):[dir+'/'+e.name]);
const sourceFiles=[...walk('src'),...walk('tests'),'package.json','pnpm-lock.yaml','config/robinhood.json','config/watchlist.amc.json'];
const fileHashes=Object.fromEntries(sourceFiles.map(p=>[p,hash(readFileSync(p))]));
const buildHashes=Object.fromEntries(walk('dist').map(p=>[p,hash(readFileSync(p))]));
const acceptance={stage:'P2',at:new Date().toISOString(),passed:true,pathBase:'repository',
 baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
 branch:execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),workingTree:'uncommitted',
 tests:{passed:tests.numPassedTests,failed:tests.numFailedTests,skipped:tests.numPendingTests,files:tests.testResults.length},
 checks,replay,gates:{independentLiveArchiveDecode:true,sourceRowsPreserved:true,exactSecondsNotFabricated:true,p0ArchiveUnchanged:true,tests:true,typecheck:true,build:true,lint:true},
 fileHashes,buildHashes,
 limits:['Offline replay of P1 historical recording, no new RPC calls','Full-scope rebuild and stale checks are O(retained history); not wired into every recorder batch','No current complete pool state, feeGrowth, LP PnL, heat metrics or notifications','Manager-wide P0 fixture tests use explicitly synthetic registration metadata when Initialize is absent; raw payload fields only are historical evidence','All chain observations remain provisional and depend on P1 RPC completeness assumptions']};
save('acceptance.json',acceptance);
console.log(encodeJson({passed:true,tests:acceptance.tests,replay:{...replay,sourceTables:undefined}}));
