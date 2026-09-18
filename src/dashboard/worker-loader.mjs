// A worker thread does not inherit the loader of the process that started it, and `--import tsx`
// does not register itself on a worker's thread either -- both were measured, not assumed. Node's
// own type stripping is not a substitute: it rejects the parameter properties this repository uses.
// Registering tsx from a module the worker imports for itself is what lets the source tree's worker
// run at all, so `pnpm lp dashboard` reads the shipped module instead of a copy of its body.
import { register } from 'tsx/esm/api';
register();
