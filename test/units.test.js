import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { ZipArchive } from 'archiver';
import { normalizeDay } from '../dates.js';
import { listEntries, extractEntry } from '../unzip.js';

test('normalizeDay', () => {
  const cases = {
    '6/15/2026': '2026-06-15', '15/6/2026': '2026-06-15', '1/2/2026': '2026-01-02', '6/15/26': '2026-06-15',
    '2026-6-5': '2026-06-05', '2026-09-01': '2026-09-01',
    '2026-02-30': '2026-02-30', '13/13/2026': '13/13/2026', 'Spring 2024': 'Spring 2024', '': '',
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(normalizeDay(input), want, input);
});

test('unzip.js round-trips stored and deflated entries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoyo-zip-'));
  const zipPath = path.join(dir, 't.zip');
  const big = Buffer.alloc(300_000, 7);
  await new Promise((resolve, reject) => {
    const out = createWriteStream(zipPath); out.on('close', resolve);
    const a = new ZipArchive(); a.on('error', reject); a.pipe(out);
    a.append('hello', { name: 'yoyos.db', store: true });
    a.append(big, { name: 'uploads/a.jpg' });
    a.finalize();
  });
  const entries = listEntries(zipPath);
  assert.deepEqual(entries.map((e) => e.name).sort(), ['uploads/a.jpg', 'yoyos.db']);
  for (const e of entries) {
    const dest = path.join(dir, path.basename(e.name));
    await extractEntry(zipPath, e, dest);
    assert.deepEqual(fs.readFileSync(dest), e.name === 'yoyos.db' ? Buffer.from('hello') : big);
  }
  assert.throws(() => { fs.writeFileSync(path.join(dir, 'bad.zip'), 'nope'); listEntries(path.join(dir, 'bad.zip')); });
});
