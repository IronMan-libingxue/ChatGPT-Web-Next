#!/bin/zsh
set -euo pipefail

identity_name="ChatGPT Web Next Local Signing"
login_keychain=$(security login-keychain | sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//')

if security find-identity -v -p codesigning "$login_keychain" | grep -Fq "$identity_name"; then
  echo "Local signing identity is already available: $identity_name"
  exit 0
fi

certificate_dir=$(mktemp -d /tmp/chatgpt-web-next-signing.XXXXXX)
cleanup() {
  rm -rf "$certificate_dir"
}
trap cleanup EXIT

certificate_path="$certificate_dir/certificate.pem"
private_key_path="$certificate_dir/private-key.pem"
bundle_path="$certificate_dir/identity.p12"
bundle_password=$(openssl rand -hex 32)

openssl req \
  -x509 \
  -newkey rsa:3072 \
  -sha256 \
  -days 3650 \
  -nodes \
  -subj "/CN=$identity_name/O=Local Development/OU=ChatGPT Web Next" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" \
  -keyout "$private_key_path" \
  -out "$certificate_path" \
  >/dev/null 2>&1

openssl pkcs12 \
  -export \
  -legacy \
  -inkey "$private_key_path" \
  -in "$certificate_path" \
  -out "$bundle_path" \
  -passout "pass:$bundle_password" \
  >/dev/null 2>&1

security import "$bundle_path" \
  -k "$login_keychain" \
  -P "$bundle_password" \
  -T /usr/bin/codesign \
  >/dev/null

security add-trusted-cert \
  -r trustRoot \
  -p codeSign \
  -k "$login_keychain" \
  "$certificate_path" \
  >/dev/null

if ! security find-identity -v -p codesigning "$login_keychain" | grep -Fq "$identity_name"; then
  echo "The certificate was imported but is not a valid code-signing identity." >&2
  exit 1
fi

echo "Created local signing identity: $identity_name"
echo "The private key remains only in the macOS login keychain."
