/**
 * Runs once when the Next server starts and must finish before it serves requests.
 *
 * Next compiles this file for both the Node.js and Edge runtimes. Env validation uses Node APIs
 * (process.exit), so it lives behind a literal `NEXT_RUNTIME` check that lets the bundler drop it
 * from the Edge bundle. This is the one place outside env.ts allowed to read process.env.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('./instrumentation-node');
    registerNode();
  }
}
