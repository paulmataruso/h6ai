const {test} = require('node:test');
const assert = require('node:assert/strict');
const {lib} = require('./setup');

const {parsePattern, naturalCmp, debounce} = lib('util');

test('parsePattern', () => {
    [
        ['', false, ''],
        [' ', false, '\\ '],
        ['a', false, 'a'],
        ['ä', false, 'ä'],
        ['*', false, '\\*'],
        ['re:a', false, 're:a'],
        ['a b', false, 'a\\ b'],
        ['', true, ''],
        [' ', true, ''],
        ['ab', true, 'a.*?b'],
        [' re:', true, 'r.*?e.*?:'],
        ['re:', true, ''],
        ['re:a', true, 'a'],
        ['a b', true, 'a|b'],
        ['ab c', true, 'a.*?b|c'],
        [' a ', true, 'a']
    ].forEach(([pattern, advanced, exp]) => {
        assert.equal(parsePattern(pattern, advanced), exp, `${JSON.stringify(pattern)} ${advanced}`);
    });
});

test('naturalCmp', () => {
    const sorted = ['file10.txt', 'file2.txt', 'file1.txt', 'File3.txt'].sort(naturalCmp);
    assert.deepEqual(sorted, ['File3.txt', 'file1.txt', 'file2.txt', 'file10.txt']);
    assert.equal(naturalCmp('a', 'a'), 0);
    assert.equal(naturalCmp('2', '10'), -1);
});

test('debounce', async () => {
    let calls = 0;
    const fn = debounce(() => {
        calls += 1;
    }, 10);
    fn();
    fn();
    fn();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls, 1);
});
