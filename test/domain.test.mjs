import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspect, csvRows } from '../src/reader.mjs';
const primary=await readFile(new URL('../fixtures/primary.bin',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../fixtures/upstream.json',import.meta.url),'utf8'));
async function resource(path) {
  const item=manifest.resources[path];
  return item.file ? readFile(new URL(`../fixtures/${item.file}`,import.meta.url)) : Buffer.from(item.body);
}

test('引用列中的空字符串未被单表读取器推断为空对象',()=>{
  const result=inspect(primary);assert.equal(result.rows[1][1],'');assert.equal(result.rows[0][2],'CN');
});
test('引号内换行和重复值保留',()=>{
  assert.deepEqual(csvRows('a,b\r\n"x\ny","q""r"\r\n'),[['a','b'],['x\ny','q"r']]);
  assert.throws(()=>csvRows('"unclosed'));
  assert.throws(()=>inspect(Buffer.from('a,b\n1\n')));
});
test('本地表组真实包含复合循环引用',async()=>{
  const metadata=JSON.parse(await resource('/metadata'));
  assert.equal(metadata.tables[1].tableSchema.primaryKey.length,2);
  assert.equal(metadata.tables[2].tableSchema.foreignKeys[0].reference.resource,'campuses.csv');
});
