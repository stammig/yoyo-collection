// CSV export/import hardening (1B.8–1B.10). The Apple apps read this export
// too (CSVImporter.swift matches rows on the "uuid" column and keeps values
// exactly as written), so the format changes here are kept compatible with it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'csv-parse/sync';
import { startServer, json, csvForm } from './helpers.js';

const addYoyo = async (s, body) => {
  const r = await s.api('/api/yoyos', json(body));
  assert.equal(r.status, 201);
  return r.json();
};
const exportRows = async (s) => parse(await (await s.api('/api/export.csv')).text(), { columns: true, bom: true });
const list = async (s) => (await s.api('/api/yoyos')).json();

describe('CSV export', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());
  test('has a uuid column the Apple apps can match on', async () => {
    const y = await addYoyo(s, { brand: 'Uuidco', model: 'One', color: 'Red' });
    const row = (await exportRows(s)).find((r) => r.Model === 'One');
    assert.equal(row.uuid, y.uuid);
  });
  test('formula-looking cells are neutralised; plain numbers and text are not', async () => {
    await addYoyo(s, { brand: '=HYPERLINK("http://x")', model: 'Formula', color: '@SUM(A1)', description: '- small ding', edition: '-5' });
    const row = (await exportRows(s)).find((r) => r.Model === 'Formula');
    assert.equal(row.Brand, `'=HYPERLINK("http://x")`);
    assert.equal(row.Color, `'@SUM(A1)`);
    assert.equal(row.Edition, '-5');
  });
  test('an escaped export imports back unchanged', async () => {
    const r = await s.api('/api/import', csvForm(await (await s.api('/api/export.csv')).text()));
    assert.equal(r.status, 200);
    const y = (await list(s)).find((x) => x.model === 'Formula');
    assert.equal(y.brand, '=HYPERLINK("http://x")');
    assert.equal(y.color, '@SUM(A1)');
  });
});

describe('CSV import matching', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());
  test('the uuid wins over a stale id', async () => {
    const a = await addYoyo(s, { brand: 'Match', model: 'A', color: 'Red' });
    const b = await addYoyo(s, { brand: 'Match', model: 'B', color: 'Red' });
    // Row claims b's id but carries a's uuid: a is updated, b untouched.
    await s.api('/api/import', csvForm(`Brand,Model,Color,id,uuid\nMatch,A,Blue,${b.id},${a.uuid.toUpperCase()}\n`));
    const all = await list(s);
    assert.equal(all.find((y) => y.id === a.id).color, 'Blue');
    assert.equal(all.find((y) => y.id === b.id).color, 'Red');
  });
  test('an id is only trusted when brand and model agree', async () => {
    const c = await addYoyo(s, { brand: 'Match', model: 'C', color: 'Red' });
    const r = await (await s.api('/api/import', csvForm(`Brand,Model,Color,id\nOther,Thing,Green,${c.id}\n`))).json();
    assert.equal(r.created, 1);
    assert.equal((await list(s)).find((y) => y.id === c.id).brand, 'Match');
  });
  test('two rows cannot claim the same yoyo', async () => {
    const d = await addYoyo(s, { brand: 'Match', model: 'D', color: 'Red' });
    const r = await (await s.api('/api/import', csvForm(`Brand,Model,Color,id\nMatch,D,Red,${d.id}\nMatch,D,Red,${d.id}\n`))).json();
    assert.deepEqual([r.updated, r.created], [1, 1]);
  });
  test('a new row keeps its unused uuid', async () => {
    const u = '12345678-1234-4234-8234-1234567890AB';
    await s.api('/api/import', csvForm(`Brand,Model,Color,uuid\nKept,Uuid,Red,${u}\n`));
    assert.equal((await list(s)).find((y) => y.model === 'Uuid').uuid, u);
  });
});

describe('CSV values', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.stop());
  test('No / 0 / false are no; Yes is yes', async () => {
    await s.api('/api/import', csvForm('Brand,Model,Color,In Hand,Favorite\nBool,No,Red,No,0\nBool,Yes,Red,Yes,yes\nBool,False,Red,false,false\n'));
    const all = await list(s);
    assert.equal(all.find((y) => y.model === 'No').in_hand, 0);
    assert.equal(all.find((y) => y.model === 'No').favorite, 0);
    assert.equal(all.find((y) => y.model === 'False').in_hand, 0);
    assert.equal(all.find((y) => y.model === 'Yes').in_hand, 1);
    assert.equal(all.find((y) => y.model === 'Yes').favorite, 1);
  });
  test('numbers: one value with a unit or currency, nothing guessed', async () => {
    await s.api('/api/import', csvForm('Brand,Model,Color,Paid,Weight\nNum,Ok,Red,"$1,234.50",67.5g\nNum,Bad,Red,1.2.3,5.5g (2)\n'));
    const all = await list(s);
    const ok = all.find((y) => y.model === 'Ok'), bad = all.find((y) => y.model === 'Bad');
    assert.equal(ok.paid, 1234.5);
    assert.equal(ok.weight_g, 67.5);
    assert.equal(bad.paid, null);
    assert.equal(bad.weight_g, null);
  });
  test('an empty cell clears a custom field', async () => {
    const f = await s.api('/api/fields', json({ label: 'String type', type: 'text' }));
    assert.ok(f.status < 300);
    await s.api('/api/import', csvForm('Brand,Model,Color,String type\nCustom,Clear,Red,Kitty\n'));
    assert.equal(Object.values((await list(s)).find((y) => y.model === 'Clear').custom)[0], 'Kitty');
    await s.api('/api/import', csvForm('Brand,Model,Color,String type\nCustom,Clear,Red,\n'));
    assert.deepEqual((await list(s)).find((y) => y.model === 'Clear').custom, {});
  });
});
