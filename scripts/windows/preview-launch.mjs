import { help, repoRoot } from './local-app.mjs';
import { launchPreview } from './preview-app.mjs';

try {
  if (!help('preview-launch', process.argv.slice(2))) await launchPreview(repoRoot, process.env);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
