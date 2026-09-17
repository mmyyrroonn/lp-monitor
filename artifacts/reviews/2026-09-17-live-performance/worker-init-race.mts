import { openDashboardFixture } from 'file:///E:/lp-monitor/.worktrees/live-runtime-performance/tests/helpers/dashboard-fixture.ts';
import { snapshotWorkerInit } from 'file:///E:/lp-monitor/.worktrees/live-runtime-performance/tests/helpers/dashboard-worker.ts';
import { createSnapshotWorker } from 'file:///E:/lp-monitor/.worktrees/live-runtime-performance/src/dashboard/snapshot-worker.ts';
import { LiveProjectionStore } from 'file:///E:/lp-monitor/.worktrees/live-runtime-performance/src/storage/live-projection.ts';
import { SqliteRangeStore } from 'file:///E:/lp-monitor/.worktrees/live-runtime-performance/src/storage/raw-store.ts';
const f=openDashboardFixture();
const target:any=f.db.prepare('select pool_key from pools limit 1').get();
const messages:any[]=[];
const worker=createSnapshotWorker({postMessage:m=>messages.push(m)});
const original=SqliteRangeStore.prototype.pools;
let calls=0;
// Interleave a legitimate committed writer after the catalogue SELECTs and before journalPosition.
SqliteRangeStore.prototype.pools=function(scopeId:string) {
 const rows=original.call(this,scopeId);
 if(++calls===2)f.db.prepare('delete from pools where scope_id=? and pool_key=?').run('s',target.pool_key);
 return rows;
};
try { worker.handle({type:'init',init:snapshotWorkerInit(f)}); }
finally { SqliteRangeStore.prototype.pools=original; }
try {
 new LiveProjectionStore(f.db).sync('s','s','c');
 worker.handle({type:'refresh',key:'live'});
 const raced=messages.filter(m=>m.type==='summary').at(-1)?.summary;
 const referenceMessages:any[]=[];
 const fresh=createSnapshotWorker({postMessage:m=>referenceMessages.push(m)});
 try {
  fresh.handle({type:'init',init:snapshotWorkerInit(f)});
  fresh.handle({type:'refresh',key:'live'});
  const reference=referenceMessages.filter(m=>m.type==='summary').at(-1)?.summary;
  console.log(JSON.stringify({case:'init-read-journal-race',rowsAfterDelete:f.db.prepare('select count(*) as n from pools').get(),raced:raced?.tokens.map((t:any)=>({address:t.address,poolCount:t.poolCount})),fresh:reference?.tokens.map((t:any)=>({address:t.address,poolCount:t.poolCount})),messages:messages.map(m=>({type:m.type,code:m.code}))},null,2));
 } finally {fresh.close();}
} finally {worker.close(); f.close();}
