import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openDatabase } from '../../dist/storage/database.js';
import { SqliteProjectionStore } from '../../dist/storage/projection-store.js';
import { buildMetricsReport } from '../../dist/storage/metric-store.js';
import { loadChainConfig } from '../../dist/config/chain.js';
import { loadAssetVersion } from '../../dist/registry/assets.js';
import { loadMetricMetadata } from '../../dist/metrics/metadata.js';
import { computeWatchScopeId } from '../../dist/ingest/filter-plan.js';
import { encodeJson } from '../../dist/domain/json.js';
import { decodeSignalState } from '../../dist/signals/codec.js';
import { initialSignalConfig, signalConfigVersion } from '../../dist/signals/config.js';
import { evaluateSignal, initialSignalSnapshot } from '../../dist/signals/engine.js';
import { projectSignals, commitSignalDecision, retractSignals } from '../../dist/signals/project.js';
import { AlertOutbox } from '../../dist/notify/outbox.js';
import { createJsonlSink } from '../../dist/notify/jsonl.js';
import { formatAlert } from '../../dist/notify/format.js';

mkdirSync('artifacts/p4-review',{recursive:true});
const hash=v=>createHash('sha256').update(v).digest('hex');
const save=(name,value)=>writeFileSync('artifacts/p4-review/'+name,encodeJson(value)+'\n');
const sourcePath='data/p3-acceptance.sqlite',targetPath='data/p4-review-acceptance.sqlite';
const source=new Database(sourcePath,{readonly:true,fileMustExist:true});
const tables=['ingest_batches','fetch_shards','raw_logs','accepted_ranges','active_logs','scope_cursors','anchors','minute_boundaries','log_times','pools','range_invalidations','runs','checkpoints'];
const snapshot=db=>Object.fromEntries(tables.map(t=>[t,hash(encodeJson(db.prepare('select * from '+t+' order by rowid').all()))]));
const before=source.transaction(()=>snapshot(source))();
if(!existsSync(targetPath))await source.backup(targetPath);
const db=openDatabase(targetPath);
let historical;
try {
 assert.deepEqual(snapshot(db),before,'backup must preserve P1 source records');
 // Reset only derived P4 state in this dedicated disposable acceptance copy.
 db.transaction(()=>{for(const table of ['signal_snapshots','signal_cursors','signal_evaluations','alerts','alert_outbox'])db.exec('delete from '+table);})();
 const chain=loadChainConfig('config/robinhood.json'),assets=loadAssetVersion('config/watchlist.amc.json');
 const input={scopeId:computeWatchScopeId(assets,'operations',chain),registryScopeId:computeWatchScopeId(assets,'discovery-only',chain),configVersion:chain.version,assets,usdg:chain.tokens.USDG,metadata:loadMetricMetadata('config/metric-metadata.json')};
 new SqliteProjectionStore(db).rebuild(input.scopeId,input.registryScopeId,input.configVersion);
 const metrics=buildMetricsReport(db,input);
 const initialStart=performance.now();
 projectSignals(db,input,initialSignalConfig,{batchId:'p4-historical-'+metrics.sourceHash,observedAtMs:0,captureMode:'backfill'});
 const initialProjectMs=performance.now()-initialStart;
 const projectUnchangedMs=[], rebuildAndProjectMs=[];
 const countAudit=()=>db.prepare('select count(*) n from signal_evaluations').get().n;
 const auditBefore=countAudit();
 for(let i=0;i<3;i++){
   const start=performance.now();
   assert.equal(projectSignals(db,input,initialSignalConfig,{batchId:'unchanged-'+i,observedAtMs:i,captureMode:'backfill'}).length,0);
   projectUnchangedMs.push(performance.now()-start);
 }
 for(let i=0;i<3;i++){
   const start=performance.now();
   new SqliteProjectionStore(db).rebuild(input.scopeId,input.registryScopeId,input.configVersion);
   assert.equal(projectSignals(db,input,initialSignalConfig,{batchId:'rebuild-unchanged-'+i,observedAtMs:i,captureMode:'backfill'}).length,0);
   rebuildAndProjectMs.push(performance.now()-start);
 }
 save('performance.json',{initialProjectMs,projectUnchangedMs,rebuildAndProjectMs,auditRowsBefore:auditBefore,auditRowsAfter:countAudit(),pools:metrics.windows.length,swaps:metrics.valuations.length,rpcCalls:0,note:'Same local historical SQLite snapshot. Rebuild+project excludes RPC, fetch decoding/timing, file delivery and growing-history cost; no live latency guarantee. Full metrics freshness scan remains deliberate.'});
 let attempts=0;
 assert.deepEqual(await new AlertOutbox(db).deliverPending(()=>{attempts++;}),{sent:0,failed:0});
 assert.equal(attempts,0);
 const recordRows=db.prepare('select payload_json from alerts order by id').all();
 const historicalAlerts=recordRows.map(r=>decodeSignalState(r.payload_json));
 assert.deepEqual(snapshot(db),before,'P4 must preserve copied P1 records');
 assert.equal(db.pragma('integrity_check',{simple:true}),'ok');
 historical={sourcePath,targetPath,sourceHash:metrics.sourceHash,at:metrics.at,pools:metrics.windows.length,swaps:metrics.valuations.length,unpriced:metrics.valuations.filter(v=>v.usdMicros===null).length,
 closedMinutes:metrics.coverage.filter(c=>c.complete).length,
 alerts:historicalAlerts.length,alertKinds:historicalAlerts.map(a=>a.kind),
 liveDeliveries:attempts,rpcCalls:0,note:'Historical source only; observedAtMs=0 is a synthetic offline evaluation receipt marker, not historical arrival evidence.'};
 save('historical-alerts.json',{historical,alerts:historicalAlerts});
} finally {db.close();}
assert.deepEqual(source.transaction(()=>snapshot(source))(),before,'source unchanged');
source.close();
save('source-db.json',{sourcePath,targetPath,p1TableHashes:before,rpcCalls:0});

const demo=openDatabase(':memory:');
const pool={chainId:4663,protocol:'v3',address:'0x'+'1'.repeat(40)};
const fields={usdgNotionalRaw:null,rawNotional:null,swapCount:10,txCount:9,addCount:2,removeCount:1,zeroDeltaCount:0,activeMinutes:1,
 baselineSampleCount:0,baselineMedian:null,baselineMedianNumerator:null,baselineMedianDenominator:null,baselineUnit:null,volumeMultiplier:null};
const bucket=(startSec,amount)=>({...fields,startSec,endSec:startSec+300,status:'closed',usdMicros:BigInt(amount)*1000000n});
function makeInput(now,five,minuteAmount=0){
 const partial={...fields,minuteStartSec:Math.floor(now/60)*60,status:'partial',fromBlock:BigInt(now),toBlock:BigInt(now),reasons:['watermark-partial'],usdMicros:BigInt(minuteAmount)*1000000n};
 const minutes=five.flatMap(b=>Array.from({length:5},(_,i)=>({...fields,status:'closed',fromBlock:BigInt(b.startSec+i*60),toBlock:BigInt(b.startSec+i*60+59),reasons:[],minuteStartSec:b.startSec+i*60,usdMicros:b.usdMicros/5n})));
 return {pool,batchId:'synthetic-'+now,observedAtMs:now*1000,endAnchor:{number:BigInt(now),hash:'0x'+hash(String(now)),timestampSec:now},watermarkSec:now,coverage:'complete',
 presentation:{rwaSymbol:'AMC (synthetic)',pairLabel:'AMC / USDG',associatedTokens:['MEME (synthetic)'],evidenceTxs:['0x'+hash('synthetic tx')],liquidityNote:'Synthetic observed Swap L, no verified withdrawal amount'},
 metrics:{pool,poolId:'4663:v3:'+pool.address,minutes:[...minutes,partial],natural5mBuckets:five,partialCurrent:partial,naturalClosed5m:five.at(-1)??null,recentClosed1m:minutes.at(-1)??null,recentClosed5x1m:now%300===0?(five.at(-1)??null):null,unknownTimeBlockCounts:[]}};
}
let previous=initialSignalSnapshot();
const history=Array.from({length:12},(_,i)=>bucket(i*300,10000));
const decide=(input)=>{const d=evaluateSignal(previous,input,initialSignalConfig);previous=d.nextSnapshot;demo.transaction(()=>{for(const draft of d.alertDrafts??[])commitSignalDecision(demo,'synthetic',{...d,alertDraft:draft},'synthetic');})();return d;};
decide(makeInput(3601,[],25000));
let five=[...history,bucket(3600,120000)];
decide(makeInput(4190,five));
five=[...five,bucket(3900,300000)];
assert.ok(decide(makeInput(4200,five)).alertDraft.reasons.includes('upgrade'));
for(const start of [4200,4500,4800]){five=[...five,bucket(start,10000)];decide(makeInput(start+300,five));}
five=[...five,bucket(5100,120000)];
assert.equal(decide(makeInput(5400,five)).alertDraft.kind,'reheat');
retractSignals(demo,'synthetic',{batchId:'synthetic-repair',observedAtMs:5401000,captureMode:'synthetic'},'synthetic-fork-evidence-removed');
const records=demo.prepare('select payload_json from alert_outbox order by sequence').all().map(r=>({...decodeSignalState(r.payload_json),fixtureSource:'synthetic-engine',captureMode:'synthetic'}));
const kinds=new Set(records.map(a=>a.kind));
for(const k of ['candidate','hot','cooling','reheat','retracted'])assert.ok(kinds.has(k),k);
assert.deepEqual(await new AlertOutbox(demo).deliverPending(()=>{throw Error('synthetic must not enter live sink');}),{sent:0,failed:0});
const example=records.find(a=>a.kind==='reheat');
records.push({...example,id:hash('liquidity-format-only'),revision:1,kind:'liquidity-watch',status:'provisional',fixtureSource:'synthetic-format-only',
 reasons:['format-example-only','observed-liquidity-actions-not-withdrawal-value']});
writeFileSync('artifacts/p4-review/alerts.jsonl','');
const sink=createJsonlSink('artifacts/p4-review/alerts.jsonl');
for(const a of records)await sink(a);
writeFileSync('artifacts/p4-review/rendered.txt','合成离线示例，不是当前行情或已验证收益。liquidity-watch 仅为格式示例，未配置自动触发规则。\n\n'+records.map(formatAlert).join('\n\n---\n\n')+'\n');
demo.close();
const files=dir=>Object.fromEntries(readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?Object.entries(files(dir+'/'+e.name)):[[dir+'/'+e.name,hash(readFileSync(dir+'/'+e.name))]]));
save('acceptance.json',{status:'passed',scope:'P4 offline engineering acceptance',historical,synthetic:{records:records.length,engineKinds:[...kinds],formatOnlyKinds:['liquidity-watch'],receiptSeparationSeconds:10,logicalBucketSeparationSeconds:300},
 signalConfigVersion:signalConfigVersion(initialSignalConfig),sourceFiles:files('src'),buildFiles:files('dist'),
 limitations:['No new RPC or timed live validation; P6 remains pending.','No automatic liquidity-watch threshold is invented.','History repairs conservatively retract dependent provisional evidence and re-evaluate current conditions; no P5 historical strategy evaluation.','Notification delivery may duplicate id/revision after a file-write/ack crash.']});
console.log(encodeJson({historical,syntheticRecordCount:records.length,status:'passed'}));