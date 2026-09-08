import Database from 'better-sqlite3';
import {readFileSync,writeFileSync} from 'node:fs';
const db=new Database('data/p1-acceptance.sqlite',{readonly:true});
const snapshot=db.transaction(()=>({
 capturedAt:new Date().toISOString(),
 integrity:db.pragma('quick_check'),
 foreignKeys:db.pragma('foreign_key_check'),
 cursors:db.prepare('select * from scope_cursors').all(),
 counts:Object.fromEntries(['ingest_batches','fetch_shards','raw_logs','active_logs','minute_boundaries','anchors','log_times','pools','checkpoints','runs'].map(t=>[t,db.prepare('select count(*) as n from '+t).get().n])),
 times:db.prepare('select scope_id,source,count(*) as n,min(minute_start_sec) as firstMinute,max(minute_start_sec) as lastMinute from log_times group by scope_id,source').all(),
 minutes:db.prepare('select scope_id,minute_start_sec,count(*) as n from log_times group by scope_id,minute_start_sec order by minute_start_sec').all(),
 boundaries:db.prepare('select * from minute_boundaries order by timestamp_sec').all(),
 invalidBoundaries:db.prepare('select count(*) as n from minute_boundaries where before_number + 1 != at_number or first_block != at_number or before_timestamp_sec >= timestamp_sec or at_timestamp_sec < timestamp_sec').get().n,
 activeByScope:db.prepare('select scope_id,count(distinct raw_log_id) as n from active_logs group by scope_id').all(),
 pools:db.prepare('select scope_id,protocol,count(*) as n from pools group by scope_id,protocol').all(),
 accepted:db.prepare('select scope_id,filter_id,min(from_block) as firstBlock,max(to_block) as lastBlock,count(*) as ranges from accepted_ranges group by scope_id,filter_id').all(),
 runs:db.prepare('select id,scope_id,started_at_ms,finished_at_ms,status from runs order by started_at_ms').all()
}))();
db.close();
writeFileSync(process.argv[2]??'artifacts/p1/live/db-snapshot.json',JSON.stringify(snapshot,null,2)+'\n');
console.log(JSON.stringify({counts:snapshot.counts,cursors:snapshot.cursors,times:snapshot.times,invalidBoundaries:snapshot.invalidBoundaries,runs:snapshot.runs},null,2));
