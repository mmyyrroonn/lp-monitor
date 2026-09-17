import { openDashboardFixture } from 'file:///E:/lp-monitor/.worktrees/live-runtime-performance/tests/helpers/dashboard-fixture.ts';
import { snapshotWorkerInit } from 'file:///E:/lp-monitor/.worktrees/live-runtime-performance/tests/helpers/dashboard-worker.ts';
import { createSnapshotWorker } from 'file:///E:/lp-monitor/.worktrees/live-runtime-performance/src/dashboard/snapshot-worker.ts';
import { LiveProjectionStore } from 'file:///E:/lp-monitor/.worktrees/live-runtime-performance/src/storage/live-projection.ts';
import { SqliteRangeStore } from 'file:///E:/lp-monitor/.worktrees/live-runtime-performance/src/storage/raw-store.ts';
import { PoolRegistry } from 'file:///E:/lp-monitor/.worktrees/live-runtime-performance/src/registry/pools.ts';
const f = openDashboardFixture();
f.input.registryScopeId = 'r';
f.db.prepare(`insert into pools(scope_id,pool_key,protocol,discovered_raw_log_id,discovered_block_number,discovered_block_hash,payload_json) select 'r',pool_key,protocol,discovered_raw_log_id,discovered_block_number,discovered_block_hash,payload_json from pools where scope_id='s'`).run();
try { new LiveProjectionStore(f.db).sync('s','r','c'); console.log('scope-switch: ok'); }
catch (e) { console.log(JSON.stringify({case:'scope-switch',error:String(e)})); }
// Start the independent dashboard counterexample with a fresh projection cursor.
f.db.prepare('delete from live_projection_cursors where scope_id=?').run('s');
new LiveProjectionStore(f.db).sync('s','r','c');
const messages:any[]=[];
const worker = createSnapshotWorker({postMessage: (m)=>messages.push(m)});
try {
 worker.handle({type:'init',init:snapshotWorkerInit(f)});
 worker.handle({type:'refresh',key:'live'});
 const before=messages.filter(m=>m.type==='summary').at(-1)?.summary;
 const target=f.db.prepare(`select pool_key from pools where scope_id='r' limit 1`).get() as any;
 f.db.prepare(`delete from pools where scope_id='r' and pool_key=?`).run(target.pool_key);
 new LiveProjectionStore(f.db).sync('s','r','c');
 worker.handle({type:'refresh',key:'live'});
 const after=messages.filter(m=>m.type==='summary').at(-1)?.summary;
 const store=new SqliteRangeStore(f.db);
 const expected=new PoolRegistry([...store.pools('r'),...store.pools('s')]).snapshot().length;
 console.log(JSON.stringify({case:'cross-scope-delete',expectedUniquePools:expected,before:before?.tokens.map((t:any)=>({address:t.address,poolCount:t.poolCount})),after:after?.tokens.map((t:any)=>({address:t.address,poolCount:t.poolCount})),messageTypes:messages.map(m=>({type:m.type,code:m.code})),target:target.pool_key},null,2));
} finally {worker.close();f.close();}


