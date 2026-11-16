# Publicly shared code-signing private key installed as a Windows trust root

Investigated: 2026-11-16. Status: certificate/key properties and documented installation confirmed; Windows Authenticode acceptance still needs an end-to-end test.

## Summary for maintainers

The bundled `ssl/cert-zwift-com.pem` includes a publicly available private key and a self-signed certificate permitting both TLS server authentication and code signing. Windows setup instructs users to import `ssl/cert-zwift-com.p12` into the machine's Trusted Root Certification Authorities store. This creates a potential software-publisher impersonation risk beyond the intended offline TLS use: anyone can obtain the signing key, and signatures made with it may validate as trusted on configured machines.

This is a concern about local code-signing trust, not evidence that zwift-offline contains malware. Certificate installation alone does not execute an attacker's program. Acceptance by Authenticode does not imply bypassing antivirus, SmartScreen, UAC consent, enterprise application controls, or kernel-driver signing requirements.

## Evidence

Both the [original repository's Windows instructions](https://github.com/zoffline/zwift-offline#step-2-configure-zwift-client-to-use-zoffline) and the [maintained fork's instructions](https://github.com/fatsbrown/zwift-offline#step-2-configure-zwift-client-to-use-zoffline) prescribe running this as administrator:

```cmd
certutil.exe -importpfx Root cert-zwift-com.p12
```

The [original PEM bundle](https://github.com/zoffline/zwift-offline/blob/master/ssl/cert-zwift-com.pem) and [fork's PEM bundle](https://github.com/fatsbrown/zwift-offline/blob/master/ssl/cert-zwift-com.pem) contain both a private-key block and a certificate block. Signing requires the **private key**, not just the public key.

OpenSSL inspection of this workspace's inherited certificate found:

```text
Subject / Issuer: C=US, ST=CA, L=Long Beach, O=Zwift,
                  CN=*.zwift.com, emailAddress=webmaster@zwift.com
Validity: 2022-01-12 to 2032-01-10
Basic Constraints: CA:FALSE
Key Usage: Digital Signature, Non Repudiation, Key Encipherment
Extended Key Usage: TLS Web Server Authentication, Code Signing
Subject Alternative Name: DNS:*.zwift.com
SHA-256: 55:77:AE:94:D4:ED:11:DA:48:85:50:88:5B:11:93:62:
         10:B5:7F:28:25:09:D8:26:2F:F2:E5:42:AA:6E:88:2E
SHA-1 thumbprint: 9FF8BF63AAB8B21B6A45BAEC612A6DB6531CDE88
```

The workspace's separate private key matches the certificate's public key. Its passwordless P12 contains the same certificate. Upstream PEM contents were inspected through the linked sources; no immutable upstream revision was captured, so attach the tested commit SHA when completing the Windows test.

## Interpretation and limits

`CA:FALSE` concerns certificate issuance; it does not prevent this certificate from being the signer of a program. Microsoft explicitly documents [self-signed code-signing certificates with non-CA basic constraints](https://learn.microsoft.com/en-us/windows/msix/package/create-certificate-package-signing). The wildcard DNS identity also does not restrict code signatures to software associated with that domain.

Do not claim that `CA:FALSE` guarantees impersonation is limited to `*.zwift.com` after root installation. A DNS SAN is not a CA name constraint, and trust anchors are treated specially. [RFC 5280 sections 6.1 and 6.2](https://www.rfc-editor.org/rfc/rfc5280.html#section-6.2) distinguish trust anchors from certificates in the validated path and leave processing of additional anchor constraints to implementations. This investigation has not demonstrated issuance of accepted certificates for unrelated sites on Windows.

The documented trust model makes Authenticode acceptance a credible concern, but the exact certificate has not been tested with Windows `WinVerifyTrust`/SignTool here. Avoid claiming confirmed warning suppression or automatic malware execution. Microsoft describes [SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) as a separate decision that can still warn for signed software. PowerShell can also require a separate publisher-trust decision.

## Windows confirmation procedure (not yet executed)

Use a disposable Windows VM with the Windows SDK SignTool and a harmless, unsigned executable you built yourself, named `hello.exe`. No execution of the executable is necessary. Record the upstream commit, Windows build, SignTool output/exit codes, and certificate fingerprint.

1. Before installing the certificate, sign the harmless executable using the repository P12, then verify it using Authenticode policy:

   ```cmd
   signtool sign /f ssl\cert-zwift-com.p12 /fd SHA256 hello.exe
   signtool verify /pa /v hello.exe
   ```

   Supply a blank P12 password if requested. Expected baseline: signing succeeds, but verification fails because the self-signed root is not trusted.

2. Perform the documented elevated `certutil.exe -importpfx Root ssl\cert-zwift-com.p12` installation. Verify the **same** signed executable again:

   ```cmd
   signtool verify /pa /v hello.exe
   ```

   Expected result to confirm: successful verification after installation. This is a hypothesis until recorded on Windows. Do not add it to Trusted Publishers or another store to make the test pass; that would change the reported setup.

3. Remove the installed certificate from the VM's machine Root store and repeat verification. It should fail again. Discard the VM to remove imported private-key material as well.

Microsoft documents the [`/pa` verification policy](https://learn.microsoft.com/en-us/windows/win32/seccrypto/using-signtool-to-verify-a-file-signature); SignTool's default verification policy is for drivers and would test a different claim.

## Recommended remediation

Generate a fresh private key per installation, retain it only on the server, and use an explicit `serverAuth`-only EKU for TLS certificates. Clients should receive only the public certificate. Prefer application-scoped trust where compatible; verify any unavoidable OS trust configuration on supported clients.

A replacement certificate with a fresh key and only `serverAuth` would remove the existing certificate's direct code-signing permission on validators enforcing EKU. A shared private key would still permit TLS impersonation, so this is a partial mitigation. Do not merely remove the code-signing EKU from the existing certificate while reusing its publicly available private key; rotate the key too. Omitting the entire EKU extension is also not equivalent to restricting it to TLS.

Provide migration instructions that remove the old certificate from machine and user trust stores wherever installed, and replace the old certificate in Zwift's custom trust bundle. Issuing a new certificate or updating server files alone does not remove users' existing trust in the old signing key.
