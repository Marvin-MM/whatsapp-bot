// Run as a child process by test/unit/env.test.ts to prove startup exits naming the bad variable.
import { assertEnv } from '@/lib/env';

assertEnv();
process.stdout.write('env ok\n');
