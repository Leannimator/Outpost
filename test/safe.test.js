'use strict';
// Run with: npm test
// Checks the three slow-pattern fixes (review items 1, 2, 3) without starting the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanEmail, validEmail, cleanReviewBody, looksLikeSvg } = require('../safe');

const ms = (fn) => { const t = process.hrtime.bigint(); const out = fn(); return { out, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
const FAST = 100; // every hostile input below used to take seconds; it must now take well under this

test('email: huge hostile input is rejected instantly (item 1)', () => {
  for (const n of [20000, 100000, 1000000]) {
    const r = ms(() => validEmail(cleanEmail('a@' + '.'.repeat(n) + '@')));
    assert.equal(r.out, false);
    assert.ok(r.ms < FAST, `n=${n} took ${r.ms}ms`);
  }
});

test('email: normal addresses still work', () => {
  assert.equal(validEmail(cleanEmail('  Jane.Doe+shop@Example.COM ')), true);
  assert.equal(cleanEmail('  Jane@Example.COM '), 'jane@example.com');
  assert.equal(validEmail('no-at-sign'), false);
  assert.equal(validEmail('a@b'), false);
  assert.equal(validEmail('a b@c.com'), false);
  assert.equal(validEmail(''), false);
  assert.equal(validEmail('x'.repeat(121) + '@a.co'), false);
  assert.equal(validEmail('x'.repeat(100) + '@a.co'), true);
  assert.equal(cleanEmail(undefined), '');
  assert.equal(cleanEmail(null), '');
  assert.equal(cleanEmail({}), '[object object]');
});

test('review: huge run of spaces is cleaned instantly (item 2)', () => {
  for (const n of [20000, 95000, 1000000]) {
    const r = ms(() => cleanReviewBody('a' + ' '.repeat(n) + 'x'));
    assert.ok(r.ms < FAST, `n=${n} took ${r.ms}ms`);
    assert.ok(r.out.length <= 1000);
  }
});

test('review: normal text keeps its behaviour', () => {
  assert.equal(cleanReviewBody('  Lovely print!  \n\nThanks   \nBye  '), 'Lovely print!\nThanks\nBye');
  assert.equal(cleanReviewBody(undefined), '');
  assert.equal(cleanReviewBody('x'.repeat(5000)).length, 1000);
  assert.equal(cleanReviewBody('Great\nwork'), 'Great\nwork');
});

test('svg sniff: hostile comment pile is rejected instantly (item 3)', () => {
  for (const n of [25, 30, 85, 5000]) {
    const head = '<!---->'.repeat(n).slice(0, 600);
    const r = ms(() => looksLikeSvg(head));
    assert.equal(r.out, false);
    assert.ok(r.ms < FAST, `n=${n} took ${r.ms}ms`);
  }
});

test('svg sniff: real SVGs are still recognised', () => {
  assert.equal(looksLikeSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), true);
  assert.equal(looksLikeSvg('<svg>'), true);
  assert.equal(looksLikeSvg('<SVG\n width="1">'), true);
  assert.equal(looksLikeSvg('<?xml version="1.0" encoding="UTF-8"?>\n<svg width="1"></svg>'), true);
  assert.equal(looksLikeSvg('<?xml version="1.0"?><!-- made by hand --><svg></svg>'), true);
  assert.equal(looksLikeSvg('<!-- a --><!-- b -->\n<svg></svg>'), true);
  assert.equal(looksLikeSvg('<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg></svg>'), true);
  assert.equal(looksLikeSvg('<!---->'.repeat(40) + '<svg></svg>'), true);
});

test('svg sniff: things that are not SVGs are refused', () => {
  assert.equal(looksLikeSvg('<html><svg></svg></html>'), false);
  assert.equal(looksLikeSvg('<script>alert(1)</script>'), false);
  assert.equal(looksLikeSvg('<svgfoo>'), false);
  assert.equal(looksLikeSvg('<svg'), false);
  assert.equal(looksLikeSvg('<!-- never closed <svg>'), false);
  assert.equal(looksLikeSvg('<?xml never closed <svg>'), false);
  assert.equal(looksLikeSvg('plain text'), false);
  assert.equal(looksLikeSvg(''), false);
});
