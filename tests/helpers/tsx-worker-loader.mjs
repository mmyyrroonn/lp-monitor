// A worker thread does not inherit the test runner's TypeScript loader, and `--import tsx` does not
// register itself on a worker's thread. Registering it from a module the worker actually imports is
// what makes the worker run the shipped `.ts` module rather than a copy of its body.
import { register } from 'tsx/esm/api';
register();
