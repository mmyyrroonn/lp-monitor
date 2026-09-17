import Database from 'file:///E:/lp-monitor/.worktrees/live-runtime-performance/node_modules/better-sqlite3/lib/index.js';
import {performance} from 'node:perf_hooks';
const db = new Database(':memory:');
db.exec('create table probe(payload_json TEXT)');
for(const bytes of [6000000,12000000]) {
 db.exec('delete from probe'); db.prepare('insert into probe values (?)').run('a'.repeat(bytes));
 for(const expr of ['length(payload_json)','octet_length(payload_json)']) {
  const query=db.prepare('select '+expr+' as n from probe'); for(let i=0;i<3;i++)query.get();
  const start=performance.now(); let n=0; for(let i=0;i<50;i++)n=query.get().n;
  console.log(JSON.stringify({expr,bytes,result:n,iterations:50,ms:performance.now()-start}));
 }
}
db.close();
