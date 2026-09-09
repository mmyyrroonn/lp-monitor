import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {loadChainConfig} from '../../dist/config/chain.js';
import {loadAssetVersion} from '../../dist/registry/assets.js';
import {computeWatchScopeId} from '../../dist/ingest/filter-plan.js';
import {SqliteProjectionStore} from '../../dist/storage/projection-store.js';
import {SqliteMetricStore,buildMetricsReport} from '../../dist/storage/metric-store.js';
import {loadMetricMetadata} from '../../dist/metrics/metadata.js';
import {openDatabase} from '../../dist/storage/database.js';
import {encodeJson} from '../../dist/domain/json.js';
import {rankPools} from '../../dist/metrics/ranking.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
const save=(name,v)=>writeFileSync('artifacts/p3/'+name,encodeJson(v)+'\n');
mkdirSync('artifacts/p3',{recursive:true});
const sourcePath='data/p2-acceptance.sqlite',targetPath='data/p3-acceptance.sqlite';
const original=new Database(sourcePath,{readonly:true,fileMustExist:true});
const p1Tables=['ingest_batches','fetch_shards','raw_logs','accepted_ranges','active_logs','scope_cursors','anchors','minute_boundaries','log_times','pools','range_invalidations','runs','checkpoints'];
const sourceTables={};
for(const table of p1Tables) sourceTables[table]=hash(encodeJson(original.prepare('select * from '+table+' order by rowid').all()));
if(!existsSync(targetPath)) await original.backup(targetPath);
const db=openDatabase(targetPath);
let report;
try {
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
  for(const table of p1Tables) assert.equal(hash(encodeJson(db.prepare('select * from '+table+' order by rowid').all())),sourceTables[table],table+' copy must preserve P1');
  const config=loadChainConfig('config/robinhood.json'),assets=loadAssetVersion('config/watchlist.amc.json');
  const scopeId=computeWatchScopeId(assets,'operations',config),registryScopeId=computeWatchScopeId(assets,'discovery-only',config);
  const projection=new SqliteProjectionStore(db).rebuild(scopeId,registryScopeId,config.version);
  assert.equal(projection.qualityErrors.length,0);
  report=buildMetricsReport(db,{scopeId,registryScopeId,configVersion:config.version,assets,usdg:config.tokens.USDG,metadata:loadMetricMetadata('config/metric-metadata.json')});
  new SqliteMetricStore(db).replace(report);
  assert.equal(report.valuations.length,projection.events.filter(e=>e.kind==='swap').length);
  assert.equal(report.rwa[0].blockRangeActivity.swapCount,report.valuations.length);
  assert.equal(report.rwa[0].blockRangeActivity.txCount,new Set(report.valuations.map(v=>v.transactionHash)).size);
  assert.equal(report.qualityErrors.length,0);
  assert.ok(report.coverage.some(c=>c.complete));
  for(const v of report.valuations) {
    const swap=projection.events.find(e=>e.kind==='swap'&&e.ref.blockHash===v.ref.blockHash&&e.ref.logIndex===v.ref.logIndex);
    if(v.pricingSide==='usdg') {
      const raw=swap.tokenIn===config.tokens.USDG?swap.amountIn:swap.amountOut;
      assert.equal(v.usdgNotionalRaw,raw);
      assert.equal(v.usdMicros,raw); // explicit cached USDG decimals=6
    }
    if(v.quoteEvidence) {
      const q=v.quoteEvidence;
      assert.ok(q.effectiveAt.blockNumber<swap.ref.blockNumber || q.effectiveAt.blockNumber===swap.ref.blockNumber&&q.effectiveAt.logIndex<swap.ref.logIndex);
      const upper=(v.time.exactTimestampSec??v.time.minuteStartSec+59)-(q.time.exactTimestampSec??q.time.minuteStartSec);
      assert.ok(upper>=0&&upper<=60);
    }
  }
  save('amc-heat.json',{...report,windows:report.windows.map(({minutes,natural5mBuckets,...w})=>({...w,minuteCount:minutes.length,natural5mBucketCount:natural5mBuckets.length}))});
  save('coverage.json',{sourceHash:report.sourceHash,at:report.at,coverage:report.coverage});
  save('rank.json',{sourceHash:report.sourceHash,at:report.at,volume:rankPools(report.windows,'volume5mClosed').map(w=>({poolId:w.poolId,closed5m:w.recentClosed5x1m})),multiplier:rankPools(report.windows,'volumeMultiplier').map(w=>({poolId:w.poolId,closed1m:w.recentClosed1m}))});
} finally {db.close();}
for(const table of p1Tables) assert.equal(hash(encodeJson(original.prepare('select * from '+table+' order by rowid').all())),sourceTables[table],table+' source unchanged');
original.close();
save('source-db.json',{sourcePath,targetPath,sourceTables,rpcCalls:0,note:'Historical P2 SQLite online backup; P3 uses offline replay only.'});
function snapshot(dir){const result={};for(const e of readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+e.name;if(e.isDirectory())Object.assign(result,snapshot(path));else result[path]=hash(readFileSync(path));}return result;}
const cli=[];
for(const args of [ ['metrics','--db',targetPath,'--rwa','AMC','--window','5m','--out','artifacts/p3/cli-metrics.json'],['rank','--db',targetPath,'--sort','volume5mClosed','--out','artifacts/p3/cli-rank.json'] ]){
  try {const stdout=execFileSync(process.execPath,['dist/cli.js',...args],{encoding:'utf8'});cli.push({args,exitCode:0,stdout:JSON.parse(stdout)});}
  catch(error){if(error.status!==4)throw error;cli.push({args,exitCode:4,stdout:JSON.parse(error.stdout.toString())});}
}
const summary={version:report.version,sourceHash:report.sourceHash,projectionSourceHash:report.projectionSourceHash,at:report.at,eventsValued:report.valuations.length,unpriced:report.valuations.filter(v=>v.usdMicros===null).length,quotes:report.quotes.length,metricPools:report.windows.length,closedMinutes:report.coverage.filter(c=>c.complete).length,nonClosedMinutes:report.coverage.filter(c=>!c.complete).length,baselineReadyPools:report.windows.filter(w=>w.recentClosed1m?.volumeMultiplier!=null).length,blockRangeActivity:{swapCount:report.rwa[0].blockRangeActivity.swapCount,txCount:report.rwa[0].blockRangeActivity.txCount},rpcCalls:0,cli,sourceFiles:snapshot('src'),buildFiles:snapshot('dist')};
save('acceptance.json',summary);
console.log(encodeJson({...summary,sourceFiles:undefined,buildFiles:undefined}));
