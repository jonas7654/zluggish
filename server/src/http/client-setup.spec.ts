import { packageRoot } from '#src/config/load';
import { legacyCertificate, linuxSetupScript, setupFileName, windowsSetupScript } from '#src/http/client-setup';
import { CertificateRepository } from '#src/repositories/certificate.repository';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

const crypto = new CryptoRepository();
const material = await new CertificateRepository().create({ serverId: '0123456789ab', years: 5, now: new Date() });
const facts = crypto.certificateFacts(material.cert);

const certificate = {
  ...facts,
  notBefore: facts.notBefore.toISOString(),
  notAfter: facts.notAfter.toISOString(),
};

const script = { pem: material.cert, certificate, address: '192.168.1.20', version: '1.2.3', now: new Date() };
const legacyPem = readFileSync(resolve(packageRoot(), '../assets/ssl/cert-zwift-com.pem'), 'utf8').replaceAll('\r', '');

await test('the legacy constants describe the bundled shared certificate', () => {
  const legacy = crypto.certificateFacts(legacyPem);
  assert.equal(legacy.thumbprint, legacyCertificate.thumbprint);
  assert.ok(legacyPem.includes(`-----BEGIN CERTIFICATE-----\n${legacyCertificate.body}\n`));
});

await test('the Windows script is plain ASCII with CRLF line ends and names the certificate it installs', () => {
  const text = windowsSetupScript(script);

  assert.match(text, /^<# : /);
  assert.ok(/^[ -~\r\n]*$/.test(text), 'ASCII only');
  assert.equal(text.split('\n').length, text.split('\r\n').length);
  assert.ok(text.includes(`$Thumbprint = '${facts.thumbprint}'`));
  assert.ok(text.includes("$ServerUnit = 'Zluggish server 0123456789ab'"));
  assert.ok(text.includes("$ServerAddress = '192.168.1.20'"));
  assert.ok(text.includes(material.cert.trim().replaceAll('\n', '\r\n')));
  assert.equal(setupFileName(certificate, 'bat'), `zluggish-zwift-${facts.thumbprint.slice(0, 8).toLowerCase()}.bat`);
  // Without an address the hosts file is left alone.
  assert.ok(!windowsSetupScript({ ...script, address: '' }).includes('3. Points the Zwift host names'));
});

await test(
  'the Linux script trusts the certificate in Zwift and removes the shared one, idempotently',
  { skip: process.platform === 'win32' },
  (t) => {
    const root = mkdtempSync(resolve(tmpdir(), 'zluggish-setup-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = resolve(root, 'setup.sh');
    writeFileSync(file, linuxSetupScript({ ...script, address: '' }));
    execFileSync('/bin/sh', ['-n', file]);

    // Run as "root" with no trust store tools on the PATH, so only the Zwift folder changes.
    const bin = resolve(root, 'bin');
    mkdirSync(bin);
    writeFileSync(resolve(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });

    for (const tool of ['awk', 'cat', 'cp', 'cut', 'getent', 'mktemp', 'openssl', 'rm', 'sed', 'sort', 'tr']) {
      const path = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();

      if (path) symlinkSync(path, resolve(bin, tool));
    }

    const zwift = resolve(root, 'Zwift');
    mkdirSync(resolve(zwift, 'data'), { recursive: true });
    const bundle = resolve(zwift, 'data', 'cacert.pem');
    const other = '-----BEGIN CERTIFICATE-----\nOTHERCA\n-----END CERTIFICATE-----\n';
    // The old setup appended the shared certificate with its private key.
    writeFileSync(bundle, `${other}\n${legacyPem.replaceAll('\n', '\r\n')}`);

    const run = () => execFileSync('/bin/sh', [file, zwift], { env: { PATH: bin, HOME: root }, encoding: 'utf8' });

    assert.match(run(), /Updated .*cacert\.pem/);
    const once = readFileSync(bundle, 'utf8');
    run();
    const twice = readFileSync(bundle, 'utf8');

    assert.equal(twice, once);
    assert.ok(twice.startsWith(other));
    assert.ok(!twice.includes('PRIVATE KEY'));
    assert.ok(!twice.includes(legacyCertificate.body));
    assert.equal(twice.split(material.cert.trim()).length, 2);
    assert.ok(twice.includes(`# BEGIN Zluggish server certificate ${facts.thumbprint}`));
    assert.ok(existsSync(`${bundle}.zluggish-backup`));
  },
);
