import{readFileSync,writeFileSync,readdirSync}from'node:fs';
import{createHash}from'node:crypto';
import{execFileSync}from'node:child_process';
import Database from'better-sqlite3';
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const root='artifacts/p1/live/runs';
const runs=readdirSync(root).map(id=>({path:root+'/'+id+'/manifest.json',...read(root+'/'+id+'/manifest.json')})).sort((a,b)=>a.startedAtMs-b.startedAtMs);
const [first,second,restart,repeat]=runs;
if(runs.length!==4)throw Error('Expected four concrete acceptance runs');
const before=read('artifacts/p1/live/after-second-db.json');
const resumed=read('artifacts/p1/live/after-restart-db.json');
const final=read('artifacts/p1/live/final-db.json');
const cursor=s=>s.cursors.find(c=>c.scope_id===restart.scopeId);
const restartBatches=restart.batches.filter(b=>b.scopeId===restart.scopeId&&b.accepted);
const repeatBatches=repeat.batches.filter(b=>b.scopeId===repeat.scopeId&&b.accepted);
const firstRestartRange=read(root+'/'+restart.runId+'/range-'+restartBatches[0].id+'.json');
const db=new Database('data/p1-acceptance.sqlite',{readonly:true});
const unresolved=db.prepare("select count(distinct a.raw_log_id) as n from active_logs a left join log_times t on t.scope_id=a.scope_id and t.raw_log_id=a.raw_log_id where a.scope_id=? and (t.raw_log_id is null or t.source='unresolved')").get(restart.scopeId).n;
const times=db.prepare('select count(*) as n,sum(case when exact_timestamp_sec is null then 1 else 0 end) as unknownSeconds from log_times where scope_id=?').get(restart.scopeId);
const zeroTimes=db.prepare("select count(distinct r.id) as n from raw_logs r join active_logs a on a.raw_log_id=r.id where a.scope_id=? and r.raw_block_timestamp='0x0'").get(restart.scopeId).n;
const byFilter=db.prepare('select filter_id,from_block,to_block from accepted_ranges where scope_id=? order by filter_id,from_block,to_block').all(restart.scopeId);
const covered=new Map();const coverageGaps=[];
for(const r of byFilter){const prior=covered.get(r.filter_id);if(prior!==undefined&&r.from_block>prior+1)coverageGaps.push(r);covered.set(r.filter_id,Math.max(prior??-1,r.to_block));}
db.close();
const boundaryInLive=before.boundaries.filter(b=>b.scope_id===second.scopeId&&b.timestamp_sec>=Math.ceil(second.startedAtMs/1000)&&b.timestamp_sec<=Math.floor(second.finishedAtMs/1000));
const source=read('artifacts/p1/final-source.json'),build=read('artifacts/p1/live/final-build.json'),tests=read('artifacts/p1/final-tests.json');
const gates={
finalChecks:Object.values(read('artifacts/p1/checks/final-status.json')).every(c=>c===0),
tests:tests.success&&tests.numFailedTests===0&&tests.numPendingTests===0,
sourceHashes:source.files.every(f=>hash(f.path)===f.sha256),
buildHashes:build.files.every(f=>hash(f.path)===f.sha256),
p0EvidenceUnchanged:execFileSync('git',['diff','--name-only','--','artifacts/p0'],{encoding:'utf8'}).trim()==='',
historicalArchiveAudit:read('artifacts/p1/p0-archive-audit.json').passed===true,
firstFailurePreserved:first.status==='incomplete'&&first.counts.operationBatches===0,
fiveMinuteRecording:second.finishedAtMs-second.startedAtMs>=300000&&second.counts.operationBatches>0,
atLeastThreeActualLiveBoundaries:boundaryInLive.length>=3,
restartExitZero:read('artifacts/p1/live/restart-exit.json').code===0&&restart.status==='complete',
restartScopeStable:second.scopeId===restart.scopeId,
restartFromSavedOverlap:BigInt(restartBatches[0].fromBlock)===BigInt(cursor(before).block_number)-19n,
restartPreviousAnchorMatches:firstRestartRange.previous?.hash===cursor(before).block_hash,
restartAdvanced:cursor(resumed).block_number>cursor(before).block_number,
oldRangeRepeatExitZero:read('artifacts/p1/live/repeat-exit.json').code===0&&repeat.status==='complete',
explicitOldRangeActuallyRead:repeatBatches.length===1&&repeatBatches[0].fromBlock==='57622597'&&repeatBatches[0].toBlock==='57622696',
oldRangeDoesNotRewind:cursor(final).block_number===cursor(resumed).block_number,
oldRangeIdempotent:repeat.revisions.filter(r=>r.cause==='range').every(r=>r.added===0&&r.removed===0&&r.retimed===0),
noScopeCoverageGaps:coverageGaps.length===0,
databaseIntegrity:final.integrity.every(r=>r.quick_check==='ok')&&final.foreignKeys.length===0,
minuteBoundariesValid:final.invalidBoundaries===0,
activeTimesResolved:unresolved===0,
unknownSecondsNotFabricated:times.n===times.unknownSeconds,
realZeroTimestampLogsPresent:zeroTimes>0,
noRemainingReviewBlockers:readFileSync('docs/reviews/p1-final-review.md','utf8').includes('No remaining confirmed blocking findings')
};
const result={
at:new Date().toISOString(),stage:'P1',passed:Object.values(gates).every(Boolean),pathBase:'repository',
baseCommit:'af85a228d8945fbd01d6742c17a9a3559ee4fbb6',branch:'feat/p1-recorder',workingTree:'uncommitted',
gates,tests:{passed:tests.numPassedTests,failed:tests.numFailedTests,suites:tests.numPassedTestSuites},
live:{sourceAlias:'robinhood-public',liveBoundariesDuringFiveMinuteRun:boundaryInLive.length,minuteBoundaryCount:final.counts.minute_boundaries,activeOperationLogs:times.n,zeroTimestampOperationLogs:zeroTimes,unresolvedOperationLogs:unresolved,acceptedTip:cursor(final),runs:runs.map(r=>({manifest:r.path,sha256:hash(r.path),status:r.status,counts:r.counts,meter:r.meter,failures:r.failures})),firstRestartFrom:restartBatches[0].fromBlock,priorCursor:cursor(before),repeatRevisions:repeat.revisions},
evidence:{source:'artifacts/p1/final-source.json',build:'artifacts/p1/live/final-build.json',checks:'artifacts/p1/checks/final-status.json',tests:'artifacts/p1/final-tests.json',databaseSnapshot:'artifacts/p1/live/final-db.json',databaseLocal:'data/p1-acceptance.sqlite',review:'docs/reviews/p1-final-review.md'},
limitations:['RPC consistency assumption; provisional, not independent chain verification','maxLogsPerResponse remains unknown/null; local filter cap1000 and log guard5000 are distinct','Five-minute run ended incomplete at deadline; accepted data preserved; final-build restart and explicit repeat independently exit0','P1 change sets only; P2 business decoding, P3 heat and P4 alerts not implemented','No long-term or complete historical acceptance; no wallet, trade or permanent service']
};
writeFileSync('artifacts/p1/acceptance.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({passed:result.passed,gates,tests:result.tests,live:{boundaries:result.live.minuteBoundaryCount,actualLiveBoundaries:boundaryInLive.length,operations:times.n,zeroTimes,unresolved,restartFirstFrom:restartBatches[0].fromBlock,repeatRevisions:repeat.revisions}},null,2));
if(!result.passed)process.exitCode=1;
