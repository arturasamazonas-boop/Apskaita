// Prekių rodikliai: user-defined product attributes (e.g. "Diametras", mm) with values on the product card.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {startTestApp} from './helpers.mjs';

let t, acc, ro;
before(async () => {
  t = await startTestApp();
  acc = await t.client('accountant').login();
  ro = await t.client('readonly').login();
});
after(async () => { await t?.close(); });

test('product attributes: define, fill on products, list/search, validation, rename, delete only when unused', async () => {
  const d = await acc.post('/api/product-attributes', {name: 'Diametras', kind: 'number', unit: 'mm'});
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal((await acc.post('/api/product-attributes', {name: ' diametras '})).status, 409, 'names are unique, case-insensitive');
  assert.equal((await acc.post('/api/product-attributes', {name: ''})).status, 400);
  assert.equal((await acc.post('/api/product-attributes', {name: 'Spalva', kind: 'choice'})).status, 400, 'choice needs options');
  const color = (await acc.post('/api/product-attributes', {name: 'Spalva', kind: 'choice', options: 'Balta\nJuoda\n\nBalta'})).body;
  assert.deepEqual(color.options, ['Balta', 'Juoda']);
  assert.equal((await ro.post('/api/product-attributes', {name: 'Ilgis'})).status, 403);

  const p = await acc.post('/api/products', {sku: 'VAMZ-20', name: 'Vamzdis PE', attributes: {[d.body.id]: '20,5', [color.id]: 'Juoda'}});
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(p.body.attributes, {[d.body.id]: '20.5', [color.id]: 'Juoda'});
  assert.equal((await acc.post('/api/products', {name: 'Blogas', attributes: {[d.body.id]: 'dvidešimt'}})).status, 400, 'number attribute');
  assert.equal((await acc.post('/api/products', {name: 'Blogas', attributes: {[color.id]: 'Raudona'}})).status, 400, 'value outside the options');
  assert.equal((await acc.post('/api/products', {name: 'Blogas', attributes: {999999: 'x'}})).status, 400, 'unknown attribute');

  // Partial update: only the sent attributes change; an empty value removes it.
  const u = await acc.put(`/api/products/${p.body.id}`, {attributes: {[color.id]: ''}});
  assert.deepEqual(u.body.attributes, {[d.body.id]: '20.5'});
  assert.deepEqual((await acc.put(`/api/products/${p.body.id}`, {name: 'Vamzdis PE 20'})).body.attributes, {[d.body.id]: '20.5'}, 'other edits keep the values');

  const list = (await acc.get('/api/products?q=20.5')).body.items;
  assert.deepEqual(list.map((x) => x.sku), ['VAMZ-20'], 'search by attribute value');
  assert.equal((await acc.get(`/api/products/${p.body.id}`)).body.attributes[d.body.id], '20.5');

  const defs = (await acc.get('/api/product-attributes')).body;
  assert.deepEqual(defs.map((a) => [a.name, a.used]), [['Diametras', 1], ['Spalva', 0]]);
  // Renaming keeps the values; a type change that would invalidate them is refused.
  assert.equal((await acc.put(`/api/product-attributes/${d.body.id}`, {name: 'Skersmuo'})).body.name, 'Skersmuo');
  assert.equal((await acc.put(`/api/product-attributes/${d.body.id}`, {kind: 'choice', options: 'Mažas'})).status, 409);
  assert.equal((await acc.del(`/api/product-attributes/${d.body.id}`)).status, 409, 'used attribute cannot be deleted');
  assert.equal((await acc.put(`/api/product-attributes/${d.body.id}`, {active: false})).body.active, false);
  assert.deepEqual((await acc.get('/api/product-attributes')).body.map((a) => a.name), ['Spalva'], 'inactive hidden by default');
  assert.equal((await acc.get('/api/product-attributes?all=true')).body.length, 2);
  assert.equal((await acc.del(`/api/product-attributes/${color.id}`)).status, 200);
});
