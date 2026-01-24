import { cp } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const srcLocales = join(rootDir, 'src', 'locales');
const distLocales = join(rootDir, 'dist', 'locales');

try {
  await cp(srcLocales, distLocales, { recursive: true });
  console.log('✓ Copied locales to dist/');
} catch (error) {
  console.error('Failed to copy locales:', error);
  process.exit(1);
}
