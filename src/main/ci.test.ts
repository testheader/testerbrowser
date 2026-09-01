import fs from 'fs';
import path from 'path';

test('build.yml has no linux build job', () => {
  const yml = fs.readFileSync(path.join(__dirname, '../../.github/workflows/build.yml'), 'utf-8');
  expect(yml).not.toMatch(/build-linux/);
  expect(yml).not.toMatch(/runs-on:\s*ubuntu.*dist/i);
});

test('build.yml has build-windows job', () => {
  const yml = fs.readFileSync(path.join(__dirname, '../../.github/workflows/build.yml'), 'utf-8');
  expect(yml).toMatch(/build-windows/);
});
