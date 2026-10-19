import { help, launch, repoRoot } from './local-app.mjs';

try {
  if (!help('local-launch', process.argv.slice(2))) await launch(repoRoot, process.env);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
