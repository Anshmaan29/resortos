// Copies OpenCV.js into public/vendor so it is served from our own origin and only
// downloaded when a capture screen opens (spec §19.4). Not committed to git.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkg = require.resolve('@techstark/opencv-js/package.json');
const { version } = require('@techstark/opencv-js/package.json');
const source = join(dirname(pkg), 'dist', 'opencv.js');
const targetDir = join(import.meta.dirname, '..', 'public', 'vendor');
mkdirSync(targetDir, { recursive: true });
copyFileSync(source, join(targetDir, 'opencv.js'));
console.log(`opencv.js ${version} → public/vendor (${Math.round(statSync(source).size / 1024 / 1024)} MB)`);
