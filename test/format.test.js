const {test} = require('node:test');
const assert = require('node:assert/strict');
const {lib} = require('./setup');

const format = lib('core/format');

test('formatSize, decimal and binary', () => {
    format.setDefaultMetric(false);
    assert.equal(format.formatSize(0), '0 B');
    assert.equal(format.formatSize(999), '999 B');
    assert.equal(format.formatSize(1000), '1 KB');
    assert.equal(format.formatSize(1500000), '1.5 MB');
    assert.equal(format.formatSize(-1), '');
    assert.equal(format.formatSize(null), '');

    format.setDefaultMetric(true);
    assert.equal(format.formatSize(1024), '1 KiB');
    assert.equal(format.formatSize(1024 * 1024 * 3), '3.0 MiB');
    format.setDefaultMetric(false);
});

test('formatDate', () => {
    const millis = new Date(2024, 0, 2, 3, 4, 5).getTime();
    assert.equal(format.formatDate(millis, 'YYYY-MM-DD HH:mm:ss'), '2024-01-02 03:04:05');
    assert.equal(format.formatDate(millis, 'D.M.YY'), '2.1.24');
    assert.equal(format.formatDate(0), '');
    assert.equal(format.formatDate('x'), '');
});

test('formatDuration is time zone independent', () => {
    assert.equal(format.formatDuration(0), '0:00');
    assert.equal(format.formatDuration(65), '1:05');
    assert.equal(format.formatDuration(3600 + 2 * 60 + 3), '1:02:03');
    assert.equal(format.formatDuration(NaN), '');
    assert.equal(format.formatDuration(Infinity), '');
});
