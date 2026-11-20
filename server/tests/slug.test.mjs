import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildOutputNames, resolveSafeTailoredDir, slugifySegment } from '../slug.mjs';

test('slugifySegment sanitizes punctuation, accents, and corporate suffixes', () => {
  assert.equal(slugifySegment('Stripe, Inc.', { stripCorpSuffix: true }), 'stripe');
  assert.equal(slugifySegment('C++ & Go Backend Engineer (New Grad)'), 'c-plus-plus-and-go-backend-engineer-new-grad');
  assert.equal(slugifySegment('Café Robotics Ltd.', { stripCorpSuffix: true }), 'cafe-robotics');
  assert.equal(slugifySegment('', { fallback: 'company' }), 'company');
});

test('buildOutputNames formats resume-{companyname}-{jobtitle}.pdf cleanly', () => {
  const names = buildOutputNames('Acme Systems, Inc.', 'Software Developer Intern (Infra)');
  assert.equal(names.companySlug, 'acme-systems');
  assert.equal(names.jobTitleSlug, 'software-developer-intern-infra');
  assert.equal(names.folderSlug, 'acme-systems-software-developer-intern-infra');
  assert.equal(names.pdfFilename, 'resume-acme-systems-software-developer-intern-infra.pdf');

  const noisy = buildOutputNames('TuxCare', 'Graduate Engineer - Remote Work (Canada)');
  assert.equal(noisy.companySlug, 'tuxcare');
  assert.equal(noisy.jobTitleSlug, 'graduate-engineer');
  assert.equal(noisy.pdfFilename, 'resume-tuxcare-graduate-engineer.pdf');
});

test('resolveSafeTailoredDir blocks traversal and invalid slugs', () => {
  const root = '/tmp/fake-resume-repo';
  const { targetDir } = resolveSafeTailoredDir(root, 'stripe-backend-swe');
  assert.equal(targetDir, path.resolve(root, 'tailored', 'stripe-backend-swe'));

  assert.throws(() => resolveSafeTailoredDir(root, '../etc/passwd'), /Unsafe folder slug/);
  assert.throws(() => resolveSafeTailoredDir(root, 'foo/bar'), /Unsafe folder slug/);
  assert.throws(() => resolveSafeTailoredDir(root, ''), /Unsafe folder slug/);
});
